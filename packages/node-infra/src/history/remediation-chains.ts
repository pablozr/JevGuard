import { join } from "node:path";
import { resolveJevGuardDataDirectory } from "./data-directory";
import { boundJsonLinesFile } from "./jsonl-file";
import type { ReviewHistoryFileSystem, ReviewHistoryPathContext } from "./types";

const CHAINS_FILENAME = "remediation-chains.jsonl";
const MAX_BYTES = 1024 * 1024;
const MAX_RECORDS = 500;

/**
 * One ended remediation chain, as the allowlist lets it reach disk: ids, counts, hashes and
 * typed codes. It never holds a diff, a task, rule text or a path.
 */
export interface RemediationChainEntry {
  readonly host: "claude-code" | "opencode";
  readonly chainId: string;
  readonly turnIds: readonly string[];
  readonly attempts: number;
  readonly maxAttempts: number;
  readonly signatures: readonly string[];
  readonly originIds: readonly string[];
  readonly resolvedIds: readonly string[];
  readonly remainingIds: readonly string[];
  readonly result: string;
}

export interface RemediationChainLog {
  /** Never rejects: a write failure is contained so a review is never disturbed. */
  record(entry: RemediationChainEntry): Promise<void>;
}

export interface RemediationChainLogDependencies {
  readonly context: ReviewHistoryPathContext;
  readonly fileSystem: ReviewHistoryFileSystem;
  readonly now: () => Date;
}

/** Resolves `jevguard/remediation-chains.jsonl`, next to `reviews.jsonl`. */
export function resolveRemediationChainsFilePath(context: ReviewHistoryPathContext): string {
  return join(resolveJevGuardDataDirectory(context), CHAINS_FILENAME);
}

function project(entry: RemediationChainEntry, at: string): Record<string, unknown> {
  return {
    v: 1,
    at,
    host: entry.host,
    chainId: entry.chainId,
    turnIds: [...entry.turnIds],
    attempts: entry.attempts,
    maxAttempts: entry.maxAttempts,
    signatures: [...entry.signatures],
    originIds: [...entry.originIds],
    resolvedIds: [...entry.resolvedIds],
    remainingIds: [...entry.remainingIds],
    result: entry.result,
  };
}

/** Appends one line per ended chain to the local JSON Lines file; every failure is contained. */
export function createRemediationChainLog(
  dependencies: RemediationChainLogDependencies,
): RemediationChainLog {
  const filePath = resolveRemediationChainsFilePath(dependencies.context);
  let tail: Promise<void> = Promise.resolve();

  async function append(entry: RemediationChainEntry): Promise<void> {
    try {
      const line = JSON.stringify(project(entry, dependencies.now().toISOString()));

      await dependencies.fileSystem.ensureParentDirectory(filePath);
      await dependencies.fileSystem.appendFile(filePath, `${line}\n`);
      await boundJsonLinesFile(dependencies.fileSystem, filePath, MAX_BYTES, MAX_RECORDS);
    } catch {
      return;
    }
  }

  return {
    record(entry) {
      const run = tail.then(() => append(entry));

      tail = run.then(
        () => undefined,
        () => undefined,
      );

      return run;
    },
  };
}
