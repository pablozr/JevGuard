import { readFileSync } from "node:fs";
import { isAttemptCount, MAX_ATTEMPTS_DEFAULT } from "@jevguard/core";
import { parsePolicyConfig } from "../policy";
import { createNodeProjectProbe, isInsideProject, orNullWhenMissing } from "./containment";
import type {
  RemediationUserSettings,
  RemediationUserSettingsResult,
  RemediationUserSettingsRules,
  UserConfigEnvironment,
  UserConfigLoadInput,
} from "./types";

const ABSOLUTE_PATH = /^(?:[A-Za-z]:[\\/]|[\\/])/;
const TRAILING_SEPARATORS = /[\\/]+$/;
const DEFAULT_CONFIG_SUBPATH = ".config";
const CONFIG_DIRECTORY = "jevguard";
const SECTION_KEY = "remediation";
const SHARED_KEYS = ["enabled", "delivery", "mode", "max_attempts"];
const MODEL_KEY = "model";

const DISABLED: RemediationUserSettingsResult = { status: "DISABLED" };
const INVALID: RemediationUserSettingsResult = {
  status: "INVALID",
  reason: "USER_CONFIG_INVALID",
};

type JsonRecord = Record<string, unknown>;

function isRecord(value: unknown): value is JsonRecord {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function modelOf(value: unknown, rules: RemediationUserSettingsRules): string | null | undefined {
  if (value === undefined) return null;

  return typeof value === "string" && rules.isModel?.(value) === true ? value : undefined;
}

function deliveryOf(value: unknown): RemediationUserSettings["delivery"] | null {
  if (value === undefined) return "user";

  return value === "user" || value === "agent" ? value : null;
}

function modeOf(value: unknown): RemediationUserSettings["mode"] | null {
  if (value === undefined) return "observe";

  return value === "observe" || value === "remediate" ? value : null;
}

/** An integer in 1..3, only valid with `remediate`; the default is 2. */
function maxAttemptsOf(value: unknown, mode: RemediationUserSettings["mode"]): number | null {
  if (value === undefined) return MAX_ATTEMPTS_DEFAULT;

  return mode === "remediate" && isAttemptCount(value) ? value : null;
}

function sectionResult(
  section: JsonRecord,
  rules: RemediationUserSettingsRules,
): RemediationUserSettingsResult {
  const keys = rules.isModel === undefined ? SHARED_KEYS : [...SHARED_KEYS, MODEL_KEY];

  if (Object.keys(section).some((key) => !keys.includes(key))) return INVALID;

  const { enabled } = section;
  const delivery = deliveryOf(section.delivery);
  const model = modelOf(section.model, rules);
  const mode = modeOf(section.mode);

  if (enabled !== undefined && typeof enabled !== "boolean") return INVALID;
  if (delivery === null || model === undefined || mode === null) return INVALID;
  if (mode === "remediate" && delivery !== "agent") return INVALID;

  const maxAttempts = maxAttemptsOf(section.max_attempts, mode);

  if (maxAttempts === null) return INVALID;

  return enabled === true
    ? { status: "ENABLED", settings: { delivery, model, mode, maxAttempts } }
    : DISABLED;
}

/**
 * Validates the `remediation` section of a user's host file. An absent file or section,
 * or `enabled: false`, is `DISABLED`; any unknown key, wrong type, unknown delivery or a
 * model the host does not accept is `INVALID`. `mode: remediate` needs `delivery: agent`,
 * and `max_attempts` (1..3) needs `remediate`.
 */
export function resolveRemediationUserSettings(
  value: unknown,
  rules: RemediationUserSettingsRules = {},
): RemediationUserSettingsResult {
  if (value === null || value === undefined) return DISABLED;
  if (!isRecord(value)) return INVALID;
  if (Object.keys(value).some((key) => key !== SECTION_KEY)) return INVALID;

  const section = value[SECTION_KEY];

  if (section === undefined) return DISABLED;

  return isRecord(section) ? sectionResult(section, rules) : INVALID;
}

function absoluteOrNull(value: string | undefined): string | null {
  return value !== undefined && ABSOLUTE_PATH.test(value) ? value : null;
}

/**
 * The user's file for one host, `<XDG_CONFIG_HOME | USERPROFILE | HOME/.config>/jevguard/<fileName>`,
 * or `null` when no absolute base exists. An empty `USERPROFILE` falls back to `HOME`.
 */
export function userConfigFileOf(
  environment: UserConfigEnvironment,
  fileName: string,
): string | null {
  const profile = environment.userProfile === "" ? undefined : environment.userProfile;
  const home = absoluteOrNull(profile ?? environment.home);
  const homeBase =
    home === null ? null : `${home.replace(TRAILING_SEPARATORS, "")}/${DEFAULT_CONFIG_SUBPATH}`;
  const base = absoluteOrNull(environment.xdgConfigHome) ?? homeBase;

  return base === null
    ? null
    : `${base.replace(TRAILING_SEPARATORS, "")}/${CONFIG_DIRECTORY}/${fileName}`;
}

/**
 * Loads and validates the user's file. A file whose canonical path is inside the project
 * root or its Git working tree is refused, on every platform and whatever the letter case:
 * a cloned repository must never be able to switch remediation on.
 */
export function loadRemediationUserSettings(
  input: UserConfigLoadInput,
  rules: RemediationUserSettingsRules = {},
): RemediationUserSettingsResult {
  try {
    const realFile = input.realPath(input.file);

    if (realFile === null) return DISABLED;

    if (isInsideProject(realFile, input.projectRoot, input)) {
      return { status: "INVALID", reason: "USER_CONFIG_IN_PROJECT" };
    }

    const text = input.readText(realFile);

    if (text === null) return DISABLED;

    const parsed = input.parse(text);

    return parsed.status === "PARSED"
      ? resolveRemediationUserSettings(parsed.value, rules)
      : INVALID;
  } catch {
    return { status: "INVALID", reason: "USER_CONFIG_UNREADABLE" };
  }
}

export interface UserRemediationSettingsDependencies {
  readonly environment: { get(name: string): string | undefined };
  /** The host's file under `jevguard/`, such as `opencode.yaml`. */
  readonly fileName: string;
  readonly rules?: RemediationUserSettingsRules;
}

/**
 * Resolves the user's remediation settings for one project from the real file system.
 * The answer is remembered per project for the life of the process.
 */
export function createUserRemediationSettings(
  dependencies: UserRemediationSettingsDependencies,
): (projectRoot: string) => RemediationUserSettingsResult {
  const { environment } = dependencies;
  const file = userConfigFileOf(
    {
      xdgConfigHome: environment.get("XDG_CONFIG_HOME"),
      userProfile: environment.get("USERPROFILE"),
      home: environment.get("HOME"),
    },
    dependencies.fileName,
  );
  const probe = createNodeProjectProbe();
  const remembered = new Map<string, RemediationUserSettingsResult>();

  function load(projectRoot: string): RemediationUserSettingsResult {
    if (file === null) return DISABLED;

    return loadRemediationUserSettings(
      {
        file,
        projectRoot,
        readText: (path) => orNullWhenMissing(() => readFileSync(path, "utf8")),
        realPath: probe.realPath,
        hasGitMarker: probe.hasGitMarker,
        parse: (text) => {
          const parsed = parsePolicyConfig(text);

          return parsed.status === "PARSED"
            ? { status: "PARSED", value: parsed.value }
            : { status: "INVALID" };
        },
      },
      dependencies.rules,
    );
  }

  return (projectRoot) => {
    const known = remembered.get(projectRoot);

    if (known !== undefined) return known;

    const loaded = load(projectRoot);

    remembered.set(projectRoot, loaded);

    return loaded;
  };
}
