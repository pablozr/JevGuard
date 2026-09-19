import type { LoginOutcome } from "@jevguard/opencode-adapter";

export interface CliIO {
  readonly writeOut: (message: string) => void;
  readonly writeErr: (message: string) => void;
}

export interface CliDependencies {
  readonly login: () => Promise<LoginOutcome>;
}
