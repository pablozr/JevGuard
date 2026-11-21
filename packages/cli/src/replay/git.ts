import { spawn } from "node:child_process";
import type { HistoryRead, ReplayedCommit } from "./types";

const GIT_TIMEOUT_MS = 20_000;
const STDOUT_LIMIT = 16 * 1024 * 1024;

/** Field separator for the one-line `git log` format shared by the replay and check readers. */
export const FIELD_SEPARATOR = "\u001f";

export interface GitResult {
  readonly ok: boolean;
  readonly stdout: string;
  /**
   * True when output kept arriving after {@link STDOUT_LIMIT} was reached and the excess
   * was dropped. The text is then a prefix of Git's output, never the whole patch, so a
   * caller that judges it must treat the unit as unread rather than as a complete diff.
   */
  readonly truncated: boolean;
}

/**
 * Runs read-only Git in the working directory. The arguments are constant except for a
 * commit count and a hexadecimal revision, so nothing user-provided reaches a shell.
 * Exported so other read-only Git readers reuse the same timeout and output bound.
 */
export function runGit(args: readonly string[], cwd?: string): Promise<GitResult> {
  return new Promise((resolve) => {
    let settled = false;
    let stdout = "";
    let truncated = false;

    function settle(result: GitResult): void {
      if (settled) return;

      settled = true;
      clearTimeout(timer);
      resolve(result);
    }

    const child = spawn("git", [...args], {
      ...(cwd === undefined ? {} : { cwd }),
      windowsHide: true,
      stdio: ["ignore", "pipe", "pipe"],
    });
    const timer = setTimeout(() => {
      child.kill();
      settle({ ok: false, stdout: "", truncated: false });
    }, GIT_TIMEOUT_MS);

    child.stdout.setEncoding("utf8");
    child.stdout.on("data", (chunk: string) => {
      if (stdout.length >= STDOUT_LIMIT) {
        truncated = true;

        return;
      }

      const room = STDOUT_LIMIT - stdout.length;

      if (chunk.length > room) truncated = true;
      stdout += chunk.slice(0, room);
    });
    child.stderr.resume();
    child.on("error", () => settle({ ok: false, stdout: "", truncated: false }));
    child.on("close", (code) => settle({ ok: code === 0, stdout, truncated }));
  });
}

export interface CommitHead {
  readonly sha: string;
  readonly subject: string;
  readonly merge: boolean;
}

/** Parses the `%H`, `%p`, `%s` lines this module and the check reader ask Git for. */
export function parseCommitHeads(output: string): readonly CommitHead[] {
  return output.split("\n").flatMap((line) => {
    const [sha = "", parents = "", subject = ""] = line.split(FIELD_SEPARATOR);

    if (!/^[0-9a-f]{7,64}$/.test(sha)) return [];

    return [{ sha, subject, merge: parents.trim().split(/\s+/).length > 1 }];
  });
}

/**
 * Reads the newest `last` commits with their own patch, newest first. A merge commit is
 * listed without a patch: its combined diff is not a change a rule can judge, so the
 * caller skips it. It never throws and never stages, rewrites or writes anything.
 */
export function createGitCommitReader(): (last: number) => Promise<HistoryRead> {
  return async (last) => {
    const heads = await runGit([
      "log",
      `-n${last}`,
      `--format=%H${FIELD_SEPARATOR}%p${FIELD_SEPARATOR}%s`,
    ]);

    if (!heads.ok) return { status: "FAILED", reason: "GIT_UNAVAILABLE" };

    const commits: CommitHead[] = [...parseCommitHeads(heads.stdout)];

    if (commits.length === 0) return { status: "FAILED", reason: "NO_COMMITS" };

    const replays: ReplayedCommit[] = [];

    for (const commit of commits) {
      const patch = commit.merge
        ? { ok: true, stdout: "", truncated: false }
        : await runGit(["show", "--no-color", "--no-ext-diff", "--format=", commit.sha]);

      if (!patch.ok) return { status: "FAILED", reason: "GIT_UNAVAILABLE" };

      replays.push({
        sha: commit.sha,
        subject: commit.subject,
        diff: patch.stdout,
        merge: commit.merge,
        ...(patch.truncated ? { diffTruncated: true as const } : {}),
      });
    }

    return { status: "READ", commits: replays };
  };
}
