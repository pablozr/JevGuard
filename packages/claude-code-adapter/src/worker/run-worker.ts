import type { TurnReview } from "@jevguard/core";
import { toReviewLogEntry } from "@jevguard/node-infra";
import type { ClaudeReviewHandoff } from "../capture/types";
import { parseHandoff } from "./parse-handoff";
import { prepareProposal } from "./remediation/prepare-proposal";
import type { ClaudeRemediationSettingsResult } from "./remediation/types";
import { reviewHandoff } from "./review-handoff";
import type { WorkerDependencies, WorkerLogCode } from "./types";

export const CLAIM_ABANDONED_AFTER_MS = 60 * 60 * 1000;
export const PARTIAL_HANDOFF_GRACE_MS = 30 * 1000;

const CLAIMED_DIRECTORY = "claimed";
const HANDOFF_SUFFIX = ".json";

interface PendingHandoff {
  readonly name: string;
  readonly closedAtMs: number;
}

function joinPath(directory: string, name: string): string {
  return `${directory}/${name}`;
}

function claimedDirectoryOf(dependencies: WorkerDependencies): string {
  return joinPath(dependencies.handoffDirectory, CLAIMED_DIRECTORY);
}

function claimedAtOf(name: string): number | null {
  const separator = name.indexOf("-");
  const claimedAt = Number(name.slice(0, separator));

  return separator > 0 && Number.isFinite(claimedAt) ? claimedAt : null;
}

function removeOrDefer(path: string, dependencies: WorkerDependencies, leftovers: string[]): void {
  try {
    dependencies.files.remove(path);
  } catch {
    leftovers.push(path);
  }
}

function dropAbandonedClaims(dependencies: WorkerDependencies, leftovers: string[]): void {
  const directory = claimedDirectoryOf(dependencies);
  const nowMs = dependencies.now().getTime();

  for (const name of dependencies.files.list(directory)) {
    if (!name.endsWith(HANDOFF_SUFFIX)) continue;

    const claimedAt = claimedAtOf(name);

    if (claimedAt !== null && nowMs - claimedAt <= CLAIM_ABANDONED_AFTER_MS) continue;

    dependencies.log("WORKER_CLAIM_ABANDONED");
    removeOrDefer(joinPath(directory, name), dependencies, leftovers);
  }
}

function readContained(path: string, dependencies: WorkerDependencies): string | null {
  try {
    return dependencies.files.read(path);
  } catch {
    return null;
  }
}

function isPartialWrite(path: string, dependencies: WorkerDependencies): boolean {
  try {
    const modifiedMs = dependencies.files.modifiedMs(path);

    return (
      modifiedMs !== null && dependencies.now().getTime() - modifiedMs < PARTIAL_HANDOFF_GRACE_MS
    );
  } catch {
    return false;
  }
}

function pendingEntry(name: string, dependencies: WorkerDependencies): PendingHandoff | null {
  const path = joinPath(dependencies.handoffDirectory, name);
  const text = readContained(path, dependencies);

  if (text === null) return { name, closedAtMs: Number.POSITIVE_INFINITY };

  const parsed = parseHandoff(text);

  if (parsed.status === "VALID") return { name, closedAtMs: Date.parse(parsed.handoff.closedAt) };

  return isPartialWrite(path, dependencies) ? null : { name, closedAtMs: 0 };
}

function pendingHandoffs(dependencies: WorkerDependencies): readonly PendingHandoff[] {
  return dependencies.files
    .list(dependencies.handoffDirectory)
    .filter((name) => name.endsWith(HANDOFF_SUFFIX))
    .flatMap((name) => pendingEntry(name, dependencies) ?? [])
    .sort(
      (left, right) => left.closedAtMs - right.closedAtMs || left.name.localeCompare(right.name),
    );
}

function claim(name: string, dependencies: WorkerDependencies): string | null {
  const directory = claimedDirectoryOf(dependencies);
  const target = joinPath(directory, `${dependencies.now().getTime()}-${name}`);

  dependencies.files.ensureDirectory(directory);

  const moved = dependencies.files.rename(joinPath(dependencies.handoffDirectory, name), target);

  if (moved === "FAILED") dependencies.log("WORKER_CLAIM_FAILED");

  return moved === "MOVED" ? target : null;
}

function aggregateOutcome(review: TurnReview): WorkerLogCode {
  const { verdict, hasUnavailable } = review.summary;

  if (verdict !== null) return `REVIEW_RECORDED:${verdict}`;

  return hasUnavailable ? "REVIEW_RECORDED:UNAVAILABLE" : "REVIEW_RECORDED:SKIPPED";
}

function logCauses(handoff: ClaudeReviewHandoff, dependencies: WorkerDependencies): void {
  if (handoff.resolution.status !== "UNAVAILABLE") return;

  for (const cause of handoff.resolution.causes) {
    dependencies.log(`UNIT_UNAVAILABLE:${cause}`);
  }
}

function presentSafely(present: () => void): void {
  try {
    present();
  } catch {}
}

function recordedSafely(
  handoff: ClaudeReviewHandoff,
  review: TurnReview,
  proposal: boolean,
  dependencies: WorkerDependencies,
): boolean {
  try {
    return dependencies.feed.recorded(handoff, review, proposal);
  } catch {
    return false;
  }
}

const REMEDIATION_OFF: ClaudeRemediationSettingsResult = { status: "DISABLED" };

function remediationSettingsOf(
  handoff: ClaudeReviewHandoff,
  dependencies: WorkerDependencies,
): ClaudeRemediationSettingsResult {
  if (handoff.resolution.status !== "TURN") return REMEDIATION_OFF;

  const settings = dependencies.remediationFor(handoff.projectRoot);

  if (settings.status === "INVALID") dependencies.log(`REMEDIATION_${settings.reason}`);

  return settings;
}

async function processClaim(
  path: string,
  dependencies: WorkerDependencies,
  leftovers: string[],
): Promise<void> {
  const text = dependencies.files.read(path);
  const parsed = text === null ? null : parseHandoff(text);

  if (parsed === null || parsed.status === "INVALID") {
    dependencies.log("HANDOFF_INVALID");
    removeOrDefer(path, dependencies, leftovers);

    return;
  }

  const { handoff } = parsed;

  presentSafely(() => dependencies.feed.started(handoff));

  const settings = remediationSettingsOf(handoff, dependencies);
  const reviewed = await reviewHandoff(handoff, dependencies, {
    proposals: settings.status === "ENABLED",
  });
  const { review, deadlineExceeded } = reviewed;

  if (deadlineExceeded) dependencies.log("REVIEW_DEADLINE_EXCEEDED");

  logCauses(handoff, dependencies);
  await dependencies.history.append(toReviewLogEntry(review));

  const proposed = prepareProposal(handoff, reviewed, settings, dependencies);
  const recorded = recordedSafely(handoff, review, proposed, dependencies);

  if (proposed && !recorded) presentSafely(() => dependencies.proposals.remove(handoff));

  dependencies.log(aggregateOutcome(review));
  removeOrDefer(path, dependencies, leftovers);
}

async function drainOnce(dependencies: WorkerDependencies, leftovers: string[]): Promise<boolean> {
  let claimedAny = false;

  for (const { name } of pendingHandoffs(dependencies)) {
    try {
      const path = claim(name, dependencies);

      if (path === null) continue;

      claimedAny = true;
      await processClaim(path, dependencies, leftovers);
    } catch {
      dependencies.log("HANDOFF_PROCESS_FAILED");
    }
  }

  return claimedAny;
}

function retryLeftovers(dependencies: WorkerDependencies, leftovers: readonly string[]): void {
  for (const path of leftovers) {
    try {
      dependencies.files.remove(path);
    } catch {
      dependencies.log("HANDOFF_CLEANUP_FAILED");
    }
  }
}

/**
 * Drains every pending handoff once, oldest unit first. A handoff is claimed by an
 * atomic rename and deleted after it is recorded, so concurrent workers record each
 * unit at most once; a claim that outlives its worker is dropped, never re-reviewed.
 * One handoff's failure is logged as a code and never stops the next; deletions that
 * failed are retried at the end so prompt and patch do not linger. Nothing returns to
 * the Claude session except, when the user enabled remediation, a private proposal
 * request that the in-session mod reads once.
 */
export async function runWorker(dependencies: WorkerDependencies): Promise<void> {
  const leftovers: string[] = [];

  dependencies.log("WORKER_STARTED");

  try {
    dropAbandonedClaims(dependencies, leftovers);
    presentSafely(() => dependencies.feed.sweep());
    presentSafely(() => dependencies.proposals.sweep());

    let claimedAny = true;

    while (claimedAny) {
      claimedAny = await drainOnce(dependencies, leftovers);
    }
  } finally {
    retryLeftovers(dependencies, leftovers);
  }
}
