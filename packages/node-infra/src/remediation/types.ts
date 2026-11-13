/** Where a proposal goes: shown to the user, or sent to the agent of the session. */
export type RemediationDelivery = "user" | "agent";

/** Keys of the retired remediation chain; still accepted and validated, never acted on. */
export type LegacyRemediationKey = "LEGACY_MODE" | "LEGACY_MAX_ATTEMPTS";

/** The retired `mode` values; they are validated but never change behavior. */
export type LegacyMode = "observe" | "remediate";

/** What the user's file turns on: where proposals go and an optional model. */
export interface RemediationUserSettings {
  readonly delivery: RemediationDelivery;
  /** `null` unless the host accepts a `model` key and the user set one. */
  readonly model: string | null;
}

export type RemediationUserSettingsInvalidReason =
  | "USER_CONFIG_INVALID"
  | "USER_CONFIG_IN_PROJECT"
  | "USER_CONFIG_UNREADABLE";

export type RemediationUserSettingsResult =
  | { readonly status: "DISABLED" }
  | {
      readonly status: "ENABLED";
      readonly settings: RemediationUserSettings;
      readonly warnings: readonly LegacyRemediationKey[];
    }
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

/** Why `delivery: agent` can be neither inspected as writable nor enabled. */
export type AgentDeliveryBlock = "INVALID_EXISTING" | "INSIDE_PROJECT" | "NO_CONFIG_HOME";

export type AgentDeliveryInspectionStatus = "WOULD_ENABLE" | "ALREADY_ENABLED" | AgentDeliveryBlock;

export type AgentDeliveryStatus =
  | "ENABLED"
  | "ALREADY_ENABLED"
  | "WRITE_FAILED"
  | AgentDeliveryBlock;

/** What enabling `delivery: agent` would do; `path` is `null` without a config home. */
export interface AgentDeliveryInspection {
  readonly status: AgentDeliveryInspectionStatus;
  readonly path: string | null;
}

/** Outcome of enabling `delivery: agent`; `path` is `null` without a config home. */
export interface AgentDeliveryResult {
  readonly status: AgentDeliveryStatus;
  readonly path: string | null;
}

/** The slice of a text file port the delivery writer needs. */
export interface AgentDeliveryFiles {
  readText(path: string): Promise<string | null>;
  writeTextAtomic(path: string, text: string): Promise<void>;
  makeDirectory(path: string): Promise<void>;
}

export interface AgentDeliveryInput {
  readonly environment: UserConfigEnvironment;
  /** The host's file under `jevguard/`, such as `opencode.yaml`. */
  readonly fileName: string;
  readonly rules: RemediationUserSettingsRules;
  readonly projectRoot: string;
  readonly probe: ProjectProbe;
  readonly files: AgentDeliveryFiles;
}
