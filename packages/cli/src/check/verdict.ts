import type { ReviewResult } from "@jevguard/core";
import type { ReplayCommitResult } from "../replay/types";
import type { CheckFailure, CheckIncompleteCommit, CheckVerdict, CheckWarning } from "./types";

/**
 * Reduces the per-commit results to one check verdict. Only a rule with severity
 * `error` that reached `FAIL` fails the check; a `warning` rule that somehow reached
 * `FAIL` stays a warning, because the gate, not the check, decides thresholds.
 * Anything not judged completely — a rule `UNAVAILABLE` or a patch that could not be
 * parsed — becomes `INCOMPLETE`, never a verdict.
 */
export function evaluateCheck(commits: readonly ReplayCommitResult[]): CheckVerdict {
  const failures: CheckFailure[] = [];
  const warnings: CheckWarning[] = [];
  const incomplete: CheckIncompleteCommit[] = [];
  let reviewedCommitCount = 0;
  let skippedCommitCount = 0;
  let ruleNotFound = false;

  for (const commit of commits) {
    switch (commit.status) {
      case "SKIPPED":
        skippedCommitCount += 1;
        break;
      case "RULE_NOT_FOUND":
        ruleNotFound = true;
        break;
      case "INPUT_FAILED":
        incomplete.push({ sha: commit.sha, reason: commit.reason });
        break;
      case "REVIEWED":
        reviewedCommitCount += 1;
        collectResults(commit.sha, commit.review.results, { failures, warnings, incomplete });
        break;
    }
  }

  return {
    verdict: highestVerdict({ failures, warnings, incomplete, ruleNotFound }),
    failures,
    warnings,
    incomplete,
    reviewedCommitCount,
    skippedCommitCount,
  };
}

interface Collected {
  readonly failures: CheckFailure[];
  readonly warnings: CheckWarning[];
  readonly incomplete: CheckIncompleteCommit[];
}

function collectResults(sha: string, results: readonly ReviewResult[], collected: Collected): void {
  for (const result of results) {
    if (result.kind === "REVIEW") {
      if (result.outcome === "UNAVAILABLE") {
        collected.incomplete.push({ sha, reason: result.reason });
      }

      continue;
    }

    if (result.outcome === "UNAVAILABLE") {
      collected.incomplete.push({ sha, reason: result.reason });
      continue;
    }

    if (result.outcome === "PASS" || result.outcome === "SKIPPED") {
      continue;
    }

    const entry = {
      sha,
      ruleId: result.ruleId,
      violationProbability: result.violationProbability,
    };

    if (result.outcome === "FAIL" && result.severity === "error") {
      collected.failures.push(entry);
    } else {
      collected.warnings.push(entry);
    }
  }
}

function highestVerdict(input: {
  readonly failures: readonly CheckFailure[];
  readonly warnings: readonly CheckWarning[];
  readonly incomplete: readonly CheckIncompleteCommit[];
  readonly ruleNotFound: boolean;
}): CheckVerdict["verdict"] {
  if (input.ruleNotFound) return "RULE_NOT_FOUND";
  if (input.failures.length > 0) return "FAIL";
  if (input.incomplete.length > 0) return "INCOMPLETE";
  if (input.warnings.length > 0) return "WARN";

  return "PASS";
}

/**
 * Maps the verdict to its exit code: `2` when the check could not run as asked (an
 * unknown rule), `1` for an error-severity `FAIL` or, with `--strict`, for a commit
 * that could not be judged completely, and `0` otherwise.
 */
export function checkExitCode(verdict: CheckVerdict, strict: boolean): 0 | 1 | 2 {
  switch (verdict.verdict) {
    case "RULE_NOT_FOUND":
      return 2;
    case "FAIL":
      return 1;
    case "INCOMPLETE":
      return strict ? 1 : 0;
    case "PASS":
    case "WARN":
      return 0;
  }
}
