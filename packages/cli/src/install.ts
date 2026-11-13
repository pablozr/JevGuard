import type { HostId, HostInstallOutcome, HostInstallScope } from "@jevguard/node-infra";
import { createHostContext } from "./host-context";
import { extensionFor } from "./hosts";

export function performInstall(host: HostId, scope: HostInstallScope): Promise<HostInstallOutcome> {
  return extensionFor(host).install(createHostContext(), scope);
}
