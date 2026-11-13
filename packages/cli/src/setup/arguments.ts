import type { HostId, HostInstallScope } from "@jevguard/node-infra";
import { readHostFlag } from "../arguments";
import type { SetupRequest } from "./types";

const FLAGS = ["--project", "--init", "--yes", "--agent-delivery"] as const;

type Flag = (typeof FLAGS)[number];

function isFlag(token: string | undefined): token is Flag {
  return FLAGS.some((flag) => flag === token);
}

/**
 * Parses `setup [--host <id>] [--project] [--init] [--yes] [--agent-delivery]`. Anything
 * else, a repeated flag, or an unknown host is `null`; the offending token is never echoed.
 */
export function parseSetupArguments(args: readonly string[]): SetupRequest | null {
  const seen = new Set<string>();
  let host: HostId | null = null;

  for (let index = 0; index < args.length; index += 1) {
    const token = args[index];

    if (token === "--host" && host === null) {
      host = readHostFlag(args, index);

      if (host === null) return null;

      index += 1;
    } else if (isFlag(token) && !seen.has(token)) {
      seen.add(token);
    } else {
      return null;
    }
  }

  const scope: HostInstallScope = seen.has("--project") ? "project" : "global";

  return {
    host,
    scope,
    init: seen.has("--init"),
    yes: seen.has("--yes"),
    agentDelivery: seen.has("--agent-delivery"),
  };
}
