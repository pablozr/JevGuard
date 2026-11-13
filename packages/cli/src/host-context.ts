import { homedir } from "node:os";
import type { HostCliContext } from "@jevguard/node-infra";
import {
  createConfirmationPrompt,
  createNodeProcessRunner,
  createNodeTextFileSystem,
  userConfigEnvironmentOf,
} from "@jevguard/node-infra";
import { resolveProjectRoot } from "./project-root";

/** The real process context a host extension runs in. */
export function createHostContext(): HostCliContext {
  const cwd = process.cwd();

  return {
    cwd,
    projectRoot: resolveProjectRoot(cwd),
    homedir: homedir(),
    environment: userConfigEnvironmentOf({ get: (name) => process.env[name] }),
    processes: createNodeProcessRunner(),
    files: createNodeTextFileSystem(),
    confirmation: createConfirmationPrompt(),
  };
}
