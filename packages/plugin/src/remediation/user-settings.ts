import {
  createUserRemediationSettings,
  type RemediationUserSettingsResult,
} from "@jevguard/node-infra";

/** The user's OpenCode file, `<config>/jevguard/opencode.yaml`; it has no `model` key. */
export const OPENCODE_CONFIG_FILE_NAME = "opencode.yaml";

/**
 * Reads the user's remediation opt-in for one project from the process environment. Only
 * this file can turn `remediate` on; a project's `.jev` can only veto it.
 */
export function createOpenCodeRemediationSettings(
  environment: { get(name: string): string | undefined } = {
    get: (name) => process.env[name],
  },
): (projectRoot: string) => RemediationUserSettingsResult {
  return createUserRemediationSettings({ environment, fileName: OPENCODE_CONFIG_FILE_NAME });
}
