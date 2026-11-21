import {
  hasOnlyUserConfigSections,
  isRecord,
  loadUserSettingsFile,
} from "../remediation/user-settings";
import type { UserConfigLoadInput } from "../remediation/types";
import type {
  EnforceSettingsWarning,
  EnforceUserSettings,
  EnforceUserSettingsResult,
} from "./types";

/** The `enforce` section of the user's host file; only the user's own file may carry it. */
export const ENFORCE_SECTION_KEY = "enforce";

/** Shipped default of `enforce.budget_ms` (ADR 0022, decision 8). */
export const ENFORCE_DEFAULT_BUDGET_MS = 8000;
export const ENFORCE_MIN_BUDGET_MS = 2000;
export const ENFORCE_MAX_BUDGET_MS = 15000;

/** Built-in checks: they are never user rules, so listing one can never block a turn. */
export const ENFORCE_BUILT_IN_CHECK_IDS: readonly string[] = [
  "SCOPE-CREEP",
  "COMPLEXITY",
  "TEST-ADEQUACY",
];

const SECTION_KEYS = ["enabled", "rules", "budget_ms"];
/** A rule ID the block reason may carry: one short token, never prose. */
const RULE_ID = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;

const DISABLED: EnforceUserSettingsResult = { status: "DISABLED" };
const INVALID: EnforceUserSettingsResult = {
  status: "INVALID",
  reason: "USER_CONFIG_INVALID",
};

/** `true` for a rule ID that can be named in a block reason. */
export function isEnforceRuleId(value: string): boolean {
  return RULE_ID.test(value);
}

function isBudget(value: unknown): value is number {
  return (
    typeof value === "number" &&
    Number.isInteger(value) &&
    value >= ENFORCE_MIN_BUDGET_MS &&
    value <= ENFORCE_MAX_BUDGET_MS
  );
}

/** `null` when the value is not an allowlist of rule IDs at all. */
function rulesOf(value: unknown): readonly string[] | null {
  if (!Array.isArray(value) || value.length === 0) return null;
  if (!value.every((rule) => typeof rule === "string" && isEnforceRuleId(rule))) return null;

  return value;
}

interface Allowlist {
  readonly rules: readonly string[];
  readonly warnings: readonly EnforceSettingsWarning[];
}

/**
 * Drops duplicates and built-in check IDs from the allowlist. Neither is an error: a
 * built-in can never block whatever the file says, and a repeated rule blocks once.
 */
function allowlistOf(rules: readonly string[]): Allowlist {
  const seen = new Set<string>();
  const kept: string[] = [];
  const warnings = new Set<EnforceSettingsWarning>();

  for (const rule of rules) {
    if (ENFORCE_BUILT_IN_CHECK_IDS.includes(rule)) {
      warnings.add("BUILT_IN_CANNOT_BLOCK");
      continue;
    }

    if (seen.has(rule)) {
      warnings.add("DUPLICATE_RULE");
      continue;
    }

    seen.add(rule);
    kept.push(rule);
  }

  return { rules: kept, warnings: [...warnings] };
}

function sectionResult(section: Readonly<Record<string, unknown>>): EnforceUserSettingsResult {
  if (Object.keys(section).some((key) => !SECTION_KEYS.includes(key))) return INVALID;

  const { enabled, rules, budget_ms: budget } = section;

  if (enabled !== undefined && typeof enabled !== "boolean") return INVALID;

  // A section that is off is still validated, so a typo never hides until it is turned on.
  if (rules === undefined) return enabled === true ? INVALID : DISABLED;

  const listed = rulesOf(rules);

  if (listed === null) return INVALID;

  const budgetMs = budget === undefined ? ENFORCE_DEFAULT_BUDGET_MS : budget;

  if (!isBudget(budgetMs)) return INVALID;
  if (enabled !== true) return DISABLED;

  const allowlist = allowlistOf(listed);

  return {
    status: "ENABLED",
    settings: { rules: allowlist.rules, budgetMs },
    warnings: allowlist.warnings,
  };
}

/**
 * Validates the `enforce` section of a user's host file. An absent file or section, or
 * `enabled: false`, is `DISABLED`; an unknown top-level key, an unknown section key, a
 * wrong type, a rule ID that is not one short token, a non-positive or out-of-range
 * `budget_ms`, or `enabled: true` without an allowlist is `INVALID`. Built-in check IDs
 * and repeated rules are kept out of the effective allowlist with a warning each.
 */
export function resolveEnforceUserSettings(value: unknown): EnforceUserSettingsResult {
  if (value === null || value === undefined) return DISABLED;
  if (!isRecord(value)) return INVALID;
  if (!hasOnlyUserConfigSections(value)) return INVALID;

  const section = value[ENFORCE_SECTION_KEY];

  if (section === undefined) return DISABLED;

  return isRecord(section) ? sectionResult(section) : INVALID;
}

/**
 * Loads the user's `enforce` section. The same rules as remediation: a file inside the
 * project or its Git tree is refused, so a cloned repository can never switch enforce on.
 */
export function loadEnforceUserSettings(input: UserConfigLoadInput): EnforceUserSettingsResult {
  return loadUserSettingsFile(input, resolveEnforceUserSettings, DISABLED);
}

/** The settings an enabled result carries; `null` for `DISABLED` and `INVALID`. */
export function enabledEnforceSettings(
  result: EnforceUserSettingsResult,
): EnforceUserSettings | null {
  return result.status === "ENABLED" ? result.settings : null;
}
