import type {
  DiffParseFailureReason,
  RuleEvidenceMetadata,
  SkippedReason,
  TurnReview,
  UnavailableReason,
} from "@jevguard/core";
import { type ReviewLogEntry, type ReviewLogResult, toReviewLogEntry } from "@jevguard/node-infra";
import { describeTotals } from "../messages";
import type { DiffReadFailureReason } from "./types";

export const RULES_CHECK_USAGE =
  "Usage: jevguard rules check --diff <file|-> [--task <text>] [--rule <id>] [--json]";

export const RULES_CHECK_FAILURE_MESSAGE = "Could not run the rule check.";

export const RULE_NOT_FOUND_MESSAGE = "No rule in .jev/rules.md matches --rule.";

const OUTCOME_COLUMN_WIDTH = 13;
const NAME_COLUMN_PADDING = 2;

export function describeDiffInputFailure(
  reason: DiffReadFailureReason | DiffParseFailureReason,
): string {
  switch (reason) {
    case "DIFF_READ_FAILURE":
      return "Could not read the diff. Check the path and the file permissions.";
    case "DIFF_TOO_LARGE":
      return "The diff is larger than the 16 MiB input limit.";
    case "DIFF_NOT_UTF8":
      return "The diff is not valid UTF-8 text.";
    case "STDIN_IS_TTY":
      return "--diff - needs piped input, for example: git diff --cached | jevguard rules check --diff -";
    case "UNRECOGNIZED_DIFF":
      return "The input is not plain git diff output: pass the output of git diff, without log headers, patch mail or extra text.";
    case "COMBINED_DIFF":
      return "The diff is a combined (merge) diff, which rules check does not support.";
    case "UNSUPPORTED_PREFIX":
      return "The diff does not use the a/ and b/ path prefixes. Use git diff without --no-prefix, or git -c diff.mnemonicPrefix=false diff.";
    case "RENAMED_PATH":
      return "The diff renames or copies a file with changed content, which rules check does not support.";
    case "TRUNCATED_HUNK":
      return "The diff ends inside a hunk or a file section has no hunks; the input looks truncated.";
    case "BINARY_PATCH":
      return "The diff contains a binary patch, which rules check does not support.";
    case "QUOTED_PATH":
      return "The diff contains a quoted file path, which rules check does not support.";
    case "MISSING_PATH":
      return "The diff contains a file section without a usable path.";
  }
}

/** Serializable JSON form for `jevguard rules check --json`: the safe log allowlist plus a version. */
export function serializeRulesCheck(review: TurnReview): string {
  return JSON.stringify({ version: 1, ...toReviewLogEntry(review) }, null, 2);
}

/**
 * Human-readable rule check. It prints rule IDs, outcomes, probabilities, severities,
 * scoped paths and typed reason codes only: never the task or any diff content.
 */
export function describeRulesCheck(review: TurnReview): string {
  const entry = toReviewLogEntry(review);

  return [
    "JevGuard rules check",
    ...describeResults(entry),
    describeSummary(entry),
    ...describeHints(entry.results),
  ].join("\n");
}

function describeResults(entry: ReviewLogEntry): readonly string[] {
  const nameWidth = Math.max(...entry.results.map((result) => resultName(result).length), 0);

  return entry.results.map((result) => {
    const name = resultName(result).padEnd(nameWidth + NAME_COLUMN_PADDING);
    const outcome = result.outcome.padEnd(OUTCOME_COLUMN_WIDTH);

    return `${name}${outcome}${resultDetail(result)}`.trimEnd();
  });
}

function resultName(result: ReviewLogResult): string {
  switch (result.kind) {
    case "RULE":
      return result.ruleId ?? "<no id>";
    case "BUILT_IN":
      return result.checkId;
    case "REVIEW":
      return "review";
  }
}

function resultDetail(result: ReviewLogResult): string {
  if ("reason" in result) {
    return result.reason;
  }

  const probability = `p=${result.violationProbability.toFixed(2)}`;
  const slices = result.kind === "RULE" ? describeSlices(result.evidence) : "";

  return [probability, result.severity ?? "-", slices, result.scopedPaths.join(", ")]
    .filter((part) => part !== "")
    .join("  ");
}

function describeSlices(evidence: RuleEvidenceMetadata | undefined): string {
  if (evidence === undefined || evidence.mode !== "SLICED") {
    return "";
  }

  return `slices ${evidence.evaluatedSliceCount}/${evidence.plannedSliceCount}`;
}

function describeSummary(entry: ReviewLogEntry): string {
  return `Summary: ${describeTotals(entry.summary.counts)}`;
}

function describeHints(results: readonly ReviewLogResult[]): readonly string[] {
  const reasons = results.flatMap((result) =>
    result.outcome === "UNAVAILABLE" && "reason" in result ? [result.reason] : [],
  );
  const unique = [...new Set(reasons)];

  return unique.flatMap((reason) => {
    const hint = hintFor(reason);

    return hint === null ? [] : [`hint: ${hint}`];
  });
}

function hintFor(reason: SkippedReason | UnavailableReason): string | null {
  switch (reason) {
    case "JEV_FAILURE":
      return "Jev could not evaluate (credential or network). Run `jevguard doctor`.";
    case "BLOCKED_EVIDENCE":
      return "A scoped file is on the sensitive-path denylist or has a non-allowlisted extension; it was not sent.";
    case "SLICE_LIMIT_EXCEEDED":
      return "The diff is too large for this rule's slice budget.";
    case "INVALID_RULE":
    case "INVALID_CONFIG":
      return "Fix .jev/rules.md or .jev/config.yaml; `jevguard doctor` shows what is invalid.";
    case "MISSING_ATTRIBUTED_DIFF":
    case "OVERSIZED_DIFF":
    case "NO_ATTRIBUTED_PATCH":
    case "NO_SCOPE_MATCH":
      return null;
  }
}
