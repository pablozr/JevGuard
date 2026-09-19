import { matchSectionHeading } from "./headings";
import type { ParseStep, RuleSections } from "./types";

const SECTION_NAMES: readonly string[] = ["Rule", "Violation", "Allowed"];

export function parseRuleSections(lines: readonly string[]): ParseStep<RuleSections> {
  const collected = collectSections(lines);

  if (!collected.ok) {
    return collected;
  }

  return validateSections(collected.value);
}

function collectSections(lines: readonly string[]): ParseStep<Map<string, string>> {
  const sections = new Map<string, string>();
  let current: string | null = null;
  let content: string[] = [];

  for (const line of lines) {
    const heading = matchSectionHeading(line);

    if (heading === null) {
      if (current !== null) {
        content.push(line);
      }
      continue;
    }

    if (current !== null) {
      sections.set(current, joinContent(content));
    }

    if (!SECTION_NAMES.includes(heading)) {
      return { ok: false, code: "UNKNOWN_SECTION" };
    }

    if (sections.has(heading)) {
      return { ok: false, code: "DUPLICATE_SECTION" };
    }

    current = heading;
    content = [];
  }

  if (current !== null) {
    sections.set(current, joinContent(content));
  }

  return { ok: true, value: sections };
}

function validateSections(sections: ReadonlyMap<string, string>): ParseStep<RuleSections> {
  const rule = sections.get("Rule");
  const violation = sections.get("Violation");
  const allowed = sections.get("Allowed") ?? null;

  if (rule === undefined) {
    return { ok: false, code: "MISSING_RULE" };
  }

  if (violation === undefined) {
    return { ok: false, code: "MISSING_VIOLATION" };
  }

  if (rule === "") {
    return { ok: false, code: "EMPTY_SECTION" };
  }

  if (violation === "") {
    return { ok: false, code: "EMPTY_SECTION" };
  }

  if (allowed === "") {
    return { ok: false, code: "EMPTY_ALLOWED" };
  }

  if (allowed !== null && allowed === violation) {
    return { ok: false, code: "ALLOWED_EQUALS_VIOLATION" };
  }

  return { ok: true, value: { rule, violation, allowed } };
}

function joinContent(lines: readonly string[]): string {
  return lines.join("\n").trim();
}
