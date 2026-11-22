import type { EnforceGateLogCode, EnforceStopOutput } from "../enforce/types";
import { stateDirectoryOf } from "../capture/unit-state";
import { writeDecisionOutput } from "./decision-output";
import { appendHookLog } from "./log";
import type { HookDependencies } from "./types";
import { createProcessDependencies } from "./process-dependencies";
import { readLimitedStdin } from "./read-stdin";
import { HOOK_BUDGET_MS, runHook, type HookResult } from "./run-hook";

/** Room left inside the hook's own allowance for the decision to be printed and exit. */
const ENFORCE_EXIT_MARGIN_MS = 1000;

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

function stopLogger(dependencies: HookDependencies): ((code: EnforceGateLogCode) => void) | null {
  const pluginData = dependencies.environment.get("CLAUDE_PLUGIN_DATA");

  if (pluginData === undefined || pluginData === "") return null;

  const stateDirectory = stateDirectoryOf(pluginData);

  return (code) =>
    appendHookLog(stateDirectory, {
      timestamp: dependencies.now().toISOString(),
      event: "Stop",
      code,
    });
}

/**
 * Applies the opt-in `Stop` gate to a closing event. The gate is loaded only here, so
 * the hooks that run on every tool call keep their small startup; everything it needs
 * is local (the user's file and the review history), and any failure is a no-block.
 */
async function enforceDecision(
  result: HookResult,
  dependencies: HookDependencies,
  startedAt: number,
): Promise<EnforceStopOutput | null> {
  if (result.event?.name !== "Stop" || result.closed === null) return null;

  const report = stopLogger(dependencies);

  if (report === null) return null;

  try {
    const { createProcessEnforceStop } = await import("../enforce/process-stop");
    const gate = createProcessEnforceStop({
      environment: dependencies.environment,
      files: dependencies.files,
      now: dependencies.now,
      monotonicNow: dependencies.monotonicNow,
      sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
    });

    return await gate.run(
      { event: result.event, closed: result.closed },
      () => HOOK_BUDGET_MS - (dependencies.monotonicNow() - startedAt) - ENFORCE_EXIT_MARGIN_MS,
      report,
    );
  } catch {
    report("ENFORCE_GATE_FAILED");

    return null;
  }
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

  const dependencies = createProcessDependencies();
  const startedAt = dependencies.monotonicNow();
  const result = runHook(stdin, dependencies);
  const decision = await enforceDecision(result, dependencies, startedAt);

  if (decision === null) return;

  if (!writeDecisionOutput(JSON.stringify(decision))) {
    stopLogger(dependencies)?.("ENFORCE_OUTPUT_FAILED");
  }
}

main().catch(recordInternalFailure);
