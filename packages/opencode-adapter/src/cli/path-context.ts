import type { HostCliContext } from "@jevguard/node-infra";
import type { InstallPathContext } from "../opencode-config/types";

export function pathContext(context: HostCliContext): InstallPathContext {
  return {
    cwd: context.cwd,
    environment: { XDG_CONFIG_HOME: context.environment.xdgConfigHome },
    homedir: context.homedir,
  };
}
