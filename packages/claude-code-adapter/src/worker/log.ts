import { join } from "node:path";
import { appendBoundedLog } from "../hook/log";
import type { WorkerLogEntry } from "./types";

export function workerLogFileOf(stateDirectory: string): string {
  return join(stateDirectory, "worker-log.jsonl");
}

/** Appends one closed-code entry to the bounded worker log; never throws. */
export function appendWorkerLog(stateDirectory: string, entry: WorkerLogEntry): void {
  appendBoundedLog(workerLogFileOf(stateDirectory), entry);
}
