import { randomUUID } from "node:crypto";
import {
  appendFileSync,
  closeSync,
  existsSync,
  mkdirSync,
  openSync,
  readdirSync,
  readFileSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
  writeSync,
} from "node:fs";
import { join } from "node:path";
import { PROPOSAL_REQUEST_TTL_MS } from "../presentation/proposal-file";
import { sha256Hex } from "./file-image";
import { isMissingPathError } from "./node-ports";
import { decodePreRecord, decodeShellPreRecord, decodeStateLine } from "./state-codec";
import type {
  GitSnapshot,
  PackSlice,
  PreRecord,
  RemovePath,
  ShellPreSnapshot,
  StateLine,
  TakenSnapshot,
  UnitState,
} from "./types";

export const ORPHAN_TTL_MS = PROPOSAL_REQUEST_TTL_MS;

/** State holds task text and file contents, so it is owner-only where the platform allows. */
export const DIR_MODE = 0o700;
export const FILE_MODE = 0o600;

const NAMESPACE = "claude-code";
const TAINT_LINE: StateLine = { v: 1, taint: "CAPTURE_FAILED" };
const ORDINAL_PATTERN = /^(0|[1-9][0-9]*)$/;
const EPOCH_PATTERN = /^[0-9a-f]{16}$/;

export function keyOf(value: string): string {
  return sha256Hex(value).slice(0, 32);
}

export function stateDirectoryOf(pluginDataDirectory: string): string {
  return join(pluginDataDirectory, NAMESPACE);
}

export function sessionDirectoryOf(stateDirectory: string, sessionId: string): string {
  return join(stateDirectory, "sessions", keyOf(sessionId));
}

export function handoffDirectoryOf(stateDirectory: string): string {
  return join(stateDirectory, "handoff");
}

export function hookLogFileOf(stateDirectory: string): string {
  return join(stateDirectory, "hook-log.jsonl");
}

export function writeAtomic(path: string, data: string | Uint8Array): void {
  const temporaryPath = `${path}.${randomUUID()}.tmp`;

  try {
    writeFileSync(temporaryPath, data, { mode: FILE_MODE });
    renameSync(temporaryPath, path);
  } catch (error) {
    rmSync(temporaryPath, { force: true });

    throw error;
  }
}

function unitAt(sessionDirectory: string, epoch: string, ordinal: number): UnitState {
  const directory = join(sessionDirectory, "units", String(ordinal));

  return {
    sessionDirectory,
    epoch,
    ordinal,
    directory,
    eventsFile: join(directory, "events.jsonl"),
    rootFile: join(directory, "root"),
    preDirectory: join(directory, "pre"),
    blobsDirectory: join(directory, "blobs"),
    shellDirectory: join(directory, "shell"),
  };
}

/**
 * A damaged `current` cannot say which ordinals already produced handoffs, since closed
 * units are deleted. The recovered ordinal jumps to the wall clock in milliseconds, far
 * above any counter, so it never collides with an earlier unit's handoff.
 */
function recoveredOrdinal(sessionDirectory: string, now: Date): number {
  try {
    const ordinals = readdirSync(join(sessionDirectory, "units"))
      .filter((name) => ORDINAL_PATTERN.test(name))
      .map(Number);

    return Math.max(now.getTime(), ...ordinals.map((ordinal) => ordinal + 1));
  } catch {
    return now.getTime();
  }
}

function readEpoch(file: string): string | null {
  try {
    const text = readFileSync(file, "utf8").trim();

    return EPOCH_PATTERN.test(text) ? text : null;
  } catch (error) {
    if (isMissingPathError(error)) return null;

    throw error;
  }
}

/** One random epoch per session state, created with it, so ordinals never repeat an id. */
function readOrCreateEpoch(sessionDirectory: string): string {
  const file = join(sessionDirectory, "epoch");
  const existing = readEpoch(file);

  if (existing !== null) return existing;

  const epoch = randomUUID().replaceAll("-", "").slice(0, 16);

  try {
    writeFileSync(file, epoch, { flag: "wx", mode: FILE_MODE });

    return epoch;
  } catch (error) {
    if (!isExistsError(error)) throw error;
  }

  const winner = readEpoch(file);

  if (winner !== null) return winner;

  writeAtomic(file, epoch);

  return epoch;
}

function readCurrentOrdinal(
  sessionDirectory: string,
  now: Date,
): { ordinal: number; recovered: boolean } {
  let text: string;

  try {
    text = readFileSync(join(sessionDirectory, "current"), "utf8").trim();
  } catch (error) {
    if (isMissingPathError(error)) return { ordinal: 0, recovered: false };

    throw error;
  }

  const ordinal = ORDINAL_PATTERN.test(text) ? Number(text) : Number.NaN;

  if (Number.isSafeInteger(ordinal)) return { ordinal, recovered: false };

  return { ordinal: recoveredOrdinal(sessionDirectory, now), recovered: true };
}

export function appendLine(unit: UnitState, line: StateLine): void {
  mkdirSync(unit.directory, { recursive: true, mode: DIR_MODE });
  appendFileSync(unit.eventsFile, `${JSON.stringify(line)}\n`, { mode: FILE_MODE });
}

/**
 * Locates the session's open unit. A damaged `current` is rebuilt from the unit
 * directories and a session-level taint is folded into the unit, so neither can hide.
 */
export function openCurrentUnit(stateDirectory: string, sessionId: string, now: Date): UnitState {
  const sessionDirectory = sessionDirectoryOf(stateDirectory, sessionId);

  mkdirSync(sessionDirectory, { recursive: true, mode: DIR_MODE });

  const epoch = readOrCreateEpoch(sessionDirectory);
  const { ordinal, recovered } = readCurrentOrdinal(sessionDirectory, now);
  const unit = unitAt(sessionDirectory, epoch, ordinal);
  const sessionTaint = join(sessionDirectory, "tainted");

  if (recovered) {
    writeAtomic(join(sessionDirectory, "current"), String(ordinal));
    appendLine(unit, TAINT_LINE);
  }

  if (existsSync(sessionTaint)) {
    appendLine(unit, TAINT_LINE);
    rmSync(sessionTaint, { force: true });
  }

  return unit;
}

export function taintUnit(unit: UnitState): void {
  appendLine(unit, TAINT_LINE);
}

function markSessionTainted(stateDirectory: string, sessionId: string): void {
  try {
    const sessionDirectory = sessionDirectoryOf(stateDirectory, sessionId);

    mkdirSync(sessionDirectory, { recursive: true, mode: DIR_MODE });
    writeFileSync(join(sessionDirectory, "tainted"), "1", { mode: FILE_MODE });
  } catch {
    return;
  }
}

/**
 * Best effort: marks the session's open unit as untrustworthy, falling back to a
 * session-level marker that the next located unit absorbs.
 */
export function taintSession(stateDirectory: string, sessionId: string, now: Date): void {
  try {
    appendLine(openCurrentUnit(stateDirectory, sessionId, now), TAINT_LINE);
  } catch {
    markSessionTainted(stateDirectory, sessionId);
  }
}

export function advanceCurrentOrdinal(unit: UnitState): void {
  writeAtomic(join(unit.sessionDirectory, "current"), String(unit.ordinal + 1));
}

export function removeUnit(unit: UnitState, remove: RemovePath): void {
  remove(unit.directory);
}

export function removeSession(stateDirectory: string, sessionId: string, remove: RemovePath): void {
  remove(sessionDirectoryOf(stateDirectory, sessionId));
}

/** `true` when this event's project root matches the one recorded for the unit. */
export function recordUnitRoot(unit: UnitState, projectRoot: string): boolean {
  mkdirSync(unit.directory, { recursive: true, mode: DIR_MODE });

  try {
    writeFileSync(unit.rootFile, projectRoot, { flag: "wx", mode: FILE_MODE });

    return true;
  } catch (error) {
    if (!isExistsError(error)) throw error;
  }

  return readFileSync(unit.rootFile, "utf8") === projectRoot;
}

export function readUnitRoot(unit: UnitState): string | null {
  try {
    return readFileSync(unit.rootFile, "utf8");
  } catch {
    return null;
  }
}

function isExistsError(error: unknown): boolean {
  return typeof error === "object" && error !== null && "code" in error && error.code === "EEXIST";
}

/**
 * Claims the first pre-image slot of a path with an exclusive create; the loser of a
 * race never reads the file. Returns whether this call won the claim.
 */
export function writeFirstPreRecord(
  unit: UnitState,
  repoPath: string,
  build: () => PreRecord,
): boolean {
  mkdirSync(unit.preDirectory, { recursive: true, mode: DIR_MODE });

  let descriptor: number;

  try {
    descriptor = openSync(join(unit.preDirectory, `${keyOf(repoPath)}.json`), "wx", FILE_MODE);
  } catch (error) {
    if (isExistsError(error)) return false;

    throw error;
  }

  try {
    writeSync(descriptor, JSON.stringify(build()));
  } catch {
    writeSync(
      descriptor,
      JSON.stringify({ v: 1, path: repoPath, problem: "CAPTURE_FAILED" } satisfies PreRecord),
    );
  } finally {
    closeSync(descriptor);
  }

  return true;
}

export function readPreRecords(unit: UnitState): readonly PreRecord[] | null {
  try {
    const names = existsSync(unit.preDirectory) ? readdirSync(unit.preDirectory) : [];
    const records: PreRecord[] = [];

    for (const name of names) {
      const record = decodePreRecord(
        JSON.parse(readFileSync(join(unit.preDirectory, name), "utf8")),
      );

      if (record === null) return null;

      records.push(record);
    }

    return records;
  } catch {
    return null;
  }
}

export function writeBlob(unit: UnitState, bytes: Uint8Array): string {
  const digest = sha256Hex(bytes);
  const path = join(unit.blobsDirectory, digest);

  mkdirSync(unit.blobsDirectory, { recursive: true, mode: DIR_MODE });

  if (!existsSync(path)) writeAtomic(path, bytes);

  return digest;
}

/** The blob's bytes, or `null` when missing or when they no longer match their digest. */
export function readBlob(unit: UnitState, digest: string): Uint8Array | null {
  try {
    const bytes = readFileSync(join(unit.blobsDirectory, digest));

    return sha256Hex(bytes) === digest ? bytes : null;
  } catch {
    return null;
  }
}

function shellRecordPath(unit: UnitState, toolUseId: string): string {
  return join(unit.shellDirectory, `${keyOf(toolUseId)}.json`);
}

function shellPackPath(unit: UnitState, toolUseId: string): string {
  return join(unit.shellDirectory, `${keyOf(toolUseId)}.pack`);
}

function writeShellRecord(unit: UnitState, toolUseId: string, record: object): void {
  mkdirSync(unit.shellDirectory, { recursive: true, mode: DIR_MODE });
  writeAtomic(shellRecordPath(unit, toolUseId), JSON.stringify({ v: 2, ...record }));
}

function packOf(taken: TakenSnapshot): { slices: PackSlice[]; bytes: Buffer } {
  const slices: PackSlice[] = [];
  const parts: Uint8Array[] = [];
  let offset = 0;

  for (const { gitPath } of taken.snapshot.entries) {
    const content = taken.contents.get(gitPath);

    if (content === undefined) continue;

    slices.push({ gitPath, offset, length: content.length });
    parts.push(content);
    offset += content.length;
  }

  return { slices, bytes: Buffer.concat(parts) };
}

/**
 * Keeps the Pre snapshot of a shell call: the contents go to one pack file, written
 * before the record that describes it, so a record never points to a missing pack.
 */
export function writeShellSnapshot(unit: UnitState, toolUseId: string, taken: TakenSnapshot): void {
  const { slices, bytes } = packOf(taken);

  mkdirSync(unit.shellDirectory, { recursive: true, mode: DIR_MODE });

  if (slices.length > 0) writeAtomic(shellPackPath(unit, toolUseId), bytes);

  const { toplevel, head, indexLinks, entries } = taken.snapshot;

  writeShellRecord(unit, toolUseId, { toplevel, head, indexLinks, entries, pack: slices });
}

/** Records that the pre-call snapshot exceeded a limit, so the Post hook skips its own. */
export function writeShellSnapshotLimit(unit: UnitState, toolUseId: string): void {
  writeShellRecord(unit, toolUseId, { failed: "LIMIT_EXCEEDED" });
}

function contentsOfPack(
  snapshot: GitSnapshot,
  slices: readonly PackSlice[],
  pack: Uint8Array,
): ReadonlyMap<string, Uint8Array> | null {
  const expected = new Map(
    snapshot.entries
      .filter(
        (entry) =>
          entry.kind === "READABLE" && entry.state === "PRESENT" && entry.problem === undefined,
      )
      .map((entry) => [entry.gitPath, entry]),
  );
  const contents = new Map<string, Uint8Array>();

  if (slices.length !== expected.size) return null;

  for (const slice of slices) {
    const entry = expected.get(slice.gitPath);
    const end = slice.offset + slice.length;

    if (entry === undefined || contents.has(slice.gitPath) || end > pack.length) return null;

    const bytes = pack.subarray(slice.offset, end);

    if (sha256Hex(bytes) !== entry.fingerprint) return null;

    contents.set(slice.gitPath, bytes);
  }

  return contents;
}

function removeQuietly(path: string): void {
  try {
    rmSync(path, { force: true });
  } catch {
    return;
  }
}

/** Reads and deletes the pre-call record and its pack; `MISSING` when absent or unreadable. */
export function takeShellSnapshot(unit: UnitState, toolUseId: string): ShellPreSnapshot {
  const path = shellRecordPath(unit, toolUseId);
  const packPath = shellPackPath(unit, toolUseId);

  try {
    const record = decodeShellPreRecord(JSON.parse(readFileSync(path, "utf8")));

    if (record === null) return { status: "MISSING" };
    if (record.status === "LIMIT_EXCEEDED") return record;

    const pack = record.pack.length === 0 ? new Uint8Array() : readFileSync(packPath);
    const contents = contentsOfPack(record.snapshot, record.pack, pack);

    return contents === null
      ? { status: "MISSING" }
      : { status: "TAKEN", snapshot: record.snapshot, contents };
  } catch {
    return { status: "MISSING" };
  } finally {
    removeQuietly(path);
    removeQuietly(packPath);
  }
}

/** Every line of the unit's events; `null` when the file is missing or any line is damaged. */
export function readStateLines(unit: UnitState): readonly StateLine[] | null {
  try {
    const text = readFileSync(unit.eventsFile, "utf8");

    if (text === "") return [];

    const rows = text.split("\n");
    const complete = rows.pop() === "";
    const lines: StateLine[] = [];

    if (!complete) return null;

    for (const row of rows) {
      const line = decodeStateLine(JSON.parse(row));

      if (line === null) return null;

      lines.push(line);
    }

    return lines;
  } catch {
    return null;
  }
}

function newestModification(path: string): number {
  try {
    const stats = statSync(path);

    if (!stats.isDirectory()) return stats.mtimeMs;

    return readdirSync(path).reduce(
      (newest, name) => Math.max(newest, newestModification(join(path, name))),
      stats.mtimeMs,
    );
  } catch {
    return 0;
  }
}

function sweepDirectory(
  directory: string,
  now: Date,
  keep: string | null,
  remove: RemovePath,
): void {
  let names: string[];

  try {
    names = readdirSync(directory);
  } catch {
    return;
  }

  for (const name of names) {
    if (name === keep) continue;

    const path = join(directory, name);

    if (now.getTime() - newestModification(path) > ORPHAN_TTL_MS) {
      remove(path);
    }
  }
}

/** Removes sessions and handoffs untouched for longer than the orphan TTL. */
export function sweepOrphans(
  stateDirectory: string,
  now: Date,
  keepSessionId: string | null,
  remove: RemovePath,
): void {
  sweepDirectory(
    join(stateDirectory, "sessions"),
    now,
    keepSessionId === null ? null : keyOf(keepSessionId),
    remove,
  );
  sweepDirectory(handoffDirectoryOf(stateDirectory), now, null, remove);
}
