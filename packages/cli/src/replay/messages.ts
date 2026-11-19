import type { ReviewCounts } from "@jevguard/core";
import { toReviewLogEntry, type ReviewLogResult } from "@jevguard/node-infra";
import type { ReplayCommitResult, ReplayResult } from "./types";

export const REPLAY_USAGE = "Usage: jevguard replay [--last <1-50>] [--rule <id>] [--json]";

export const REPLAY_FAILURE_MESSAGE = "Could not replay the rules over the recent commits.";

const SHA_LENGTH = 7;
const VERDICT_COLUMN_PADDING = 2;
const VERDICT_COLUMN_WIDTH = "INPUT_FAILED".length + VERDICT_COLUMN_PADDING;
const MAX_LISTED_RULES = 4;

/** Serializable JSON form: the safe review shape per commit plus its revision. */
export function serializeReplay(result: ReplayResult): string {
  if (result.status === "FAILED") {
    return JSON.stringify({ version: 1, status: "FAILED", reason: result.reason }, null, 2);
  }

  return JSON.stringify(
    {
      version: 1,
      status: "REPLAYED",
      commits: result.commits.map((commit) =>
        commit.status === "REVIEWED"
          ? { sha: commit.sha, status: "REVIEWED", ...toReviewLogEntry(commit.review) }
          : commit,
      ),
    },
    null,
    2,
  );
}

/**
 * Human-readable replay: a revision, its verdict and its rule outcomes only. It never
 * prints the task, the commit subject, or any diff content, and it says plainly that
 * nothing was written.
 */
export function describeReplay(result: ReplayResult, last: number): readonly string[] {
  if (result.status === "FAILED") {
    return [`JevGuard replay`, failureLine(result.reason)];
  }

  const reviewed = result.commits.flatMap((commit) =>
    commit.status === "REVIEWED" ? [toReviewLogEntry(commit.review).summary] : [],
  );
  const verdicts = result.commits.map(
    (commit) =>
      `${commit.sha.slice(0, SHA_LENGTH)}  ${verdictOf(commit).padEnd(VERDICT_COLUMN_WIDTH)}${detailsOf(commit)}`,
  );

  return [
    `JevGuard replay (newest ${last} commits)`,
    ...verdicts,
    `Summary: ${describeTotals(totalOf(reviewed))}`,
    ...describeRemaining(result.commits),
    "Nothing was written: no review history, no file in the repository, and no diff in a log.",
  ];
}

function verdictOf(commit: ReplayCommitResult): string {
  switch (commit.status) {
    case "REVIEWED":
      return toReviewLogEntry(commit.review).summary.highestVerdict ?? "-";
    case "INPUT_FAILED":
      return "INPUT_FAILED";
    case "RULE_NOT_FOUND":
      return "RULE_NOT_FOUND";
    case "SKIPPED":
      return "SKIPPED";
  }
}

function detailsOf(commit: ReplayCommitResult): string {
  switch (commit.status) {
    case "REVIEWED":
      return describeResults(toReviewLogEntry(commit.review).results);
    case "INPUT_FAILED":
      return commit.reason;
    case "RULE_NOT_FOUND":
      return "no rule in .jev/rules.md matches --rule";
    case "SKIPPED":
      return commit.reason;
  }
}

function describeResults(results: readonly ReviewLogResult[]): string {
  const listed = results
    .slice(0, MAX_LISTED_RULES)
    .map((result) => `${nameOf(result)}:${result.outcome}`);
  const rest = results.length - listed.length;

  return rest > 0 ? `${listed.join(" · ")} · +${rest} more` : listed.join(" · ");
}

function nameOf(result: ReviewLogResult): string {
  switch (result.kind) {
    case "RULE":
      return result.ruleId ?? "<no id>";
    case "BUILT_IN":
      return result.checkId;
    case "REVIEW":
      return "review";
  }
}

function totalOf(reviewed: readonly { readonly counts: ReviewCounts }[]): ReviewCounts {
  return reviewed.reduce<ReviewCounts>(
    (total, summary) => ({
      pass: total.pass + summary.counts.pass,
      warn: total.warn + summary.counts.warn,
      fail: total.fail + summary.counts.fail,
      unavailable: total.unavailable + summary.counts.unavailable,
      skipped: total.skipped + summary.counts.skipped,
    }),
    { pass: 0, warn: 0, fail: 0, unavailable: 0, skipped: 0 },
  );
}

function describeTotals(totals: ReviewCounts): string {
  return `pass ${totals.pass} · warn ${totals.warn} · fail ${totals.fail} · unavailable ${totals.unavailable} · skipped ${totals.skipped}`;
}

function describeRemaining(commits: readonly ReplayCommitResult[]): readonly string[] {
  const skipped = commits.filter((commit) => commit.status === "SKIPPED").length;
  const failed = commits.filter(
    (commit) => commit.status !== "REVIEWED" && commit.status !== "SKIPPED",
  ).length;

  if (skipped === 0 && failed === 0) return [];

  return [
    `${skipped} commit(s) skipped (merge or no patch) and ${failed} could not be replayed; see the lines above.`,
  ];
}

function failureLine(reason: "GIT_UNAVAILABLE" | "NO_COMMITS"): string {
  return reason === "NO_COMMITS"
    ? "There are no commits to replay in this repository."
    : "Could not read the Git history. Check that this is a Git work tree and that git is on PATH.";
}
