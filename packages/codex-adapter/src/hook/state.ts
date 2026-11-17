import { createHash } from "node:crypto";
import {
  appendFileSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import { decodeStateLine, replayState } from "./state-codec";
import type { CodexSessionState, CodexStateLine } from "./types";

/**
 * The bounded local state one session's lifecycle lives in (Node builtins only).
 *
 * Nothing here is evidence of a change and nothing here is reviewed: the file records
 * which turn is open, which calls were seen on both halves, and the marks that make a
 * unit untrustworthy. It holds ids and codes, never a task, a path, a tool input or a
 * diff, and it is written owner-only where the platform allows.
 */

export const DIR_MODE = 0o700;
export const FILE_MODE = 0o600;

/** A session that stopped sending events for a day cannot be open any more. */
export const SESSION_TTL_MS = 24 * 60 * 60 * 1000;

export const MAX_LIFECYCLE_BYTES = 256 * 1024;

const RETAINED_BYTES = MAX_LIFECYCLE_BYTES / 2;

const NAMESPACE = "codex";

/** Host ids name no file: the directory is their digest, so no id reaches the path. */
export function keyOf(value: string): string {
  return createHash("sha256").update(value).digest("hex").slice(0, 32);
}

export function dataDirectoryOf(pluginDataDirectory: string): string {
  return join(pluginDataDirectory, NAMESPACE);
}

export function sessionDirectoryOf(dataDirectory: string, sessionId: string): string {
  return join(dataDirectory, "sessions", keyOf(sessionId));
}

export function lifecycleFileOf(sessionDirectory: string): string {
  return join(sessionDirectory, "lifecycle.jsonl");
}

/** The last time the hook ran for this session; `doctor` reads it to spot untrusted hooks. */
export function heartbeatFileOf(sessionDirectory: string): string {
  return join(sessionDirectory, "heartbeat");
}

export function hookLogFileOf(dataDirectory: string): string {
  return join(dataDirectory, "hook-log.jsonl");
}

function isMissingPath(error: unknown): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    (error as { readonly code?: unknown }).code === "ENOENT"
  );
}

function readLines(file: string): readonly (CodexStateLine | null)[] | "MISSING" {
  let contents: string;

  try {
    contents = readFileSync(file, "utf8");
  } catch (error) {
    if (isMissingPath(error)) return "MISSING";

    throw error;
  }

  return contents
    .split("\n")
    .filter((line) => line !== "")
    .map(decodeStateLine);
}

/** The session's replayed state; a missing file is an empty, undamaged session. */
export function readSessionState(sessionDirectory: string): CodexSessionState {
  const lines = readLines(lifecycleFileOf(sessionDirectory));

  if (lines === "MISSING") return { units: [], pendingTaints: [], damaged: false };

  return replayState(lines);
}

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

function writeAtomic(path: string, text: string): void {
  const temporary = `${path}.tmp`;

  writeFileSync(temporary, text, { mode: FILE_MODE });
  renameSync(temporary, path);
}

/**
 * Appends the event's lines as one write each, then bounds the file by keeping its newest
 * lines. Several hooks run at once on this host; an append is the only cross-process
 * write, and every rule is decided by replaying the file, so no reader holds a lock and
 * no update is a read-modify-write of another process's state.
 */
export function appendStateLines(sessionDirectory: string, lines: readonly CodexStateLine[]): void {
  if (lines.length === 0) return;

  mkdirSync(sessionDirectory, { recursive: true, mode: DIR_MODE });

  const file = lifecycleFileOf(sessionDirectory);
  const payload = lines.map((line) => `${JSON.stringify(line)}\n`).join("");

  appendFileSync(file, payload, { mode: FILE_MODE });

  if (statSync(file).size <= MAX_LIFECYCLE_BYTES) return;

  writeAtomic(file, newestLines(readFileSync(file, "utf8")));
}

/** Records that the hook ran for this session; a failure only costs the `doctor` hint. */
export function writeHeartbeat(sessionDirectory: string, now: Date): void {
  try {
    mkdirSync(sessionDirectory, { recursive: true, mode: DIR_MODE });
    writeAtomic(heartbeatFileOf(sessionDirectory), now.toISOString());
  } catch {}
}

/** Removes sessions that stopped sending events long ago; failures are contained. */
export function sweepExpiredSessions(
  dataDirectory: string,
  now: Date,
  keepSessionId: string,
): void {
  const sessions = join(dataDirectory, "sessions");
  const keep = keyOf(keepSessionId);

  try {
    for (const name of readdirSync(sessions)) {
      if (name === keep) continue;

      const directory = join(sessions, name);
      const newest = heartbeatFileOf(directory);

      try {
        if (now.getTime() - statSync(newest).mtimeMs > SESSION_TTL_MS) {
          rmSync(directory, { recursive: true, force: true });
        }
      } catch {}
    }
  } catch {}
}

/** Drops a session's state when the host says it ended; failures are contained. */
export function removeSession(sessionDirectory: string): void {
  try {
    rmSync(sessionDirectory, { recursive: true, force: true });
  } catch {}
}
