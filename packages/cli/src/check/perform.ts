import {
  createDefaultJevPort,
  createNodePolicyFileSystem,
  createPolicyFileLoader,
  parsePolicyConfig,
} from "@jevguard/node-infra";

import { resolveProjectRoot } from "../project-root";
import { executeCheck } from "./execute";
import { createGitRangeReader } from "./git";
import type { CheckRequest, CheckResult } from "./types";

/**
 * Composes `check` with the local Git history, the project policy and the normal Jev
 * port. It records no review history and never starts remediation.
 */
export function performCheck(request: CheckRequest): Promise<CheckResult> {
  return executeCheck(request, {
    readRange: createGitRangeReader(),
    policy: createPolicyFileLoader({
      root: resolveProjectRoot(process.cwd()),
      fileSystem: createNodePolicyFileSystem(),
    }),
    parseConfig: parsePolicyConfig,
    jev: createDefaultJevPort(),
  });
}
