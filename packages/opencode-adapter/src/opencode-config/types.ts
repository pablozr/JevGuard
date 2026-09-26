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

export type ConfirmationResult =
  | { readonly status: "CONFIRMED" }
  | { readonly status: "DECLINED" }
  | { readonly status: "FAILED"; readonly reason: "NOT_A_TTY" };

/**
 * Interactive confirmation port. Implementations default to declining when they
 * cannot ask, so a missing terminal never turns into a write.
 */
export interface ConfirmationPrompt {
  confirm(message: string): Promise<ConfirmationResult>;
}

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
  | { readonly status: "PRESENT" }
  | { readonly status: "INVALID_SHAPE" };
