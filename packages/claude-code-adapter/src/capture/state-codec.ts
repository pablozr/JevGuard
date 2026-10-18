import type { CaptureProblem, PostImage } from "../acquisition";
import { decodeHookEvent, isHookEventParseFailure } from "../hook-event";
import { isJsonObject } from "../hook-event/shell-diff";
import type { JsonObject } from "../hook-event/types";
import type {
  GitSnapshot,
  LineCapture,
  PackSlice,
  PreRecord,
  ShellPreRecord,
  SnapshotEntry,
  StateLine,
  StoredGitDiff,
  StoredShellChange,
  UnkeptContentProblem,
} from "./types";

const DIGEST_PATTERN = /^[0-9a-f]{64}$/;
const CAPTURE_KEYS: readonly string[] = ["postImages", "gitDiff", "problems"];

function onlyKeys(value: JsonObject, allowed: readonly string[]): boolean {
  return Object.keys(value).every((key) => allowed.includes(key));
}

function hasKeys(value: JsonObject, keys: readonly string[]): boolean {
  return (
    Object.keys(value).length === keys.length && keys.every((key) => Object.hasOwn(value, key))
  );
}

function isDigest(value: unknown): value is string {
  return typeof value === "string" && DIGEST_PATTERN.test(value);
}

function isProblem(value: unknown): value is CaptureProblem {
  return (
    value === "CAPTURE_FAILED" ||
    value === "CONTENT_TOO_LARGE" ||
    value === "CONTENT_NOT_TEXT" ||
    value === "BLOCKED_PATH"
  );
}

function isUnkeptContentProblem(value: unknown): value is UnkeptContentProblem {
  return value === "CONTENT_TOO_LARGE" || value === "CONTENT_NOT_TEXT";
}

function decodePostImage(value: unknown): PostImage | null {
  if (!isJsonObject(value)) return null;
  if (value.state === "ABSENT") return hasKeys(value, ["state"]) ? { state: "ABSENT" } : null;

  const { digest } = value;

  if (value.state !== "PRESENT" || !hasKeys(value, ["state", "digest"]) || !isDigest(digest)) {
    return null;
  }

  return { state: "PRESENT", digest };
}

function decodeStoredChange(value: unknown): StoredShellChange | null {
  if (!isJsonObject(value) || typeof value.path !== "string" || value.path === "") return null;

  const { path, preState } = value;

  if (preState === "UNREAD")
    return hasKeys(value, ["path", "preState"]) ? { path, preState: "UNREAD" } : null;

  if (preState !== "CLEAN" && preState !== "DIRTY") return null;
  if (!hasKeys(value, ["path", "preState", "preImage", "post"])) return null;

  const preImage = decodePostImage(value.preImage);
  const post = decodePostImage(value.post);

  return preImage === null || post === null ? null : { path, preState, preImage, post };
}

function decodeFailedGitDiff(value: JsonObject): StoredGitDiff | null {
  if (hasKeys(value, ["status"])) return { status: "FAILED", cause: "UNPROVEN" };
  if (!hasKeys(value, ["status", "cause"])) return null;

  const { cause } = value;

  return cause === "UNPROVEN" || cause === "LIMIT_EXCEEDED" ? { status: "FAILED", cause } : null;
}

function decodeStoredGitDiff(value: unknown): StoredGitDiff | null {
  if (!isJsonObject(value)) return null;
  if (value.status === "FAILED") return decodeFailedGitDiff(value);
  if (value.status !== "AVAILABLE" || !hasKeys(value, ["status", "changes"])) return null;
  if (!Array.isArray(value.changes)) return null;

  const changes: StoredShellChange[] = [];

  for (const entry of value.changes) {
    const change = decodeStoredChange(entry);

    if (change === null) return null;

    changes.push(change);
  }

  return { status: "AVAILABLE", changes };
}

function decodeLineCapture(value: unknown): LineCapture | null {
  if (!isJsonObject(value) || !onlyKeys(value, CAPTURE_KEYS)) return null;

  const capture: {
    -readonly [K in keyof LineCapture]: LineCapture[K];
  } = {};

  if (Object.hasOwn(value, "postImages")) {
    if (!Array.isArray(value.postImages)) return null;

    const postImages: { path: string; image: PostImage }[] = [];

    for (const entry of value.postImages) {
      if (!isJsonObject(entry) || !hasKeys(entry, ["path", "image"])) return null;

      const image = decodePostImage(entry.image);

      if (typeof entry.path !== "string" || entry.path === "" || image === null) return null;

      postImages.push({ path: entry.path, image });
    }

    capture.postImages = postImages;
  }

  if (Object.hasOwn(value, "gitDiff")) {
    const gitDiff = decodeStoredGitDiff(value.gitDiff);

    if (gitDiff === null) return null;

    capture.gitDiff = gitDiff;
  }

  if (Object.hasOwn(value, "problems")) {
    if (!Array.isArray(value.problems) || !value.problems.every(isProblem)) return null;

    capture.problems = value.problems;
  }

  return capture;
}

/** Strict decoder for one `events.jsonl` line; `null` for anything not exactly ours. */
export function decodeStateLine(value: unknown): StateLine | null {
  if (!isJsonObject(value) || value.v !== 1) return null;

  if (Object.hasOwn(value, "taint")) {
    return value.taint === "CAPTURE_FAILED" && hasKeys(value, ["v", "taint"])
      ? { v: 1, taint: "CAPTURE_FAILED" }
      : null;
  }

  if (!onlyKeys(value, ["v", "event", "capture"])) return null;

  const event = decodeHookEvent(value.event);

  if (isHookEventParseFailure(event)) return null;
  if (!Object.hasOwn(value, "capture")) return { v: 1, event };

  const capture = decodeLineCapture(value.capture);

  return capture === null ? null : { v: 1, event, capture };
}

export function decodePreRecord(value: unknown): PreRecord | null {
  if (!isJsonObject(value) || value.v !== 1) return null;
  if (typeof value.path !== "string" || value.path === "") return null;

  const { path } = value;

  if (Object.hasOwn(value, "problem")) {
    return isProblem(value.problem) && hasKeys(value, ["v", "path", "problem"])
      ? { v: 1, path, problem: value.problem }
      : null;
  }

  const image = decodePostImage(value.image);

  return image !== null && hasKeys(value, ["v", "path", "image"]) ? { v: 1, path, image } : null;
}

const ENTRY_KEYS = ["gitPath", "repoPath", "kind", "state", "fingerprint"];

function decodeSnapshotEntry(value: unknown): SnapshotEntry | null {
  if (!isJsonObject(value)) return null;
  if (!onlyKeys(value, [...ENTRY_KEYS, "problem"])) return null;
  if (!ENTRY_KEYS.every((key) => Object.hasOwn(value, key))) return null;

  const { gitPath, repoPath, kind, state, fingerprint, problem } = value;

  if (typeof gitPath !== "string" || gitPath === "") return null;
  if (repoPath !== null && typeof repoPath !== "string") return null;
  if (kind !== "READABLE" && kind !== "BLOCKED" && kind !== "OUTSIDE") return null;
  if (state !== "PRESENT" && state !== "ABSENT") return null;
  if (fingerprint !== null && typeof fingerprint !== "string") return null;

  const base: SnapshotEntry = { gitPath, repoPath, kind, state, fingerprint };

  if (!Object.hasOwn(value, "problem")) return base;
  if (!isUnkeptContentProblem(problem)) return null;

  return kind === "READABLE" && state === "PRESENT" ? { ...base, problem } : null;
}

function decodePackSlices(value: unknown): readonly PackSlice[] | null {
  if (!Array.isArray(value)) return null;

  const slices: PackSlice[] = [];

  for (const raw of value) {
    if (!isJsonObject(raw) || !hasKeys(raw, ["gitPath", "offset", "length"])) return null;

    const { gitPath, offset, length } = raw;

    if (typeof gitPath !== "string" || gitPath === "") return null;
    if (!Number.isInteger(offset) || !Number.isInteger(length)) return null;
    if (typeof offset !== "number" || typeof length !== "number") return null;
    if (offset < 0 || length < 0) return null;

    slices.push({ gitPath, offset, length });
  }

  return slices;
}

/** Pre-call record of a shell call: a snapshot, or the marker of an exceeded limit. */
export function decodeShellPreRecord(value: unknown): ShellPreRecord | null {
  if (isJsonObject(value) && hasKeys(value, ["v", "failed"])) {
    return value.v === 2 && value.failed === "LIMIT_EXCEEDED" ? { status: "LIMIT_EXCEEDED" } : null;
  }

  const snapshot = decodeGitSnapshot(value);

  if (snapshot === null || !isJsonObject(value)) return null;

  const pack = decodePackSlices(value.pack);

  return pack === null ? null : { status: "TAKEN", snapshot, pack };
}

function decodeGitSnapshot(value: unknown): GitSnapshot | null {
  if (
    !isJsonObject(value) ||
    !hasKeys(value, ["v", "toplevel", "head", "indexLinks", "entries", "pack"])
  ) {
    return null;
  }

  const { toplevel, head, indexLinks } = value;

  if (value.v !== 2 || typeof toplevel !== "string" || !Array.isArray(value.entries)) return null;
  if (head !== null && typeof head !== "string") return null;
  if (!Array.isArray(indexLinks) || !indexLinks.every((link) => typeof link === "string")) {
    return null;
  }

  const entries: SnapshotEntry[] = [];

  for (const raw of value.entries) {
    const entry = decodeSnapshotEntry(raw);

    if (entry === null) return null;

    entries.push(entry);
  }

  return { toplevel, head, indexLinks, entries };
}
