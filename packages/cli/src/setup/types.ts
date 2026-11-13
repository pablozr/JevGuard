import type { CredentialProvider, CredentialSource } from "@jevguard/core";
import type {
  AgentDeliveryInspection,
  HostCliContext,
  HostCliExtension,
  HostDetection,
  HostId,
  HostInstallScope,
  LoginOutcome,
  ProjectProbe,
} from "@jevguard/node-infra";

export interface SetupRequest {
  /** `null` selects every registered host that is installed and supported. */
  readonly host: HostId | null;
  readonly scope: HostInstallScope;
  readonly init: boolean;
  readonly agentDelivery: boolean;
  readonly yes: boolean;
}

export interface SetupPorts {
  readonly context: HostCliContext;
  readonly extensions: readonly HostCliExtension[];
  readonly probe: ProjectProbe;
  readonly credentials: CredentialProvider;
  readonly login: () => Promise<LoginOutcome>;
}

export type SetupStepStatus = "PENDING" | "DONE" | "SKIPPED";

interface StepBase {
  readonly status: SetupStepStatus;
}

export interface InstallStep extends StepBase {
  readonly kind: "INSTALL";
  readonly extension: HostCliExtension;
  readonly scope: HostInstallScope;
}

export interface CredentialStep extends StepBase {
  readonly kind: "CREDENTIAL";
  /** Where an available credential comes from; `null` when none is stored. */
  readonly source: CredentialSource | null;
}

export interface AgentDeliveryStep extends StepBase {
  readonly kind: "AGENT_DELIVERY";
  readonly extension: HostCliExtension;
  /** What enabling `delivery: agent` would do, and in which user file. */
  readonly inspection: AgentDeliveryInspection;
  /** An offered step needs an interactive yes; a requested one (`--agent-delivery`) does not. */
  readonly requested: boolean;
}

export interface PolicyStep extends StepBase {
  readonly kind: "POLICY";
  /** The starter rules file this step would create. */
  readonly path: string;
  /** An offered step needs an interactive yes; a requested one (`--init`) does not. */
  readonly requested: boolean;
}

export interface HostStep extends StepBase {
  readonly kind: "HOST";
  readonly extension: HostCliExtension;
  readonly detection: HostDetection;
}

export type SetupStep = CredentialStep | InstallStep | AgentDeliveryStep | PolicyStep | HostStep;

export interface SetupPlan {
  readonly steps: readonly SetupStep[];
}

export type SetupStatus = "APPLIED" | "NOTHING_TO_DO" | "NOT_CONFIRMED" | "FAILED" | "NO_HOST";

export interface SetupResult {
  readonly status: SetupStatus;
  readonly lines: readonly string[];
}
