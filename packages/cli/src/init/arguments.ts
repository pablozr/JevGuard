import type { HostId, HostInstallScope } from "@jevguard/node-infra";
import { readHostFlag } from "../arguments";
import { DEFAULT_HOST } from "../hosts";
import type { InitRequest } from "./types";

/**
 * Parses the flags of `init`: `--host <id>` and `--global` (the default scope is the
 * project). Anything else, a repeated flag, or an unknown host is `null`; the offending
 * token is never echoed.
 */
export function parseInitArguments(args: readonly string[]): InitRequest | null {
  let host: HostId | null = null;
  let scope: HostInstallScope = "project";
  let sawGlobal = false;

  for (let index = 0; index < args.length; index += 1) {
    const token = args[index];

    if (token === "--global" && !sawGlobal) {
      sawGlobal = true;
      scope = "global";
    } else if (token === "--host" && host === null) {
      host = readHostFlag(args, index);

      if (host === null) return null;

      index += 1;
    } else {
      return null;
    }
  }

  return { host: host ?? DEFAULT_HOST, scope };
}
