import { createFifoJevPort } from "@jevguard/core";
import {
  createCredentialProvider,
  createKeyringCredentialStore,
  createLocalReviewHistory,
  createNodePolicyFileSystem,
  createNodeReviewHistoryFileSystem,
  createPolicyFileLoader,
  createProcessEnvironment,
  createProcessReviewHistoryContext,
  createTypeSafeJevTransport,
  parsePolicyConfig,
} from "@jevguard/node-infra";
import { handoffDirectoryOf } from "../capture/unit-state";
import { createNodeReviewFeed } from "./feed";
import { appendWorkerLog } from "./log";
import { createNodeWorkerFileSystem, createTimerDeadline } from "./node-ports";
import { createNodeProposalStore } from "./remediation/proposal-store";
import { createUserRemediationSettings } from "./remediation/user-config";
import type { WorkerDependencies } from "./types";

const JEV_MAX_CONCURRENCY = 2;

/** Real-process wiring of the worker: handoff files, local history, policy, credential and Jev. */
export function createProcessWorkerDependencies(stateDirectory: string): WorkerDependencies {
  const now = () => new Date();
  const files = createNodeWorkerFileSystem();
  const environment = createProcessEnvironment();
  const jevFor = () =>
    createFifoJevPort(
      createTypeSafeJevTransport(
        createCredentialProvider({
          environment,
          store: createKeyringCredentialStore(),
        }),
      ),
      { maxConcurrency: JEV_MAX_CONCURRENCY },
    );

  return {
    handoffDirectory: handoffDirectoryOf(stateDirectory),
    files,
    now,
    feed: createNodeReviewFeed(environment, now, files),
    history: createLocalReviewHistory({
      context: createProcessReviewHistoryContext(),
      fileSystem: createNodeReviewHistoryFileSystem(),
      now,
    }),
    policyFor: (projectRoot) =>
      createPolicyFileLoader({ root: projectRoot, fileSystem: createNodePolicyFileSystem() }),
    parseConfig: parsePolicyConfig,
    remediationFor: createUserRemediationSettings(environment),
    proposals: createNodeProposalStore(environment, now, files),
    jevFor,
    deadline: createTimerDeadline(),
    log: (code) => appendWorkerLog(stateDirectory, { timestamp: now().toISOString(), code }),
  };
}
