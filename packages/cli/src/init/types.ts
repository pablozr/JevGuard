import type {
  HostCliContext,
  HostCliExtension,
  HostDetection,
  HostId,
  HostInstallOutcome,
  HostInstallScope,
} from "@jevguard/node-infra";

export interface InitRequest {
  /** The host to set up; the default host when no `--host` is given. */
  readonly host: HostId;
  readonly scope: HostInstallScope;
}

export interface InitPorts {
  readonly context: HostCliContext;
  readonly extensions: readonly HostCliExtension[];
}

export type RulesOutcome = "CREATED" | "EXISTS" | "WRITE_FAILED";

export interface InitResult {
  readonly status: "CREATED" | "ALREADY" | "NO_HOST" | "FAILED";
  readonly host: HostId;
  readonly detection: HostDetection;
  /** `null` when the host was not set up, so no rules file was needed. */
  readonly install: HostInstallOutcome | null;
  readonly rules: RulesOutcome | null;
  readonly rulesPath: string;
  readonly lines: readonly string[];
}
