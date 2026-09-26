import type { InstallOutcome, InstallTarget } from "@jevguard/opencode-adapter";
import {
  createConfirmationPrompt,
  createNodeConfigFileSystem,
  install,
} from "@jevguard/opencode-adapter";
import { homedir } from "node:os";

export function performInstall(target: InstallTarget): Promise<InstallOutcome> {
  return install({
    confirmation: createConfirmationPrompt(),
    fileSystem: createNodeConfigFileSystem(),
    target,
    cwd: process.cwd(),
    environment: process.env,
    homedir: homedir(),
  });
}
