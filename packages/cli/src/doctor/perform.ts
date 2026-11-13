import {
  createDefaultCredentialProvider,
  createNodePolicyFileSystem,
  createPolicyFileLoader,
  type HostCliContext,
  type HostDoctorCheck,
  type HostId,
  parsePolicyConfig,
} from "@jevguard/node-infra";
import { createHostContext } from "../host-context";
import { extensionFor } from "../hosts";
import { diagnose } from "./diagnose";
import type { DoctorRun } from "./types";

/**
 * Composes the real local diagnosis. It reads the credential provider the review uses, the fixed `.jev`
 * files and the selected host extensions' checks only: it never creates a Jev transport and never
 * writes.
 */
export async function performDoctor(hosts: readonly HostId[]): Promise<DoctorRun> {
  const context = createHostContext();
  const hostChecks = await collectHostChecks(context, hosts);
  const report = await diagnose({
    projectRoot: context.projectRoot,
    credentials: createDefaultCredentialProvider(),
    policy: createPolicyFileLoader({
      root: context.projectRoot,
      fileSystem: createNodePolicyFileSystem(),
    }),
    parseConfig: parsePolicyConfig,
    hostChecks,
  });

  return { report, hostChecks };
}

async function collectHostChecks(
  context: HostCliContext,
  hosts: readonly HostId[],
): Promise<readonly HostDoctorCheck[]> {
  const groups = await Promise.all(hosts.map((host) => extensionFor(host).doctor(context)));

  return groups.flat();
}
