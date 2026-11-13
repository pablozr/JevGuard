import { CLAUDE_MODEL_PATTERN } from "./proposal-file";
import type { ClaudeSettingsRules } from "./types";

/** The user's Claude Code file under `jevguard/`. */
export const CLAUDE_CONFIG_FILE_NAME = "claude-code.yaml";

/** Claude Code accepts a `model` key: a Claude alias or id, never translated. */
export const CLAUDE_SETTINGS_RULES: ClaudeSettingsRules = {
  isModel: (value) => CLAUDE_MODEL_PATTERN.test(value),
};
