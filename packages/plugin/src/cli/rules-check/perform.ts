import {
  createNodePolicyFileSystem,
  createPolicyFileLoader,
  parsePolicyConfig,
} from "@jevguard/node-infra";
import { createDefaultJevPort } from "../../jev-port";
import { resolveProjectRoot } from "../project-root";
import { executeRulesCheck } from "./execute";
import { createNodeDiffReader } from "./read-diff";
import type { RulesCheckRequest, RulesCheckResult } from "./types";

/**
 * Composes the real on-demand rule check with the normal credential and Jev port.
 * It records no review history and never starts remediation.
 */
export function performRulesCheck(request: RulesCheckRequest): Promise<RulesCheckResult> {
  return executeRulesCheck(request, {
    readDiff: createNodeDiffReader(),
    policy: createPolicyFileLoader({
      root: resolveProjectRoot(process.cwd()),
      fileSystem: createNodePolicyFileSystem(),
    }),
    parseConfig: parsePolicyConfig,
    jev: createDefaultJevPort(),
  });
}
