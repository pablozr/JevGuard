import type { ReviewReport } from "@jevguard/core";
import type { LoginOutcome } from "@jevguard/node-infra";
import type { InstallOutcome, InstallTarget } from "@jevguard/opencode-adapter";
import type { DoctorReport } from "./doctor/types";
import type { FeedbackListResult, FeedbackMarkRequest, FeedbackMarkResult } from "./feedback/types";
import type { RulesCheckRequest, RulesCheckResult } from "./rules-check/types";

export interface CliIO {
  readonly writeOut: (message: string) => void;
  readonly writeErr: (message: string) => void;
}

export interface CliDependencies {
  readonly login: () => Promise<LoginOutcome>;
  readonly install: (target: InstallTarget) => Promise<InstallOutcome>;
  readonly report: () => Promise<ReviewReport>;
  readonly doctor: () => Promise<DoctorReport>;
  readonly rulesCheck: (request: RulesCheckRequest) => Promise<RulesCheckResult>;
  readonly feedbackList: () => Promise<FeedbackListResult>;
  readonly feedbackMark: (request: FeedbackMarkRequest) => Promise<FeedbackMarkResult>;
}
