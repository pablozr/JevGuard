import { createFileHandoffSink } from "../capture/handoff-store";
import {
  createNodeFileReader,
  createProcessEnvironment,
  removeTree,
  runGit,
} from "../capture/node-ports";
import type { HookDependencies } from "./types";

/** Real-process wiring of the hook: environment, filesystem, Git, clock and handoff files. */
export function createProcessDependencies(): HookDependencies {
  const environment = createProcessEnvironment(process.env);

  return {
    environment,
    files: createNodeFileReader(),
    git: runGit,
    now: () => new Date(),
    monotonicNow: () => performance.now(),
    removePath: removeTree,
    createHandoffSink: createFileHandoffSink,
  };
}
