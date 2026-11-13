import {
  type AgentDeliveryInspectionStatus,
  type HostCliExtension,
  inspectAgentDelivery,
  policyFilePaths,
} from "@jevguard/node-infra";
import { resolveCredentialSafely } from "../credential";
import { agentDeliveryInputOf } from "./agent-delivery-input";
import { rulesExist } from "./scaffold";
import type {
  AgentDeliveryStep,
  CredentialStep,
  InstallStep,
  PolicyStep,
  SetupPlan,
  SetupPorts,
  SetupRequest,
  SetupStep,
  SetupStepStatus,
} from "./types";

function selectedExtensions(
  extensions: readonly HostCliExtension[],
  request: SetupRequest,
): readonly HostCliExtension[] {
  return request.host === null
    ? extensions
    : extensions.filter((extension) => extension.id === request.host);
}

async function installStep(
  ports: SetupPorts,
  extension: HostCliExtension,
  request: SetupRequest,
): Promise<InstallStep> {
  const inspection = await extension.inspectInstall(ports.context, request.scope);

  return {
    kind: "INSTALL",
    extension,
    scope: request.scope,
    status: inspection.state === "INSTALLED" ? "DONE" : "PENDING",
  };
}

async function deliveryStep(
  ports: SetupPorts,
  extension: HostCliExtension,
  request: SetupRequest,
): Promise<AgentDeliveryStep> {
  const inspection = await inspectAgentDelivery(agentDeliveryInputOf(ports, extension));

  return {
    kind: "AGENT_DELIVERY",
    extension,
    inspection,
    requested: request.agentDelivery,
    status: deliveryStatusOf(inspection.status),
  };
}

function deliveryStatusOf(status: AgentDeliveryInspectionStatus): SetupStepStatus {
  if (status === "WOULD_ENABLE") return "PENDING";

  return status === "ALREADY_ENABLED" ? "DONE" : "SKIPPED";
}

async function hostSteps(
  ports: SetupPorts,
  extension: HostCliExtension,
  request: SetupRequest,
): Promise<readonly SetupStep[]> {
  const detection = await extension.detect(ports.context);

  if (detection.status !== "SUPPORTED") {
    return [{ kind: "HOST", status: "SKIPPED", extension, detection }];
  }

  return Promise.all([
    installStep(ports, extension, request),
    deliveryStep(ports, extension, request),
  ]);
}

async function policyStep(ports: SetupPorts, request: SetupRequest): Promise<PolicyStep> {
  const { files, projectRoot } = ports.context;
  const present = await rulesExist(files, projectRoot);

  return {
    kind: "POLICY",
    requested: request.init,
    status: present ? "DONE" : "PENDING",
    path: policyFilePaths(projectRoot).rules,
  };
}

async function credentialStep(ports: SetupPorts): Promise<CredentialStep> {
  const resolution = await resolveCredentialSafely(ports.credentials);

  if (resolution.status === "AVAILABLE") {
    return { kind: "CREDENTIAL", source: resolution.source, status: "DONE" };
  }

  return { kind: "CREDENTIAL", source: null, status: "PENDING" };
}

/** Inspects the machine and lists what `setup` would do; it writes nothing. */
export async function buildSetupPlan(ports: SetupPorts, request: SetupRequest): Promise<SetupPlan> {
  const [credential, groups, policy] = await Promise.all([
    credentialStep(ports),
    Promise.all(
      selectedExtensions(ports.extensions, request).map((extension) =>
        hostSteps(ports, extension, request),
      ),
    ),
    policyStep(ports, request),
  ]);

  return { steps: [credential, ...groups.flat(), policy] };
}
