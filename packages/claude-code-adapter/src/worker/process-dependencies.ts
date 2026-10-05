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
import { appendWorkerLog } from "./log";
import { createNodeWorkerFileSystem, createTimerDeadline } from "./node-ports";
import type { WorkerDependencies } from "./types";

const JEV_MAX_CONCURRENCY = 2;

/** Real-process wiring of the worker: handoff files, local history, policy, credential and Jev. */
export function createProcessWorkerDependencies(stateDirectory: string): WorkerDependencies {
  const now = () => new Date();
  const jevFor = () =>
    createFifoJevPort(
      createTypeSafeJevTransport(
        createCredentialProvider({
          environment: createProcessEnvironment(),
          store: createKeyringCredentialStore(),
        }),
      ),
      { maxConcurrency: JEV_MAX_CONCURRENCY },
    );

  return {
    handoffDirectory: handoffDirectoryOf(stateDirectory),
    files: createNodeWorkerFileSystem(),
    now,
    history: createLocalReviewHistory({
      context: createProcessReviewHistoryContext(),
      fileSystem: createNodeReviewHistoryFileSystem(),
      now,
    }),
    policyFor: (projectRoot) =>
      createPolicyFileLoader({ root: projectRoot, fileSystem: createNodePolicyFileSystem() }),
    parseConfig: parsePolicyConfig,
    jevFor,
    deadline: createTimerDeadline(),
    log: (code) => appendWorkerLog(stateDirectory, { timestamp: now().toISOString(), code }),
  };
}
