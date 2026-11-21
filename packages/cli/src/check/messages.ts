import { toReviewLogEntry, type ReviewLogResult } from "@jevguard/node-infra";
import { describeTotals, totalCounts } from "../messages";
import type { ReplayCommitResult } from "../replay/types";
import type { CheckFailure, CheckResult, CheckVerdict } from "./types";

export const CHECK_USAGE =
  "Usage: jevguard check --range <base>..<head> [--last <1-50>] [--rule <id>] [--strict] [--json | --annotations]";

export const CHECK_FAILURE_MESSAGE = "Could not run the check.";

export const CHECK_RANGE_INVALID_MESSAGE =
  "Could not read the range. Pass two revisions with one `..`, for example `origin/main..HEAD`.";

export const CHECK_GIT_UNAVAILABLE_MESSAGE =
  "Could not read the Git history. Check that this is a Git work tree and that git is on PATH.";

export const CHECK_RULE_NOT_FOUND_MESSAGE = "No rule in .jev/rules.md matches --rule.";

export const CHECK_STAGED_MESSAGE =
  "`--staged` (pre-commit) is not part of v1: whether it ships as opt-in is an open decision (ADR 0023). Use `--range <base>..<head>`.";

const SHA_LENGTH = 7;
const VERDICT_COLUMN_WIDTH = "INPUT_FAILED".length + 2;
const MAX_LISTED_RESULTS = 4;
const MAX_LISTED_FAILURES = 4;

export function describeRangeTooLarge(totalCommits: number, limit: number): string {
  return `The range has ${totalCommits} commits, above the limit of ${limit}. Narrow the range, or pass --last ${limit} to check only the newest ${limit} commits.`;
}

/**
 * Human-readable check: the range, a line per commit with its outcome and rule
 * outcomes, the totals and the result. It prints IDs, outcomes, commit revisions
 * and typed reasons only — never the task (including the commit subject), any diff
 * content, a severity, a probability or a path.
 */
export function describeCheck(
  result: Extract<CheckResult, { status: "CHECKED" }>,
  verdict: CheckVerdict,
  range: string,
  strict: boolean,
): readonly string[] {
  const reviewed = result.commits.flatMap((commit) =>
    commit.status === "REVIEWED" ? [toReviewLogEntry(commit.review).summary] : [],
  );

  return [
    `JevGuard check (${range})`,
    ...result.commits.map(commitLine),
    `Summary: ${describeTotals(totalCounts(reviewed))} · ${result.commits.length} commit(s)`,
    ...describeNotJudged(verdict),
    `Result: ${resultLine(verdict, strict)}`,
    "Nothing was written: no review history, no file in the repository, and no diff in a log.",
  ];
}

/** Serializable JSON form: the safe log allowlist per commit plus the verdict. */
export function serializeCheck(
  result: Extract<CheckResult, { status: "CHECKED" }>,
  verdict: CheckVerdict,
): string {
  const reviewed = result.commits.flatMap((commit) =>
    commit.status === "REVIEWED" ? [toReviewLogEntry(commit.review).summary] : [],
  );

  return JSON.stringify(
    {
      version: 1,
      status: "CHECKED",
      verdict: verdict.verdict,
      summary: {
        counts: totalCounts(reviewed),
        reviewedCommitCount: verdict.reviewedCommitCount,
        skippedCommitCount: verdict.skippedCommitCount,
        failures: verdict.failures,
        warnings: verdict.warnings,
        incomplete: verdict.incomplete,
      },
      commits: result.commits.map((commit) =>
        commit.status === "REVIEWED"
          ? {
              sha: commit.sha,
              status: "REVIEWED",
              ...toReviewLogEntry(commit.review),
            }
          : commit,
      ),
    },
    null,
    2,
  );
}

/**
 * GitHub Actions workflow commands for the verdict. They carry a rule ID, a commit
 * revision and a probability — never a path, the subject or the diff — and the caller
 * sets the exit code from the same verdict.
 */
export function describeCheckAnnotations(verdict: CheckVerdict): readonly string[] {
  const failures = verdict.failures.map((failure) => annotationLine("error", failure));
  const warnings = verdict.warnings.map((warning) => annotationLine("warning", warning));
  const lines = [...failures, ...warnings];

  if (verdict.incomplete.length > 0) {
    const reasons = [...new Set(verdict.incomplete.map((entry) => entry.reason))].join(", ");

    lines.push(
      `::warning title=JevGuard::${verdict.incomplete.length} commit(s) were not judged completely (${reasons}); this never fails the check.`,
    );
  }

  if (lines.length === 0) {
    lines.push(
      `::notice title=JevGuard::No rule failed over ${verdict.reviewedCommitCount} commit(s).`,
    );
  }

  return lines;
}

function commitLine(commit: ReplayCommitResult): string {
  return `${commit.sha.slice(0, SHA_LENGTH)}  ${verdictOf(commit).padEnd(VERDICT_COLUMN_WIDTH)}${detailsOf(commit)}`;
}

function verdictOf(commit: ReplayCommitResult): string {
  switch (commit.status) {
    case "REVIEWED":
      return toReviewLogEntry(commit.review).summary.highestVerdict ?? "PASS";
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
      return `patch not judged: ${commit.reason}`;
    case "RULE_NOT_FOUND":
      return "no rule in .jev/rules.md matches --rule";
    case "SKIPPED":
      return commit.reason === "MERGE_COMMIT" ? "merge commit, not a unit" : "no patch";
  }
}

function describeResults(results: readonly ReviewLogResult[]): string {
  const listed = results
    .slice(0, MAX_LISTED_RESULTS)
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

function describeNotJudged(verdict: CheckVerdict): readonly string[] {
  if (verdict.incomplete.length === 0) return [];

  const reasons = [...new Set(verdict.incomplete.map((entry) => entry.reason))].join(", ");

  return [
    `Not judged: ${verdict.incomplete.length} commit(s) (${reasons}). The evidence was incomplete, so no verdict is given for them.`,
  ];
}

function resultLine(verdict: CheckVerdict, strict: boolean): string {
  switch (verdict.verdict) {
    case "PASS":
      return "PASS — no rule failed.";
    case "WARN":
      return `WARN — ${count(verdict.warnings.length, "warning")}, nothing with severity error failed.`;
    case "FAIL":
      return `FAIL — ${describeFailures(verdict.failures)}.`;
    case "INCOMPLETE":
      return strict
        ? `INCOMPLETE — ${count(verdict.incomplete.length, "commit")} were not judged completely, and --strict fails on that.`
        : `INCOMPLETE — ${count(verdict.incomplete.length, "commit")} were not judged completely; this never fails the check (use --strict to fail on it).`;
    case "RULE_NOT_FOUND":
      return "RULE_NOT_FOUND — no rule matches --rule.";
  }
}

function describeFailures(failures: readonly CheckFailure[]): string {
  const listed = failures
    .slice(0, MAX_LISTED_FAILURES)
    .map((failure) => `${failure.ruleId ?? "<no id>"} (${failure.sha.slice(0, SHA_LENGTH)})`);
  const rest = failures.length - listed.length;

  return rest > 0 ? `${listed.join(", ")} and ${rest} more failed` : `${listed.join(", ")} failed`;
}

function annotationLine(level: "error" | "warning", failure: CheckFailure): string {
  const rule = failure.ruleId ?? "a rule without an id";
  const severity = level === "error" ? "error" : "warning";
  const message = `Commit ${failure.sha.slice(0, SHA_LENGTH)} may violate ${rule} (p=${failure.violationProbability.toFixed(2)}, severity ${severity}).`;

  return `::${level} title=${escapeProperty(`JevGuard ${rule}`)}::${escapeData(message)}`;
}

function count(value: number, noun: string): string {
  return `${value} ${noun}${value === 1 ? "" : "s"}`;
}

function escapeProperty(value: string): string {
  return value
    .replaceAll("%", "%25")
    .replaceAll("\r", "%0D")
    .replaceAll("\n", "%0A")
    .replaceAll(":", "%3A")
    .replaceAll(",", "%2C");
}

function escapeData(value: string): string {
  return value.replaceAll("%", "%25").replaceAll("\r", "%0D").replaceAll("\n", "%0A");
}
