import { isAbsolute, join } from "node:path";
import type { InstallPathContext, InstallTarget } from "./types";

const PROJECT_CONFIG_FILENAME = "opencode.json";

/** Resolves the target `opencode.json` path for the requested install target. */
export function resolveConfigPath(target: InstallTarget, context: InstallPathContext): string {
  if (target === "project") {
    return join(context.cwd, PROJECT_CONFIG_FILENAME);
  }

  return join(resolveConfigHome(context), "opencode", PROJECT_CONFIG_FILENAME);
}

function resolveConfigHome(context: InstallPathContext): string {
  const configured = context.environment.XDG_CONFIG_HOME;

  if (configured !== undefined && configured !== "" && isAbsolute(configured)) {
    return configured;
  }

  return join(context.homedir, ".config");
}
