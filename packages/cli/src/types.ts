import type { ReviewReport } from "@jevguard/core";
import type {
  HostId,
  HostInstallOutcome,
  HostInstallScope,
  LoginOutcome,
} from "@jevguard/node-infra";
import type { AckListResult, AckResult } from "./ack/types";
import type { CheckRequest, CheckResult } from "./check/types";
import type { DoctorRun } from "./doctor/types";
import type { FeedbackListResult, FeedbackMarkRequest, FeedbackMarkResult } from "./feedback/types";
import type { InitRequest, InitResult } from "./init/types";
import type { ReplayRequest, ReplayResult } from "./replay/types";
import type { RulesCheckRequest, RulesCheckResult } from "./rules-check/types";
import type { SetupRequest, SetupResult } from "./setup/types";

export interface CliIO {
  readonly writeOut: (message: string) => void;
  readonly writeErr: (message: string) => void;
}

export interface CliDependencies {
  readonly login: () => Promise<LoginOutcome>;
  readonly install: (host: HostId, scope: HostInstallScope) => Promise<HostInstallOutcome>;
  readonly setup: (request: SetupRequest) => Promise<SetupResult>;
  readonly init: (request: InitRequest) => Promise<InitResult>;
  readonly replay: (request: ReplayRequest) => Promise<ReplayResult>;
  readonly check: (request: CheckRequest) => Promise<CheckResult>;
  readonly report: () => Promise<ReviewReport>;
  readonly doctor: (hosts: readonly HostId[]) => Promise<DoctorRun>;
  readonly rulesCheck: (request: RulesCheckRequest) => Promise<RulesCheckResult>;
  readonly feedbackList: () => Promise<FeedbackListResult>;
  readonly feedbackMark: (request: FeedbackMarkRequest) => Promise<FeedbackMarkResult>;
  readonly ackList: () => Promise<AckListResult>;
  readonly ack: (number: number) => Promise<AckResult>;
}

/** Flags shared by `install` and `doctor`; `host` falls back to the default host. */
export interface HostCommandArguments {
  readonly host: HostId;
  readonly scope: HostInstallScope;
  readonly json: boolean;
}
