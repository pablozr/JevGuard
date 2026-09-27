import type { RuleEvidenceClass, RuleScope, RuleSeverity } from "../domain/types";
import { matchSectionHeading } from "./headings";
import type { MetadataEntry, ParseStep, RuleMetadata } from "./types";

const METADATA_ENTRY = /^([A-Za-z][A-Za-z0-9_-]*)\s*:\s*(.*)$/;

/**
 * Parses the metadata block of one rule. `scope` may repeat and accumulates into
 * inclusion and `!`-exclusion globs; every other key may appear at most once. A
 * scope declaration without at least one inclusion is malformed.
 */
export function parseRuleMetadata(lines: readonly string[]): ParseStep<RuleMetadata> {
  let severity: RuleSeverity | null = null;
  let evidence: RuleEvidenceClass | null = null;
  let scopeDeclared = false;
  const includePatterns: string[] = [];
  const excludePatterns: string[] = [];
  const seenKeys = new Set<string>();

  for (const line of collectMetadataLines(lines)) {
    const entry = parseMetadataEntry(line);

    if (entry === null) {
      return { ok: false, code: "MALFORMED_METADATA" };
    }

    if (entry.key === "scope") {
      const pattern = parseScopePattern(entry.value);

      if (pattern === null) {
        return { ok: false, code: "MALFORMED_METADATA" };
      }

      scopeDeclared = true;

      if (pattern.exclude) {
        excludePatterns.push(pattern.pattern);
      } else {
        includePatterns.push(pattern.pattern);
      }

      continue;
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

    if (entry.key === "evidence") {
      const parsed = parseEvidenceClass(entry.value);

      if (parsed === null) {
        return { ok: false, code: "MALFORMED_METADATA" };
      }

      evidence = parsed;
      continue;
    }

    return { ok: false, code: "MALFORMED_METADATA" };
  }

  if (severity === null) {
    return { ok: false, code: "MISSING_SEVERITY" };
  }

  if (scopeDeclared && includePatterns.length === 0) {
    return { ok: false, code: "MALFORMED_METADATA" };
  }

  const scope: RuleScope | null = scopeDeclared
    ? { include: includePatterns, exclude: excludePatterns }
    : null;

  return { ok: true, value: { severity, scope, evidence: evidence ?? "code" } };
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

function parseEvidenceClass(value: string): RuleEvidenceClass | null {
  switch (value) {
    case "code":
    case "docs":
    case "any":
      return value;
    default:
      return null;
  }
}

function parseScopePattern(
  value: string,
): { readonly pattern: string; readonly exclude: boolean } | null {
  if (value === "") {
    return null;
  }

  if (value.startsWith("!")) {
    const pattern = value.slice(1).trim();

    return pattern === "" ? null : { pattern, exclude: true };
  }

  return { pattern: value, exclude: false };
}
