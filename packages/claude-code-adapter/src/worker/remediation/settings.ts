import { CLAUDE_MODEL_PATTERN, userBaseOf } from "../../presentation";
import { isInsideProject } from "./containment";
import type {
  ClaudeRemediationSettings,
  ClaudeRemediationSettingsResult,
  UserConfigEnvironment,
  UserConfigLoadInput,
} from "./types";

const CONFIG_SUBPATH = "jevguard/claude-code.yaml";
const DEFAULT_CONFIG_SUBPATH = ".config";
const SECTION_KEY = "remediation";
const SECTION_KEYS = ["enabled", "delivery", "model"];

type JsonRecord = Readonly<Record<string, unknown>>;

const DISABLED: ClaudeRemediationSettingsResult = { status: "DISABLED" };
const INVALID: ClaudeRemediationSettingsResult = {
  status: "INVALID",
  reason: "USER_CONFIG_INVALID",
};

function isRecord(value: unknown): value is JsonRecord {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function modelOf(value: unknown): string | null | undefined {
  if (value === undefined) return null;

  return typeof value === "string" && CLAUDE_MODEL_PATTERN.test(value) ? value : undefined;
}

function deliveryOf(value: unknown): ClaudeRemediationSettings["delivery"] | null {
  if (value === undefined) return "user";

  return value === "user" || value === "agent" ? value : null;
}

function sectionResult(section: JsonRecord): ClaudeRemediationSettingsResult {
  if (Object.keys(section).some((key) => !SECTION_KEYS.includes(key))) return INVALID;

  const { enabled } = section;
  const delivery = deliveryOf(section.delivery);
  const model = modelOf(section.model);

  if (enabled !== undefined && typeof enabled !== "boolean") return INVALID;
  if (delivery === null || model === undefined) return INVALID;

  return enabled === true ? { status: "ENABLED", settings: { delivery, model } } : DISABLED;
}

/**
 * Reads the user's Claude Code remediation file. An absent file or section, or
 * `enabled: false`, is `DISABLED`; any unknown key, wrong type, unknown delivery or a
 * model that is not a Claude alias or id is `INVALID`. Models are never translated.
 */
export function resolveClaudeRemediationSettings(value: unknown): ClaudeRemediationSettingsResult {
  if (value === null || value === undefined) return DISABLED;
  if (!isRecord(value)) return INVALID;
  if (Object.keys(value).some((key) => key !== SECTION_KEY)) return INVALID;

  const section = value[SECTION_KEY];

  if (section === undefined) return DISABLED;

  return isRecord(section) ? sectionResult(section) : INVALID;
}

/**
 * The user's config file, `<XDG_CONFIG_HOME | USERPROFILE | HOME/.config>/jevguard/claude-code.yaml`,
 * or `null` when no absolute base exists.
 */
export function userConfigFileOf(environment: UserConfigEnvironment): string | null {
  const base = userBaseOf(
    environment.xdgConfigHome,
    environment.userProfile,
    environment.home,
    DEFAULT_CONFIG_SUBPATH,
  );

  return base === null ? null : `${base}/${CONFIG_SUBPATH}`;
}

/**
 * Loads and validates the user's file. A file whose canonical path is inside the project
 * root or its Git working tree is refused, on every platform and whatever the letter case:
 * a cloned repository must never be able to switch remediation on.
 */
export function loadClaudeRemediationSettings(
  input: UserConfigLoadInput,
): ClaudeRemediationSettingsResult {
  try {
    const realFile = input.realPath(input.file);

    if (realFile === null) return DISABLED;

    if (isInsideProject(realFile, input.projectRoot, input)) {
      return { status: "INVALID", reason: "USER_CONFIG_IN_PROJECT" };
    }

    const text = input.readText(realFile);

    if (text === null) return DISABLED;

    const parsed = input.parse(text);

    return parsed.status === "PARSED" ? resolveClaudeRemediationSettings(parsed.value) : INVALID;
  } catch {
    return { status: "INVALID", reason: "USER_CONFIG_UNREADABLE" };
  }
}
