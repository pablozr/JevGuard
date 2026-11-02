import { createUserRemediationSettings as createUserSettings } from "@jevguard/node-infra";
import { CLAUDE_CONFIG_FILE_NAME, CLAUDE_SETTINGS_RULES } from "./settings";
import type { ClaudeRemediationSettingsResult } from "./types";

/**
 * Resolves the user's remediation settings for one project from the real file system.
 * The answer is remembered per project for the life of this worker process.
 */
export function createUserRemediationSettings(environment: {
  get(name: string): string | undefined;
}): (projectRoot: string) => ClaudeRemediationSettingsResult {
  return createUserSettings({
    environment,
    fileName: CLAUDE_CONFIG_FILE_NAME,
    rules: CLAUDE_SETTINGS_RULES,
  });
}
