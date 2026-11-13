import { detectHostVersion, type HostCliContext, type HostDetection } from "@jevguard/node-infra";
import { OPENCODE_ENGINE_RANGE } from "../opencode-config/version";
import { OPENCODE_COMMAND, OPENCODE_VERSION_TIMEOUT_MS } from "./constants";

export function detectOpenCode(context: Pick<HostCliContext, "processes">): Promise<HostDetection> {
  return detectHostVersion(context.processes, {
    host: "opencode",
    command: OPENCODE_COMMAND,
    range: OPENCODE_ENGINE_RANGE,
    timeoutMs: OPENCODE_VERSION_TIMEOUT_MS,
  });
}
