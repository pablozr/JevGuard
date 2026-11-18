import { createHash, randomUUID } from "node:crypto";
import {
  appendFileSync,
  closeSync,
  mkdirSync,
  openSync,
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

/** How long a writer retries the lock before it goes on without it. */
export const LOCK_WAIT_MS = 50;

/** A lock older than this belongs to a hook that died between taking it and releasing it. */
export const LOCK_STALE_MS = 5_000;

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

/** A name only this process can hold, so two hooks writing at once never share a file. */
function writeAtomic(path: string, text: string): void {
  const temporary = `${path}.${randomUUID()}.tmp`;

  writeFileSync(temporary, text, { mode: FILE_MODE });
  renameSync(temporary, path);
}

function hasOpenUnit(state: CodexSessionState): boolean {
  return state.units.at(-1)?.closedAt === null;
}

function lockFileOf(sessionDirectory: string): string {
  return join(sessionDirectory, "lifecycle.lock");
}

/** Blocks this thread, not the event loop: the hook is synchronous from start to end. */
function sleepSync(milliseconds: number): void {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, milliseconds);
}

/** A hook that died holding the lock must not stop every later hook of the session. */
function breakStaleLock(lock: string): void {
  try {
    if (Date.now() - statSync(lock).mtimeMs > LOCK_STALE_MS) rmSync(lock, { force: true });
  } catch {}
}

/**
 * Takes the session's short write lock, or says it could not within `LOCK_WAIT_MS`.
 *
 * Both halves of the file's life — the bounding rewrite and every append — pass through
 * it, which is what keeps an append from landing between the rewrite's re-read and its
 * rename. It is advisory and per session: exclusive creation is the only primitive, so a
 * lock left by a dead hook is broken by age rather than by a lease. Waiting stays under a
 * few dozen milliseconds on purpose: a hook must never stand in the host's way.
 *
 * The window is a deadline on the clock, never a count of sleeps: `Atomics.wait` rounds a
 * 1 ms sleep up to the platform's timer granularity — about 15 ms on Windows — so counting
 * loops turned the same 50 ms of retries into three quarters of a second.
 */
function takeLock(lock: string): boolean {
  const deadline = performance.now() + LOCK_WAIT_MS;

  for (;;) {
    try {
      closeSync(openSync(lock, "wx", FILE_MODE));

      return true;
    } catch {}

    breakStaleLock(lock);

    if (performance.now() >= deadline) return false;

    sleepSync(1);
  }
}

function releaseLock(lock: string): void {
  try {
    rmSync(lock, { force: true });
  } catch {}
}

function serializeLines(lines: readonly CodexStateLine[]): string {
  return lines.map((line) => `${JSON.stringify(line)}\n`).join("");
}

/**
 * The rewrite running in this process, by lifecycle file, and the lines a nested writer
 * handed over while it ran. A hook that called this module from inside the rewrite cannot
 * wait for the lock — it is this very thread that holds it — so those lines are kept here
 * and appended right after the replacement, never into the file it replaces.
 */
const rewriting = new Set<string>();
const deferredLines = new Map<string, CodexStateLine[]>();

function deferWhileRewriting(file: string, lines: readonly CodexStateLine[]): boolean {
  if (!rewriting.has(file)) return false;

  deferredLines.set(file, [...(deferredLines.get(file) ?? []), ...lines]);

  return true;
}

/** Appends what a nested writer handed over; the caller still holds the lock. */
function flushDeferredLines(file: string): void {
  const lines = deferredLines.get(file);

  if (lines === undefined) return;

  deferredLines.delete(file);

  appendFileSync(file, serializeLines(lines), { mode: FILE_MODE });
}

/**
 * Keeps the lifecycle file under its bound, and only ever away from an open unit.
 *
 * Bounding is the one read-modify-write of this file, and every other hook of the session
 * only appends: an append made between the re-read and the replacement would be dropped,
 * which is how a mark goes missing. So the rewrite runs only when the state has no open
 * unit, and under the session's write lock, which every append takes as well — the re-read
 * and the rename are one step no append can fall into. It also gives up on the first sign
 * that a writer that bypassed the lock changed the file, and the file then stays over its
 * bound, which costs nothing but a larger read, until the next safe point.
 */
export function boundStateFile(sessionDirectory: string, state: CodexSessionState): void {
  if (hasOpenUnit(state)) return;

  const file = lifecycleFileOf(sessionDirectory);
  let before: string;

  try {
    before = readFileSync(file, "utf8");
  } catch (error) {
    if (isMissingPath(error)) return;

    throw error;
  }

  if (Buffer.byteLength(before) <= MAX_LIFECYCLE_BYTES) return;

  const lock = lockFileOf(sessionDirectory);
  const temporary = `${file}.${randomUUID()}.tmp`;

  // The replacement is written before the lock is taken: it is the slow half of the
  // rewrite, and holding the session's lock through it would make every append of the
  // session wait on a write it gains nothing from waiting on.
  writeFileSync(temporary, newestLines(before), { mode: FILE_MODE });

  // Another hook is writing right now: the file stays over its bound until the next one.
  if (!takeLock(lock)) {
    rmSync(temporary, { force: true });

    return;
  }

  rewriting.add(file);

  try {
    if (readFileSync(file, "utf8") !== before) {
      rmSync(temporary, { force: true });

      return;
    }

    renameSync(temporary, file);
  } finally {
    rewriting.delete(file);
    flushDeferredLines(file);
    releaseLock(lock);
  }
}

/**
 * Appends the event's lines as one write each, under the session's write lock so a
 * bounding rewrite cannot replace the file in between. Every rule is decided by replaying
 * the file, so no reader holds a lock and no update is a read-modify-write of another
 * process's state. An append that cannot take the lock in time still runs, exactly as it
 * did before the lock existed: dropping a mark would be worse than the window it covers.
 * Bounding the file is `boundStateFile`'s job, never an append's.
 */
export function appendStateLines(sessionDirectory: string, lines: readonly CodexStateLine[]): void {
  if (lines.length === 0) return;

  mkdirSync(sessionDirectory, { recursive: true, mode: DIR_MODE });

  const file = lifecycleFileOf(sessionDirectory);

  if (deferWhileRewriting(file, lines)) return;

  const lock = lockFileOf(sessionDirectory);
  const taken = takeLock(lock);

  try {
    appendFileSync(file, serializeLines(lines), { mode: FILE_MODE });
  } finally {
    if (taken) releaseLock(lock);
  }
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
