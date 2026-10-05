import type { CaptureProblem, PostImage } from "../acquisition";
import { decodeHookEvent, isHookEventParseFailure } from "../hook-event";
import { isJsonObject } from "../hook-event/shell-diff";
import type { JsonObject } from "../hook-event/types";
import type {
  GitSnapshot,
  LineCapture,
  PreRecord,
  SnapshotEntry,
  StateLine,
  StoredGitDiff,
  StoredShellChange,
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

  const { path } = value;

  if (value.preState === "UNREAD")
    return hasKeys(value, ["path", "preState"]) ? { path, preState: "UNREAD" } : null;

  const post = decodePostImage(value.post);

  if (post === null) return null;
  if (value.preState === "DIRTY") {
    return hasKeys(value, ["path", "preState", "post"]) ? { path, preState: "DIRTY", post } : null;
  }

  const indexImage = decodePostImage(value.indexImage);

  if (value.preState !== "CLEAN" || indexImage === null) return null;

  return hasKeys(value, ["path", "preState", "indexImage", "post"])
    ? { path, preState: "CLEAN", indexImage, post }
    : null;
}

function decodeStoredGitDiff(value: unknown): StoredGitDiff | null {
  if (!isJsonObject(value)) return null;
  if (value.status === "FAILED") return hasKeys(value, ["status"]) ? { status: "FAILED" } : null;
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

function decodeSnapshotEntry(value: unknown): SnapshotEntry | null {
  if (!isJsonObject(value)) return null;
  if (!hasKeys(value, ["gitPath", "repoPath", "kind", "state", "fingerprint"])) return null;

  const { gitPath, repoPath, kind, state, fingerprint } = value;

  if (typeof gitPath !== "string" || gitPath === "") return null;
  if (repoPath !== null && typeof repoPath !== "string") return null;
  if (kind !== "READABLE" && kind !== "BLOCKED" && kind !== "OUTSIDE") return null;
  if (state !== "PRESENT" && state !== "ABSENT") return null;
  if (fingerprint !== null && typeof fingerprint !== "string") return null;

  return { gitPath, repoPath, kind, state, fingerprint };
}

export function decodeGitSnapshot(value: unknown): GitSnapshot | null {
  if (
    !isJsonObject(value) ||
    !hasKeys(value, ["v", "toplevel", "head", "indexDigest", "entries"])
  ) {
    return null;
  }

  const { toplevel, head, indexDigest } = value;

  if (value.v !== 1 || typeof toplevel !== "string" || !Array.isArray(value.entries)) return null;
  if (head !== null && typeof head !== "string") return null;
  if (!isDigest(indexDigest)) return null;

  const entries: SnapshotEntry[] = [];

  for (const raw of value.entries) {
    const entry = decodeSnapshotEntry(raw);

    if (entry === null) return null;

    entries.push(entry);
  }

  return { toplevel, head, indexDigest, entries };
}
