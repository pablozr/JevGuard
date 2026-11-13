import type { AgentDeliveryInput, HostCliExtension } from "@jevguard/node-infra";
import type { SetupPorts } from "./types";

export function agentDeliveryInputOf(
  ports: SetupPorts,
  extension: HostCliExtension,
): AgentDeliveryInput {
  const { context } = ports;

  return {
    environment: context.environment,
    fileName: extension.userConfigFileName,
    rules: extension.remediationRules,
    projectRoot: context.projectRoot,
    probe: ports.probe,
    files: context.files,
  };
}
