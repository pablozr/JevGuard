import type {
  ReportBuiltInCount,
  ReportReasonCount,
  ReportRuleBreakdown,
  ReportRuleCalibration,
  ReviewCounts,
  ReviewReport,
} from "@jevguard/core";
import type { LoginFailureReason } from "@jevguard/node-infra";
import { HOST_IDS } from "./hosts";

const HOST_CHOICE = HOST_IDS.join("|");

export const USAGE = [
  "Usage: jevguard login",
  `       jevguard install [--project] [--host <${HOST_CHOICE}>]`,
  `       jevguard setup [--host <${HOST_CHOICE}>] [--project] [--init] [--yes] [--agent-delivery]`,
  `       jevguard init [--host <${HOST_CHOICE}>] [--global]`,
  "       jevguard replay [--last <1-50>] [--rule <id>] [--json]",
  "       jevguard report [--json]",
  `       jevguard doctor [--json] [--host <${HOST_CHOICE}>]`,
  "       jevguard rules check --diff <file|-> [--task <text>] [--rule <id>] [--json]",
  "       jevguard feedback [--json]",
  "       jevguard feedback <number> <right|wrong>",
  "",
  "`jev-init` and `jevguard-rules` are OpenCode skills, not CLI commands. Register",
  "the plugin in opencode.json (or run `jevguard init`) and invoke them from",
  "OpenCode.",
].join("\n");

export const EMPTY_HISTORY_MESSAGE = "No review history yet.";

export const REPORT_READ_FAILURE_MESSAGE = "Could not read the review history or feedback.";

export const LOGIN_SAVED_MESSAGE = "Credential saved to the OS credential store.";

export const LOGIN_ABORTED_MESSAGE = "Login cancelled. No credential was saved.";

export function describeLoginFailure(reason: LoginFailureReason): string {
  switch (reason) {
    case "NOT_A_TTY":
      return "Login requires an interactive terminal. Run `jevguard login` in a terminal.";
    case "EMPTY_SECRET":
      return "No credential was saved. Enter a non-empty API key.";
    case "PROMPT_FAILURE":
      return "Could not read the credential from the terminal. Try again.";
    case "STORE_WRITE_FAILURE":
      return "Could not save the credential to the OS credential store. Check that a credential store is available and try again.";
  }
}

/** Serializable JSON form of the aggregation for `jevguard report --json`. */
export function serializeReport(report: ReviewReport): string {
  return JSON.stringify(report, null, 2);
}

/**
 * Human-readable aggregation summary. It prints aggregated counts, rule IDs, check
 * IDs, and reason codes only: never a file path, task, diff, or credential. An empty
 * history is stated plainly rather than treated as an error.
 */
export function describeReport(report: ReviewReport): string {
  if (report.entryCount === 0) {
    return EMPTY_HISTORY_MESSAGE;
  }

  return [
    "JevGuard review history",
    `Turns: ${report.entryCount} · skipped malformed lines: ${report.skippedLineCount}`,
    `First: ${report.firstTimestamp ?? "unknown"}`,
    `Last: ${report.lastTimestamp ?? "unknown"}`,
    `Outcomes: ${describeTotals(report.outcomes)}`,
    "",
    "UNAVAILABLE reasons:",
    ...describeReasons(report.unavailableReasons),
    "",
    "SKIPPED reasons:",
    ...describeReasons(report.skippedReasons),
    "",
    "Built-ins:",
    ...describeBuiltIns(report.builtIns),
    "",
    "Rules:",
    ...describeRules(report.rules),
    "",
    `Evaluation: whole ${report.evaluation.wholeEvaluations} · sliced ${report.evaluation.slicedEvaluations} · slice judgments ${report.evaluation.totalSliceJudgments}`,
  ].join("\n");
}

export function describeTotals(totals: ReviewCounts): string {
  return `pass ${totals.pass} · warn ${totals.warn} · fail ${totals.fail} · unavailable ${totals.unavailable} · skipped ${totals.skipped}`;
}

function describeReasons(reasons: readonly ReportReasonCount<string>[]): readonly string[] {
  if (reasons.length === 0) {
    return ["  (none)"];
  }

  return reasons.map((entry) => `  ${entry.reason}: ${entry.count}`);
}

function describeBuiltIns(checks: readonly ReportBuiltInCount[]): readonly string[] {
  if (checks.length === 0) {
    return ["  (none)"];
  }

  return checks.map((entry) => `  ${entry.checkId}: ${entry.count}`);
}

function describeRules(rules: readonly ReportRuleBreakdown[]): readonly string[] {
  if (rules.length === 0) {
    return ["  (none)"];
  }

  return rules.map(
    (entry) =>
      `  ${entry.ruleId}: ${describeTotals(entry.counts)} · sliced ${entry.slicedRuleCount} · ${describeCalibration(entry.calibration)}`,
  );
}

function describeCalibration(calibration: ReportRuleCalibration): string {
  const precision = calibration.precision === null ? "n/a" : calibration.precision.toFixed(2);

  return `feedback right ${calibration.right} · wrong ${calibration.wrong} · unanswered ${calibration.unanswered} · precision ${precision}`;
}
