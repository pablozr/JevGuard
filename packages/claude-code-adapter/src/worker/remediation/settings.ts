import {
  loadRemediationUserSettings,
  type RemediationUserSettingsRules,
  resolveRemediationUserSettings,
  type UserConfigEnvironment,
  type UserConfigLoadInput,
  userConfigFileOf as userConfigFileFor,
} from "@jevguard/node-infra";
import { CLAUDE_MODEL_PATTERN } from "../../presentation";
import type { ClaudeRemediationSettingsResult } from "./types";

/** The user's Claude Code file under `jevguard/`. */
export const CLAUDE_CONFIG_FILE_NAME = "claude-code.yaml";

/** Claude Code accepts a `model` key: a Claude alias or id, never translated. */
export const CLAUDE_SETTINGS_RULES: RemediationUserSettingsRules = {
  isModel: (value) => CLAUDE_MODEL_PATTERN.test(value),
};

/** Validates the user's Claude Code remediation file; see `resolveRemediationUserSettings`. */
export function resolveClaudeRemediationSettings(value: unknown): ClaudeRemediationSettingsResult {
  return resolveRemediationUserSettings(value, CLAUDE_SETTINGS_RULES);
}

/** `<XDG_CONFIG_HOME | USERPROFILE | HOME/.config>/jevguard/claude-code.yaml`, or `null`. */
export function userConfigFileOf(environment: UserConfigEnvironment): string | null {
  return userConfigFileFor(environment, CLAUDE_CONFIG_FILE_NAME);
}

/** Loads the user's Claude Code file; one inside the project or its Git tree is refused. */
export function loadClaudeRemediationSettings(
  input: UserConfigLoadInput,
): ClaudeRemediationSettingsResult {
  return loadRemediationUserSettings(input, CLAUDE_SETTINGS_RULES);
}
