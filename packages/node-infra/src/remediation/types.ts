import type { RemediationMode } from "@jevguard/core";

/** Where a proposal goes: shown to the user, or sent to the agent of the session. */
export type RemediationDelivery = "user" | "agent";

/** What the user's file turns on: where proposals go, the mode, the chain bound and an optional model. */
export interface RemediationUserSettings {
  readonly delivery: RemediationDelivery;
  /** `null` unless the host accepts a `model` key and the user set one. */
  readonly model: string | null;
  /** `observe` (default) never messages the agent beyond one delivery; `remediate` runs a bounded chain. */
  readonly mode: RemediationMode;
  /** Deliveries one chain may make, 1..3; meaningful only in `remediate`. */
  readonly maxAttempts: number;
}

export type RemediationUserSettingsInvalidReason =
  | "USER_CONFIG_INVALID"
  | "USER_CONFIG_IN_PROJECT"
  | "USER_CONFIG_UNREADABLE";

export type RemediationUserSettingsResult =
  | { readonly status: "DISABLED" }
  | { readonly status: "ENABLED"; readonly settings: RemediationUserSettings }
  | { readonly status: "INVALID"; readonly reason: RemediationUserSettingsInvalidReason };

/** What a host accepts besides the shared keys. Without `isModel`, a `model` key is invalid. */
export interface RemediationUserSettingsRules {
  readonly isModel?: (value: string) => boolean;
}

/** The process variables the user config location derives from; `undefined` when unset. */
export interface UserConfigEnvironment {
  readonly xdgConfigHome: string | undefined;
  readonly userProfile: string | undefined;
  readonly home: string | undefined;
}

export type UserConfigParse =
  | { readonly status: "PARSED"; readonly value: unknown }
  | { readonly status: "INVALID" };

/** The file-system questions that decide whether a path lies inside a project. */
export interface ProjectProbe {
  /** Canonical path, or `null` when the path does not exist; throws when it cannot be resolved. */
  readonly realPath: (path: string) => string | null;
  /** `true` when `directory` holds a `.git` file or directory. */
  readonly hasGitMarker: (directory: string) => boolean;
}

export interface UserConfigLoadInput extends ProjectProbe {
  readonly file: string;
  readonly projectRoot: string;
  /** File text, or `null` when the file does not exist; throws when it cannot be read. */
  readonly readText: (path: string) => string | null;
  readonly parse: (text: string) => UserConfigParse;
}
