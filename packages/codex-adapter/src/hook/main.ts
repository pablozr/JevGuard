import { appendHookLog } from "./log";
import { readLimitedStdin } from "./read-stdin";
import { runCodexHook } from "./run-hook";
import { dataDirectoryOf } from "./state";

/**
 * The entrypoint the Codex hook command runs. A hook may never break the host's turn:
 * every failure becomes a logged code and the process still exits 0, silently.
 */

function recordFailure(code: "INTERNAL" | "STDIN_TOO_LARGE"): void {
  const pluginData = process.env.PLUGIN_DATA;

  process.exitCode = 0;

  if (pluginData === undefined || pluginData === "") return;

  appendHookLog(dataDirectoryOf(pluginData), {
    v: 1,
    at: new Date().toISOString(),
    event: "UNKNOWN",
    code,
  });
}

function recordInternalFailure(): void {
  recordFailure("INTERNAL");
}

async function main(): Promise<void> {
  process.exitCode = 0;
  process.on("uncaughtException", recordInternalFailure);
  process.on("unhandledRejection", recordInternalFailure);

  const stdin = await readLimitedStdin(process.stdin);

  if (stdin === null) {
    recordFailure("STDIN_TOO_LARGE");
    return;
  }

  runCodexHook(stdin, {
    environment: { get: (name) => process.env[name] },
    now: () => new Date(),
  });
}

main().catch(recordInternalFailure);
