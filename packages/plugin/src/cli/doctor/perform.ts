import {
  createNodePolicyFileSystem,
  createPolicyFileLoader,
  parsePolicyConfig,
} from "@jevguard/node-infra";
import { createNodeConfigFileSystem, inspectInstall } from "@jevguard/opencode-adapter";
import { homedir } from "node:os";
import { createDefaultCredentialProvider } from "../../jev-port";
import { resolveProjectRoot } from "../project-root";
import { diagnose } from "./diagnose";
import type { DoctorReport } from "./types";

/**
 * Composes the real local diagnosis. It reads the credential provider the review uses, the fixed `.jev`
 * files and the OpenCode configs only: it never creates a Jev transport and never
 * writes.
 */
export function performDoctor(): Promise<DoctorReport> {
  const projectRoot = resolveProjectRoot(process.cwd());
  const fileSystem = createNodeConfigFileSystem();

  return diagnose({
    projectRoot,
    credentials: createDefaultCredentialProvider(),
    policy: createPolicyFileLoader({ root: projectRoot, fileSystem: createNodePolicyFileSystem() }),
    parseConfig: parsePolicyConfig,
    inspectOpenCode: (target) =>
      inspectInstall({
        target,
        fileSystem,
        cwd: process.cwd(),
        environment: process.env,
        homedir: homedir(),
      }),
  });
}
