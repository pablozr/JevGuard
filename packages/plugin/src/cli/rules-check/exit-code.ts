import type { RulesCheckResult } from "./types";

/**
 * Maps a rule check to its exit code: 1 when any rule `FAIL`s (even alongside
 * `UNAVAILABLE`), 2 when the check could not complete (`UNAVAILABLE`, unknown rule, or
 * unusable input), and 0 otherwise.
 */
export function rulesCheckExitCode(result: RulesCheckResult): 0 | 1 | 2 {
  if (result.status !== "REVIEWED") {
    return 2;
  }

  const { counts } = result.review.summary;

  if (counts.fail > 0) {
    return 1;
  }

  return counts.unavailable > 0 ? 2 : 0;
}
