import { stateDirectoryOf } from "../capture/unit-state";
import { appendHookLog } from "./log";
import { createProcessDependencies } from "./process-dependencies";
import { readLimitedStdin } from "./read-stdin";
import { runHook } from "./run-hook";

function recordFailure(code: "INTERNAL" | "STDIN_TOO_LARGE"): void {
  const pluginData = process.env.CLAUDE_PLUGIN_DATA;

  process.exitCode = 0;

  if (pluginData === undefined || pluginData === "") return;

  appendHookLog(stateDirectoryOf(pluginData), {
    timestamp: new Date().toISOString(),
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

  runHook(stdin, createProcessDependencies());
}

main().catch(recordInternalFailure);
