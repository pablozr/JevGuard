import { reviewCommits } from "../replay/execute";
import {
  CHECK_MAX_COMMITS,
  type CheckDependencies,
  type CheckRequest,
  type CheckResult,
} from "./types";

/**
 * Runs the check over one commit range. Each commit's own patch is the unit and its
 * subject is the task, exactly as `replay` judges them, because both go through
 * `reviewCommits`. A range that cannot be read, or that is above the commit cap, never
 * reaches Jev: it is reported as a failure to run, not as a verdict. Nothing is
 * written — no history, no state, no file — and no diff, task or credential reaches
 * any output.
 */
export async function executeCheck(
  request: CheckRequest,
  dependencies: CheckDependencies,
): Promise<CheckResult> {
  const read = await dependencies.readRange(request.range, request.last ?? CHECK_MAX_COMMITS);

  if (read.status !== "READ") {
    return read;
  }

  const commits = await reviewCommits(read.commits, { ruleId: request.ruleId }, dependencies);

  return { status: "CHECKED", commits };
}
