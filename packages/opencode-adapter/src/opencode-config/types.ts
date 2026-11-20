import type { ConfirmationPrompt } from "@jevguard/node-infra";

export type InstallTarget = "global" | "project";

export type InstallFailureReason =
  | "NOT_A_TTY"
  | "UNSUPPORTED_JSONC"
  | "INVALID_JSON"
  | "INVALID_CONFIG_SHAPE"
  | "READ_FAILURE"
  | "WRITE_FAILURE";

/**
 * Outcome of `jevguard install`. It never carries file contents; failures stay
 * typed so the CLI can render a safe message and the manual snippet.
 */
export type InstallOutcome =
  | {
      readonly status: "INSTALLED";
      readonly target: InstallTarget;
      readonly path: string;
    }
  | {
      /** The package was registered with another spec; the entry was re-pinned. */
      readonly status: "UPDATED";
      readonly target: InstallTarget;
      readonly path: string;
      readonly from: string;
    }
  | {
      readonly status: "ALREADY_INSTALLED";
      readonly target: InstallTarget;
      readonly path: string;
    }
  | {
      readonly status: "ABORTED";
      readonly target: InstallTarget;
      readonly path: string;
    }
  | {
      readonly status: "FAILED";
      readonly target: InstallTarget;
      readonly path: string;
      readonly reason: InstallFailureReason;
    };

/**
 * Read/write port over the target `opencode.json`. Absence is `null` rather than a
 * thrown ENOENT so the installer can distinguish a missing file from an I/O error.
 */
export interface ConfigFileSystem {
  readFile(path: string): Promise<string | null>;
  fileExists(path: string): Promise<boolean>;
  writeFile(path: string, contents: string): Promise<void>;
  ensureParentDirectory(path: string): Promise<void>;
}

/** Inputs that resolve the target `opencode.json` location. */
export interface InstallPathContext {
  readonly cwd: string;
  readonly environment: Readonly<Record<string, string | undefined>>;
  readonly homedir: string;
}

export interface InstallDependencies extends InstallPathContext {
  readonly target: InstallTarget;
  readonly confirmation: ConfirmationPrompt;
  readonly fileSystem: ConfigFileSystem;
}

/** Result of merging the JevGuard entry into a parsed `opencode.json` document. */
export type PluginEntryMutation =
  | { readonly status: "ADDED"; readonly document: Readonly<Record<string, unknown>> }
  | {
      /** The package was registered with another spec and the entry is re-pinned. */
      readonly status: "REPINNED";
      readonly document: Readonly<Record<string, unknown>>;
      readonly from: string;
    }
  | { readonly status: "PRESENT" }
  | { readonly status: "INVALID_SHAPE" };

/** Read-only lookup of one package's entry in a parsed `opencode.json` document. */
export type PluginEntryLookup =
  | {
      readonly status: "FOUND";
      /** The registered spec, pinned or not. */
      readonly spec: string;
      /** The entry lives in the legacy `plugin` key rather than `plugins`. */
      readonly legacy: boolean;
    }
  | { readonly status: "ABSENT" }
  | { readonly status: "INVALID_SHAPE" };

export type InstallInspectionFailureReason = Extract<
  InstallFailureReason,
  "UNSUPPORTED_JSONC" | "INVALID_JSON" | "INVALID_CONFIG_SHAPE" | "READ_FAILURE"
>;

/** Read-only registration state of the JevGuard plugin entry in one `opencode.json`. */
export type InstallInspection =
  | {
      readonly status: "REGISTERED";
      readonly target: InstallTarget;
      readonly path: string;
      /** The pinned version, or `null` when the entry resolves to `@latest`. */
      readonly pin: string | null;
      /** The entry lives in the legacy `plugin` key rather than `plugins`. */
      readonly legacy: boolean;
      /** The entry as written, e.g. `@pablozrrrr/jevguard@0.4.1` or a `file:` path. */
      readonly spec: string;
      /** Every registered occurrence across both keys, the first-found one included. */
      readonly specs: readonly string[];
    }
  | {
      readonly status: "NOT_REGISTERED";
      readonly target: InstallTarget;
      readonly path: string;
    }
  | {
      readonly status: "FAILED";
      readonly target: InstallTarget;
      readonly path: string;
      readonly reason: InstallInspectionFailureReason;
    };

export interface InspectInstallDependencies extends InstallPathContext {
  readonly target: InstallTarget;
  readonly fileSystem: Pick<ConfigFileSystem, "readFile" | "fileExists">;
}
