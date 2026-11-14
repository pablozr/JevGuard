import type { RemediationUserSettingsRules, UserConfigEnvironment } from "../remediation";

export type HostId = "opencode" | "claude-code";

export type HostCheckStatus = "OK" | "WARN" | "FAIL";

export interface ProcessRequest {
  /** A safe token naming the executable. */
  readonly command: string;
  /** Constant arguments only; each must match the safe-argument allowlist. */
  readonly args: readonly string[];
  readonly timeoutMs: number;
}

export type ProcessResult =
  | { readonly kind: "EXITED"; readonly exitCode: number; readonly stdout: string }
  | { readonly kind: "NOT_FOUND" }
  | { readonly kind: "TIMED_OUT" }
  | { readonly kind: "REJECTED_ARGUMENT" }
  | { readonly kind: "FAILED" };

/** Runs a host command. It never exposes stderr and never receives user-provided text. */
export interface ProcessRunner {
  run(request: ProcessRequest): Promise<ProcessResult>;
}

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

/** Text file port. Absence is `null` rather than a thrown ENOENT. */
export interface TextFileSystem {
  readText(path: string): Promise<string | null>;
  exists(path: string): Promise<boolean>;
  writeTextAtomic(path: string, text: string): Promise<void>;
  makeDirectory(path: string): Promise<void>;
}

export interface HostCliContext {
  readonly cwd: string;
  readonly projectRoot: string;
  readonly homedir: string;
  readonly environment: UserConfigEnvironment;
  /** Reads one process environment variable (a host's own config-dir override, for example). */
  readonly variable: (name: string) => string | undefined;
  readonly processes: ProcessRunner;
  readonly files: TextFileSystem;
  readonly confirmation: ConfirmationPrompt;
}

export interface HostDetection {
  readonly host: HostId;
  readonly status: "SUPPORTED" | "UNSUPPORTED" | "UNKNOWN_VERSION" | "NOT_FOUND";
  readonly version: string | null;
  readonly supportedRange: string;
}

export type HostInstallScope = "global" | "project";

export type HostInstallState = "INSTALLED" | "NOT_INSTALLED" | "UNKNOWN";

export interface HostInstallInspection {
  readonly state: HostInstallState;
  /** A path or a short registration label; never file contents. */
  readonly target: string;
}

export interface HostInstallOutcome {
  readonly status: "CHANGED" | "UNCHANGED" | "DECLINED" | "FAILED";
  readonly code: string;
  /** Final text, already redacted by the extension. */
  readonly lines: readonly string[];
}

/** A doctor message and its optional annotation, before it becomes a check. */
export interface DescribedCheck {
  readonly message: string;
  readonly annotation: string | null;
}

/** Which `<command> --version` to run and which range makes the host supported. */
export interface HostVersionProbe {
  readonly host: HostId;
  readonly command: string;
  readonly range: string;
  readonly timeoutMs: number;
}

/** How a host's version check is named and worded in `doctor`. */
export interface HostVersionCheckLabels {
  readonly id: string;
  readonly displayName: string;
  readonly command: string;
}

export interface HostDoctorCheckJson {
  /** At most 16 characters, so it fits the report's id column. */
  readonly id: string;
  readonly status: HostCheckStatus;
  readonly code: string;
  readonly [field: string]: unknown;
}

export interface HostDoctorCheck {
  readonly json: HostDoctorCheckJson;
  readonly message: string;
  readonly annotation: string | null;
}

/** Contract each host implements for the host-neutral CLI. It never writes to stdout or stderr. */
export interface HostCliExtension {
  readonly id: HostId;
  readonly displayName: string;
  readonly userConfigFileName: string;
  readonly remediationRules: RemediationUserSettingsRules;
  detect(context: HostCliContext): Promise<HostDetection>;
  inspectInstall(context: HostCliContext, scope: HostInstallScope): Promise<HostInstallInspection>;
  /** Asks through `context.confirmation` exactly once before changing anything. */
  install(context: HostCliContext, scope: HostInstallScope): Promise<HostInstallOutcome>;
  doctor(context: HostCliContext): Promise<readonly HostDoctorCheck[]>;
}
