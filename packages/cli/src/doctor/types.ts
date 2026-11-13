import type {
  CredentialProvider,
  PolicyConfigParser,
  PolicyLoader,
  RuleParseErrorCode,
} from "@jevguard/core";
import type { HostDoctorCheck, HostDoctorCheckJson } from "@jevguard/node-infra";

export type DoctorStatus = "OK" | "WARN" | "FAIL";

export type CredentialCheckCode =
  | "CREDENTIAL_STORE"
  | "CREDENTIAL_ENVIRONMENT"
  | "MISSING_CREDENTIAL"
  | "STORE_READ_FAILURE";

export type RulesCheckCode =
  | "RULES_VALID"
  | "RULES_INVALID"
  | "RULES_MISSING"
  | "RULES_READ_FAILURE"
  | "RULES_NOT_CHECKED";

export type ConfigCheckCode =
  | "CONFIG_DEFAULTS"
  | "CONFIG_VALID"
  | "CONFIG_PARSE_INVALID"
  | "CONFIG_INVALID"
  | "REMEDIATION_INVALID"
  | "CONFIG_READ_FAILURE"
  | "CONFIG_NOT_CHECKED";

export interface InvalidRuleSummary {
  readonly ruleId: string | null;
  readonly code: RuleParseErrorCode;
}

export type CredentialCheck = {
  readonly id: "credential";
  readonly status: DoctorStatus;
  readonly code: CredentialCheckCode;
};

export type RulesCheck = {
  readonly id: "rules";
  readonly status: DoctorStatus;
  readonly code: RulesCheckCode;
  readonly path: string;
  readonly ruleIds: readonly string[];
  readonly invalidRules: readonly InvalidRuleSummary[];
};

export type ConfigCheck = {
  readonly id: "config";
  readonly status: DoctorStatus;
  readonly code: ConfigCheckCode;
  readonly path: string;
};

export type DoctorCheck = CredentialCheck | RulesCheck | ConfigCheck;

/** A shared check or one a host extension contributed; both are plain JSON. */
export type DoctorReportCheck = DoctorCheck | HostDoctorCheckJson;

/** Local, network-free diagnosis. It carries typed codes and paths only, never a credential. */
export interface DoctorReport {
  readonly version: 1;
  readonly projectRoot: string;
  readonly status: DoctorStatus;
  readonly checks: readonly DoctorReportCheck[];
}

export interface DoctorDependencies {
  readonly projectRoot: string;
  readonly credentials: CredentialProvider;
  readonly policy: PolicyLoader;
  readonly parseConfig: PolicyConfigParser;
  /** Checks already produced by the selected host extensions, in report order. */
  readonly hostChecks: readonly HostDoctorCheck[];
}

/** The report plus the human text of the host checks, which JSON output leaves out. */
export interface DoctorRun {
  readonly report: DoctorReport;
  readonly hostChecks: readonly HostDoctorCheck[];
}
