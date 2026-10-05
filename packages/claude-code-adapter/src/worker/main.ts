import { stateDirectoryOf } from "../capture/unit-state";
import { appendWorkerLog } from "./log";
import { createProcessWorkerDependencies } from "./process-dependencies";
import { runWorker } from "./run-worker";

const WORKER_CEILING_MS = 15 * 60 * 1000;

async function main(): Promise<void> {
  const pluginData = process.env.CLAUDE_PLUGIN_DATA;

  if (pluginData === undefined || pluginData === "") return;

  const stateDirectory = stateDirectoryOf(pluginData);

  try {
    await runWorker(createProcessWorkerDependencies(stateDirectory));
  } catch {
    appendWorkerLog(stateDirectory, {
      timestamp: new Date().toISOString(),
      code: "WORKER_FAILED",
    });
  }
}

setTimeout(() => process.exit(0), WORKER_CEILING_MS).unref();

main()
  .catch(() => undefined)
  .finally(() => process.exit(0));
