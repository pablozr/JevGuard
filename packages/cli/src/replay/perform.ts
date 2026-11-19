import {
  createDefaultJevPort,
  createNodePolicyFileSystem,
  createPolicyFileLoader,
  parsePolicyConfig,
} from "@jevguard/node-infra";

import { resolveProjectRoot } from "../project-root";
import { executeReplay } from "./execute";
import { createGitCommitReader } from "./git";
import type { ReplayRequest, ReplayResult } from "./types";

/**
 * Composes `replay` with the local Git history, the project policy and the normal Jev
 * port. It records no review history and never starts remediation.
 */
export function performReplay(request: ReplayRequest): Promise<ReplayResult> {
  return executeReplay(request, {
    readHistory: createGitCommitReader(),
    policy: createPolicyFileLoader({
      root: resolveProjectRoot(process.cwd()),
      fileSystem: createNodePolicyFileSystem(),
    }),
    parseConfig: parsePolicyConfig,
    jev: createDefaultJevPort(),
  });
}
