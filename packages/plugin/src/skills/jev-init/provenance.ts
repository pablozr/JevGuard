import { checkFilePath, DEFAULT_EVIDENCE_POLICY } from "@jevguard/core";
import type { RuleSeverity } from "@jevguard/core";
import { parsePolicyConfig } from "@jevguard/opencode-adapter/policy";
import type {
  ProvenanceEntry,
  ProvenanceResult,
  ProvenanceRule,
  ProvenanceSource,
  ProvenanceValidationCode,
} from "../types";

/**
 * Mirrors the production rule-heading matcher (`^##\s+`) without importing core
 * internals. A line inside the manifest that would open a rule block is unsafe: the
 * rules parser would read it as policy instead of provenance.
 */
const RULE_HEADING = /^##\s+/;
const OPEN_FENCE = "```yaml";
const CLOSE_FENCE = "```";
const MANIFEST_KEYS: ReadonlySet<string> = new Set(["rules"]);
const ENTRY_KEYS: ReadonlySet<string> = new Set(["source", "evidence"]);
const MINIMUM_INFERRED_EVIDENCE = 2;

/**
 * Path segments that never count as evidence, on top of the production evidence
 * policy. `.git` is not a denied directory in that policy, yet it holds credentials
 * and hooks; a reference to `.git/config` or any other `.git` path is rejected here.
 */
const DENIED_EVIDENCE_SEGMENTS: ReadonlySet<string> = new Set([".git"]);

type UnknownRecord = Record<string, unknown>;

type ManifestExtraction =
  | { readonly status: "ok"; readonly yaml: string }
  | { readonly status: "invalid"; readonly code: ProvenanceValidationCode };

/**
 * Parses the provenance preamble of an initialized `.jev/rules.md`. The document must
 * begin with exactly one fenced `yaml` manifest before any rule heading, mapping every
 * valid rule ID to a `source` and, for `inferred` rules, a relative POSIX evidence
 * list. An `inferred` rule is additionally required to carry the parsed `warning`
 * severity and at least two safe evidence paths. A missing, malformed, unsafe, or
 * incomplete preamble is reported as deterministic codes; no document, rule, or
 * evidence text is retained.
 */
export function parseProvenance(text: string, rules: readonly ProvenanceRule[]): ProvenanceResult {
  const manifest = extractManifest(text);

  if (manifest.status === "invalid") {
    return invalid([manifest.code]);
  }

  const parsed = parsePolicyConfig(manifest.yaml);

  if (parsed.status !== "PARSED") {
    return invalid(["PROVENANCE_MALFORMED"]);
  }

  const severities = new Map(rules.map((rule) => [rule.id, rule.severity]));
  const codes = new Set<ProvenanceValidationCode>();
  const entries = readEntries(parsed.value, severities, codes);

  checkAssociations(entries, [...severities.keys()], codes);

  if (codes.size > 0) {
    return invalid([...codes]);
  }

  return { status: "valid", entries };
}

function extractManifest(text: string): ManifestExtraction {
  const lines = text.replace(/\r\n?/g, "\n").split("\n");
  const start = firstNonBlankIndex(lines);

  if (start === -1) {
    return extractionFailure("PROVENANCE_MISSING");
  }

  const opening = lines[start];

  if (opening === undefined) {
    return extractionFailure("PROVENANCE_MISSING");
  }

  if (opening !== OPEN_FENCE) {
    return extractionFailure(
      RULE_HEADING.test(opening) ? "PROVENANCE_MISSING" : "PROVENANCE_MALFORMED",
    );
  }

  const closingIndex = findFenceClose(lines, start + 1);

  if (closingIndex === -1) {
    return extractionFailure("PROVENANCE_MALFORMED");
  }

  const content = lines.slice(start + 1, closingIndex);

  if (content.some((line) => RULE_HEADING.test(line))) {
    return extractionFailure("PROVENANCE_UNSAFE_PREAMBLE");
  }

  return { status: "ok", yaml: content.join("\n") };
}

function firstNonBlankIndex(lines: readonly string[]): number {
  return lines.findIndex((line) => line.trim() !== "");
}

function findFenceClose(lines: readonly string[], from: number): number {
  for (let index = from; index < lines.length; index += 1) {
    if (lines[index] === CLOSE_FENCE) {
      return index;
    }
  }

  return -1;
}

function readEntries(
  value: unknown,
  severities: ReadonlyMap<string, RuleSeverity>,
  codes: Set<ProvenanceValidationCode>,
): ProvenanceEntry[] {
  if (!isRecord(value)) {
    codes.add("PROVENANCE_MALFORMED");
    return [];
  }

  if (Object.keys(value).some((key) => !MANIFEST_KEYS.has(key))) {
    codes.add("PROVENANCE_MALFORMED");
    return [];
  }

  const rules = value.rules;

  if (!isRecord(rules)) {
    codes.add("PROVENANCE_MALFORMED");
    return [];
  }

  const entries: ProvenanceEntry[] = [];

  for (const [id, rawEntry] of Object.entries(rules)) {
    const entry = readEntry(id, rawEntry, severities, codes);

    if (entry !== null) {
      entries.push(entry);
    }
  }

  return entries;
}

function readEntry(
  id: string,
  raw: unknown,
  severities: ReadonlyMap<string, RuleSeverity>,
  codes: Set<ProvenanceValidationCode>,
): ProvenanceEntry | null {
  if (!isRecord(raw)) {
    codes.add("PROVENANCE_MALFORMED");
    return null;
  }

  if (Object.keys(raw).some((key) => !ENTRY_KEYS.has(key))) {
    codes.add("PROVENANCE_MALFORMED");
    return null;
  }

  const source = readSource(raw.source, codes);

  if (source === null) {
    return null;
  }

  const evidence = readEvidence(raw.evidence, codes);

  if (source === "inferred") {
    checkInferredEvidence(evidence, codes);
    checkInferredSeverity(id, severities, codes);
  }

  return { id, source, evidence };
}

function checkInferredEvidence(
  evidence: readonly string[],
  codes: Set<ProvenanceValidationCode>,
): void {
  if (evidence.length === 0) {
    codes.add("PROVENANCE_MISSING_EVIDENCE");
    return;
  }

  if (evidence.length < MINIMUM_INFERRED_EVIDENCE) {
    codes.add("PROVENANCE_INSUFFICIENT_EVIDENCE");
  }
}

function checkInferredSeverity(
  id: string,
  severities: ReadonlyMap<string, RuleSeverity>,
  codes: Set<ProvenanceValidationCode>,
): void {
  const severity = severities.get(id);

  if (severity !== undefined && severity !== "warning") {
    codes.add("PROVENANCE_INFERRED_SEVERITY");
  }
}

function readSource(value: unknown, codes: Set<ProvenanceValidationCode>): ProvenanceSource | null {
  if (value === "user" || value === "inferred") {
    return value;
  }

  codes.add("PROVENANCE_INVALID_SOURCE");

  return null;
}

function readEvidence(value: unknown, codes: Set<ProvenanceValidationCode>): string[] {
  if (value === undefined) {
    return [];
  }

  if (!Array.isArray(value) || value.length === 0) {
    codes.add("PROVENANCE_INVALID_EVIDENCE");
    return [];
  }

  const evidence: string[] = [];

  for (const entry of value) {
    if (typeof entry !== "string" || !isSafeEvidencePath(entry)) {
      codes.add("PROVENANCE_INVALID_EVIDENCE");
      continue;
    }

    evidence.push(entry);
  }

  return evidence;
}

function checkAssociations(
  entries: readonly ProvenanceEntry[],
  validRuleIds: readonly string[],
  codes: Set<ProvenanceValidationCode>,
): void {
  const valid = new Set(validRuleIds);
  const covered = new Set(entries.map((entry) => entry.id));

  for (const id of covered) {
    if (!valid.has(id)) {
      codes.add("PROVENANCE_UNKNOWN_RULE");
    }
  }

  for (const id of valid) {
    if (!covered.has(id)) {
      codes.add("PROVENANCE_MISSING_RULE");
    }
  }
}

/**
 * A provenance evidence reference must be a relative POSIX path that cannot be a
 * secret. Absolute, drive-letter, home, traversal, backslash, and URL paths are
 * rejected, as are `.git` paths; the production evidence policy's denied file names,
 * extensions, and directories are rejected too, while an unlisted extension is allowed
 * because a reference is metadata, not content.
 */
function isSafeEvidencePath(path: string): boolean {
  if (path.length === 0 || path.includes("\\") || path.includes("\0")) {
    return false;
  }

  if (path.startsWith("/") || path.startsWith("~") || /^[A-Za-z]:/.test(path)) {
    return false;
  }

  if (path.includes("://")) {
    return false;
  }

  const segments = path.split("/");

  if (segments.some((segment) => segment === "" || segment === "." || segment === "..")) {
    return false;
  }

  if (segments.some((segment) => DENIED_EVIDENCE_SEGMENTS.has(segment.toLowerCase()))) {
    return false;
  }

  const safety = checkFilePath(path, DEFAULT_EVIDENCE_POLICY);

  return safety.allowed || safety.reason !== "DENIED_SENSITIVE_PATH";
}

function isRecord(value: unknown): value is UnknownRecord {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function extractionFailure(code: ProvenanceValidationCode): ManifestExtraction {
  return { status: "invalid", code };
}

function invalid(codes: readonly ProvenanceValidationCode[]): ProvenanceResult {
  return { status: "invalid", codes };
}
