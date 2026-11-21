import { FIELD_SEPARATOR, parseCommitHeads, runGit } from "../replay/git";
import type { ReplayedCommit } from "../replay/types";
import type { RangeRead } from "./types";

/**
 * Reads the commits of a validated `base..head` range, newest first, from the work tree
 * at `cwd` (the process directory by default). Merge commits are excluded from the
 * count and never become units: a merge is not a change a rule can judge, so it does
 * not spend the caller's budget. Every Git call is read-only, and the range is passed
 * as one argument, never through a shell.
 */
export function createGitRangeReader(
  cwd: string = process.cwd(),
): (range: string, limit: number) => Promise<RangeRead> {
  return async (range, limit) => {
    const count = await runGit(["rev-list", "--no-merges", "--count", range], cwd);

    if (!count.ok) {
      return {
        status: "FAILED",
        reason: (await gitWorks(cwd)) ? "RANGE_INVALID" : "GIT_UNAVAILABLE",
      };
    }

    const totalCommits = Number(count.stdout.trim());

    if (!Number.isSafeInteger(totalCommits) || totalCommits < 0) {
      return { status: "FAILED", reason: "GIT_UNAVAILABLE" };
    }

    if (totalCommits > limit) {
      return { status: "RANGE_TOO_LARGE", totalCommits, limit };
    }

    const heads = await runGit(
      [
        "log",
        `-n${limit}`,
        "--no-merges",
        `--format=%H${FIELD_SEPARATOR}%p${FIELD_SEPARATOR}%s`,
        range,
      ],
      cwd,
    );

    if (!heads.ok) return { status: "FAILED", reason: "GIT_UNAVAILABLE" };

    const commits: ReplayedCommit[] = [];

    for (const head of parseCommitHeads(heads.stdout)) {
      const patch = await runGit(
        ["show", "--no-color", "--no-ext-diff", "--format=", head.sha],
        cwd,
      );

      if (!patch.ok) return { status: "FAILED", reason: "GIT_UNAVAILABLE" };

      commits.push({ sha: head.sha, subject: head.subject, diff: patch.stdout, merge: false });
    }

    return { status: "READ", commits };
  };
}

/** Tells a broken range apart from Git itself being missing or refusing to run. */
async function gitWorks(cwd: string): Promise<boolean> {
  const probe = await runGit(["rev-parse", "--git-dir"], cwd);

  return probe.ok;
}
