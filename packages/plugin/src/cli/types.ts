import type { ReviewReport } from "@jevguard/core";
import type { LoginOutcome } from "@jevguard/node-infra";
import type { InstallOutcome, InstallTarget } from "@jevguard/opencode-adapter";

export interface CliIO {
  readonly writeOut: (message: string) => void;
  readonly writeErr: (message: string) => void;
}

export interface CliDependencies {
  readonly login: () => Promise<LoginOutcome>;
  readonly install: (target: InstallTarget) => Promise<InstallOutcome>;
  readonly report: () => Promise<ReviewReport>;
}
