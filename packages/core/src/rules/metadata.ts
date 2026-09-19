import type { RuleSeverity } from "../domain/types";
import { matchSectionHeading } from "./headings";
import type { MetadataEntry, ParseStep, RuleMetadata } from "./types";

const METADATA_ENTRY = /^([A-Za-z][A-Za-z0-9_-]*)\s*:\s*(.*)$/;

export function parseRuleMetadata(lines: readonly string[]): ParseStep<RuleMetadata> {
  let severity: RuleSeverity | null = null;
  let scope: string | null = null;
  const seenKeys = new Set<string>();

  for (const line of collectMetadataLines(lines)) {
    const entry = parseMetadataEntry(line);

    if (entry === null) {
      return { ok: false, code: "MALFORMED_METADATA" };
    }

    if (seenKeys.has(entry.key)) {
      return { ok: false, code: "DUPLICATE_METADATA" };
    }
    seenKeys.add(entry.key);

    if (entry.key === "severity") {
      const parsed = parseSeverity(entry.value);

      if (parsed === null) {
        return { ok: false, code: "INVALID_SEVERITY" };
      }

      severity = parsed;
      continue;
    }

    if (entry.key === "scope") {
      if (entry.value === "") {
        return { ok: false, code: "MALFORMED_METADATA" };
      }

      scope = entry.value;
      continue;
    }

    return { ok: false, code: "MALFORMED_METADATA" };
  }

  if (severity === null) {
    return { ok: false, code: "MISSING_SEVERITY" };
  }

  return { ok: true, value: { severity, scope } };
}

function collectMetadataLines(lines: readonly string[]): readonly string[] {
  const collected: string[] = [];

  for (const line of lines) {
    if (matchSectionHeading(line) !== null) {
      break;
    }

    if (line.trim() !== "") {
      collected.push(line);
    }
  }

  return collected;
}

function parseMetadataEntry(line: string): MetadataEntry | null {
  const match = METADATA_ENTRY.exec(line);

  if (match === null) {
    return null;
  }

  return { key: match[1] ?? "", value: (match[2] ?? "").trim() };
}

function parseSeverity(value: string): RuleSeverity | null {
  switch (value) {
    case "error":
    case "warning":
      return value;
    default:
      return null;
  }
}
