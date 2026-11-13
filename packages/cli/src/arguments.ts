import type { HostId, HostInstallScope } from "@jevguard/node-infra";
import { DEFAULT_HOST, isHostId } from "./hosts";
import type { HostCommandArguments } from "./types";

/** The registered host id that follows the `--host` flag at `index`, or `null`. */
export function readHostFlag(args: readonly string[], index: number): HostId | null {
  const value = args[index + 1];

  return value !== undefined && isHostId(value) ? value : null;
}

/**
 * Parses the flags of `install` (`--project`, `--host <id>`) and `doctor` (`--json`,
 * `--host <id>`). Anything else, a repeated flag, or an unknown host is `null`; the
 * offending token is never echoed.
 */
export function parseHostCommandArguments(
  args: readonly string[],
  allowed: { readonly project: boolean; readonly json: boolean },
): HostCommandArguments | null {
  let host: HostId | null = null;
  let scope: HostInstallScope = "global";
  let json = false;
  let sawProject = false;

  for (let index = 0; index < args.length; index += 1) {
    const token = args[index];

    if (token === "--project" && allowed.project && !sawProject) {
      sawProject = true;
      scope = "project";
    } else if (token === "--json" && allowed.json && !json) {
      json = true;
    } else if (token === "--host" && host === null) {
      host = readHostFlag(args, index);

      if (host === null) return null;

      index += 1;
    } else {
      return null;
    }
  }

  return { host: host ?? DEFAULT_HOST, scope, json };
}
