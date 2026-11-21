import type { UserSettingsFileInvalidReason } from "../remediation/user-settings";

/**
 * What an enabled `enforce` section turns on: the rule IDs that may block a turn and the
 * ceiling on the wait. The section is validated here; the Stop hook that acts on it is a
 * separate step (ADR 0022).
 */
export interface EnforceUserSettings {
  /** The user's allowlist, in configured order and without duplicates. */
  readonly rules: readonly string[];
  /** The ceiling on the wait, in milliseconds; the review never blocks past it. */
  readonly budgetMs: number;
}

/** Why an `enforce` section was kept, but cannot block as written. */
export type EnforceSettingsWarning = "DUPLICATE_RULE" | "BUILT_IN_CANNOT_BLOCK";

export type EnforceUserSettingsInvalidReason = UserSettingsFileInvalidReason;

export type EnforceUserSettingsResult =
  | { readonly status: "DISABLED" }
  | {
      readonly status: "ENABLED";
      readonly settings: EnforceUserSettings;
      readonly warnings: readonly EnforceSettingsWarning[];
    }
  | { readonly status: "INVALID"; readonly reason: EnforceUserSettingsInvalidReason };
