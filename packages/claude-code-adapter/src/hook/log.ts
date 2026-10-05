import { appendFileSync, mkdirSync, readFileSync, statSync } from "node:fs";
import { dirname } from "node:path";
import { DIR_MODE, FILE_MODE, hookLogFileOf, writeAtomic } from "../capture/unit-state";
import type { HookLogEntry } from "./types";

export const MAX_HOOK_LOG_BYTES = 256 * 1024;

const RETAINED_BYTES = MAX_HOOK_LOG_BYTES / 2;

function newestLines(contents: string): string {
  const lines = contents.split("\n").filter((line) => line !== "");
  const kept: string[] = [];
  let bytes = 0;

  for (let index = lines.length - 1; index >= 0; index -= 1) {
    const line = lines[index] ?? "";

    bytes += Buffer.byteLength(line) + 1;

    if (bytes > RETAINED_BYTES) break;

    kept.unshift(line);
  }

  return kept.length === 0 ? "" : `${kept.join("\n")}\n`;
}

/** Appends one hook-log entry; never throws. */
export function appendHookLog(stateDirectory: string, entry: HookLogEntry): void {
  appendBoundedLog(hookLogFileOf(stateDirectory), entry);
}

/** Appends one JSON line and bounds the file by rewriting its newest lines; never throws. */
export function appendBoundedLog(file: string, entry: object): void {
  try {
    mkdirSync(dirname(file), { recursive: true, mode: DIR_MODE });
    appendFileSync(file, `${JSON.stringify(entry)}\n`, { mode: FILE_MODE });

    if (statSync(file).size > MAX_HOOK_LOG_BYTES) {
      writeAtomic(file, newestLines(readFileSync(file, "utf8")));
    }
  } catch {
    return;
  }
}
