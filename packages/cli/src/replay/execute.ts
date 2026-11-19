import { executeRulesCheck } from "../rules-check/execute";
import type { DiffRead } from "../rules-check/types";
import type {
  ReplayedCommit,
  ReplayCommitResult,
  ReplayDependencies,
  ReplayRequest,
  ReplayResult,
} from "./types";

const EMPTY_TASK = "No task was provided. Judge the change against the rule on its own.";

/**
 * Replays the rules over the newest commits, newest first. Each commit's own patch is
 * the unit and its subject is the task, so the judgment matches what the plugin would
 * have made at that turn. It writes nothing: no review history, no state, no file, and
 * no diff or task reaches any log.
 */
export async function executeReplay(
  request: ReplayRequest,
  dependencies: ReplayDependencies,
): Promise<ReplayResult> {
  const history = await dependencies.readHistory(request.last);

  if (history.status === "FAILED") {
    return { status: "FAILED", reason: history.reason };
  }

  const commits: ReplayCommitResult[] = [];

  for (const commit of history.commits) {
    commits.push(await replayCommit(commit, request, dependencies));
  }

  return { status: "REPLAYED", commits };
}

async function replayCommit(
  commit: ReplayedCommit,
  request: ReplayRequest,
  dependencies: ReplayDependencies,
): Promise<ReplayCommitResult> {
  if (commit.merge) {
    return { sha: commit.sha, status: "SKIPPED", reason: "MERGE_COMMIT" };
  }

  if (commit.diff.trim() === "") {
    return { sha: commit.sha, status: "SKIPPED", reason: "NO_PATCH" };
  }

  const readDiff = async (): Promise<DiffRead> => ({ status: "READ", text: commit.diff });
  const result = await executeRulesCheck(
    {
      diff: { kind: "FILE", path: "" },
      task: commit.subject === "" ? EMPTY_TASK : commit.subject,
      ruleId: request.ruleId,
    },
    {
      readDiff,
      policy: dependencies.policy,
      parseConfig: dependencies.parseConfig,
      jev: dependencies.jev,
    },
  );

  switch (result.status) {
    case "REVIEWED":
      return { sha: commit.sha, status: "REVIEWED", review: result.review };
    case "INPUT_FAILED":
      return { sha: commit.sha, status: "INPUT_FAILED", reason: result.reason };
    case "RULE_NOT_FOUND":
      return { sha: commit.sha, status: "RULE_NOT_FOUND" };
  }
}
