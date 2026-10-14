import type { ReviewCounts, ReviewOutcome } from "@jevguard/core";
import type { ReviewDisplay, ReviewFeedRecorded, ReviewFeedResult } from "./types";

const MAX_SHOWN_ITEMS = 5;
const SEPARATOR = " · ";
const REVIEW_LABEL = "review";
const TURN_ORDINAL = /^\d+$/;

/** Highest outcome a user sees: FAIL, then UNAVAILABLE, WARN, PASS, and SKIPPED when nothing else. */
export function displayOutcomeOf(counts: ReviewCounts): ReviewOutcome {
  if (counts.fail > 0) return "FAIL";
  if (counts.unavailable > 0) return "UNAVAILABLE";
  if (counts.warn > 0) return "WARN";
  if (counts.pass > 0) return "PASS";

  return "SKIPPED";
}

/** `unit N` from the trailing ordinal of a turn id, or plain `unit` when there is none. */
export function unitLabelOf(turnId: string): string {
  const ordinal = turnId.slice(turnId.lastIndexOf(":") + 1);

  return TURN_ORDINAL.test(ordinal) ? `unit ${ordinal}` : "unit";
}

function labelOf(result: ReviewFeedResult): string {
  return result.id ?? REVIEW_LABEL;
}

function itemOf(result: ReviewFeedResult, causes: readonly string[]): string {
  const label = labelOf(result);
  const slices =
    result.sliceCount !== null && result.sliceCount > 1 ? ` (${result.sliceCount} slices)` : "";

  switch (result.outcome) {
    case "PASS":
    case "WARN":
    case "FAIL":
      return `${label} ${Math.round(result.probability * 100)}%${slices}`;
    case "SKIPPED":
    case "UNAVAILABLE": {
      const because =
        result.lane === "REVIEW" && causes.length > 0 ? ` (${causes.join(", ")})` : "";

      return `${label} ${result.reason}${because}${slices}`;
    }
  }
}

function listed(items: readonly string[]): string {
  const shown = items.slice(0, MAX_SHOWN_ITEMS);
  const hidden = items.length - shown.length;

  return hidden > 0 ? [...shown, `+${hidden} more`].join(", ") : shown.join(", ");
}

function segment(prefix: string, items: readonly string[]): string | null {
  return items.length === 0 ? null : `${prefix}: ${listed(items)}`;
}

function itemsWith(record: ReviewFeedRecorded, outcome: ReviewOutcome): readonly string[] {
  return record.results
    .filter((result) => result.outcome === outcome)
    .map((result) => itemOf(result, record.causes));
}

function tally(label: string, count: number): string | null {
  return count > 0 ? `${label} ${count}` : null;
}

function lineOf(record: ReviewFeedRecorded, outcome: ReviewOutcome, unit: string): string | null {
  if (outcome === "SKIPPED") return null;

  const segments = [
    `JevGuard ${outcome}`,
    unit,
    segment("fail", itemsWith(record, "FAIL")),
    segment("unavailable", itemsWith(record, "UNAVAILABLE")),
    segment("warn", itemsWith(record, "WARN")),
    tally("pass", record.counts.pass),
    tally("skipped", record.counts.skipped),
  ];

  return segments.filter((part) => part !== null).join(SEPARATOR);
}

function skippedDetail(record: ReviewFeedRecorded): string {
  const outOfScope = record.results.some(
    (result) => result.outcome === "SKIPPED" && result.reason === "NO_SCOPE_MATCH",
  );

  return outOfScope ? "no rule in scope" : "no attributed changes";
}

function statusOf(record: ReviewFeedRecorded, outcome: ReviewOutcome, unit: string): string {
  const head = `JevGuard ${outcome}${SEPARATOR}${unit}${SEPARATOR}`;

  if (outcome === "SKIPPED") return `${head}${skippedDetail(record)}`;

  const { counts } = record;
  const parts = [
    countPhrase(counts.fail, "fail"),
    countPhrase(counts.unavailable, "unavailable"),
    countPhrase(counts.warn, "warn"),
    countPhrase(counts.pass, "pass"),
  ];

  return `${head}${parts.filter((part) => part !== null).join(", ")}`;
}

function countPhrase(count: number, label: string): string | null {
  return count > 0 ? `${count} ${label}` : null;
}

function toastOf(record: ReviewFeedRecorded, outcome: ReviewOutcome, unit: string): string | null {
  if (outcome !== "FAIL") return null;

  const ids = record.results
    .filter((result) => result.outcome === "FAIL")
    .map((result) => labelOf(result));

  return `JevGuard FAIL${SEPARATOR}${unit}${SEPARATOR}${listed(ids)}`;
}

/** Everything the session shows for one recorded review; ids, percentages and typed codes only. */
export function describeReview(record: ReviewFeedRecorded): ReviewDisplay {
  const outcome = displayOutcomeOf(record.counts);
  const unit = unitLabelOf(record.turnId);

  return {
    outcome,
    unit,
    line: lineOf(record, outcome, unit),
    status: statusOf(record, outcome, unit),
    toast: toastOf(record, outcome, unit),
  };
}
