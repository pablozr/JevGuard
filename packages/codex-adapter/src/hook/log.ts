import {
  appendFileSync,
  mkdirSync,
  readFileSync,
  renameSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import { DIR_MODE, FILE_MODE, hookLogFileOf } from "./state";
import type { CodexHookLogEntry } from "./types";

/**
 * The hook's own log: a closed code, the host's event name and a timestamp, one JSON line
 * per event. It never carries the task, a tool input, a path, a diff or a finding — those
 * never leave the decoder — and a full log keeps its newest lines instead of growing.
 */

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

/** Appends one entry; never throws, so a hook can always exit quietly. */
export function appendHookLog(dataDirectory: string, entry: CodexHookLogEntry): void {
  const file = hookLogFileOf(dataDirectory);

  try {
    mkdirSync(join(dataDirectory), { recursive: true, mode: DIR_MODE });
    appendFileSync(file, `${JSON.stringify(entry)}\n`, { mode: FILE_MODE });
  } catch {
    return;
  }

  try {
    if (statSync(file).size > MAX_HOOK_LOG_BYTES) {
      const temporary = `${file}.tmp`;

      writeFileSync(temporary, newestLines(readFileSync(file, "utf8")), { mode: FILE_MODE });
      renameSync(temporary, file);
    }
  } catch {}
}
