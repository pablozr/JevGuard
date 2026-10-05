import { createHash } from "node:crypto";
import { basename, dirname, isAbsolute, join, relative, resolve } from "node:path";
import { checkFilePath, DEFAULT_EVIDENCE_POLICY } from "@jevguard/core";
import type { ResolveRepoPath } from "../acquisition";
import type { CaptureFileReader, FileStat, ImageReading } from "./types";

export const MAX_CAPTURED_FILE_BYTES = 1024 * 1024;

const TEXT_DECODER = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true });

/** The single digest domain of the adapter: sha256 over the raw file bytes. */
export function sha256Hex(bytes: Uint8Array | string): string {
  return createHash("sha256").update(bytes).digest("hex");
}

export function createRepoPathResolver(root: string): ResolveRepoPath {
  return (rawPath, cwd) => {
    const relativePath = relative(root, resolve(cwd, rawPath));

    if (relativePath === "" || isAbsolute(relativePath)) return null;

    const segments = relativePath.split(/[\\/]/);

    return segments[0] === ".." ? null : segments.join("/");
  };
}

export function isReadablePath(repoPath: string): boolean {
  return checkFilePath(repoPath, DEFAULT_EVIDENCE_POLICY).allowed;
}

export function imageFromBytes(bytes: Uint8Array): ImageReading {
  if (bytes.length > MAX_CAPTURED_FILE_BYTES) {
    return { kind: "PROBLEM", problem: "CONTENT_TOO_LARGE" };
  }

  if (bytes.includes(0)) return { kind: "PROBLEM", problem: "CONTENT_NOT_TEXT" };

  try {
    const content = TEXT_DECODER.decode(bytes);

    return { kind: "IMAGE", image: { state: "PRESENT", digest: sha256Hex(bytes), content } };
  } catch {
    return { kind: "PROBLEM", problem: "CONTENT_NOT_TEXT" };
  }
}

export type PathAccess =
  | { readonly kind: "BLOCKED" }
  | { readonly kind: "ABSENT" }
  | { readonly kind: "OK"; readonly stat: FileStat };

function repoPathWithin(realRoot: string, real: string): string | null {
  const relativePath = relative(realRoot, real);

  if (relativePath === "" || isAbsolute(relativePath)) return null;

  const segments = relativePath.split(/[\\/]/);

  return segments[0] === ".." ? null : segments.join("/");
}

function realPathOfMissing(reader: CaptureFileReader, absolutePath: string): string | null {
  const tail = [basename(absolutePath)];
  let current = dirname(absolutePath);

  for (;;) {
    const real = reader.realPath(current);

    if (real !== null) return join(real, ...tail);

    const parent = dirname(current);

    if (parent === current) return null;

    tail.unshift(basename(current));
    current = parent;
  }
}

/**
 * Decides whether a path may be read, from what it really is on disk: a link is never
 * followed, and the fully resolved path (or, for a missing file, its resolved existing
 * ancestor) must lie inside the resolved root and pass the evidence policy again.
 * Nothing is read; a short name, symlink or junction cannot reach a denied file.
 */
export function guardPath(
  reader: CaptureFileReader,
  root: string,
  absolutePath: string,
): PathAccess {
  const realRoot = reader.realPath(root);
  const stat = reader.stat(absolutePath);

  if (realRoot === null || stat?.isLink === true) return { kind: "BLOCKED" };

  const real =
    stat === null ? realPathOfMissing(reader, absolutePath) : reader.realPath(absolutePath);
  const repoPath = real === null ? null : repoPathWithin(realRoot, real);

  if (repoPath === null || !isReadablePath(repoPath)) return { kind: "BLOCKED" };

  return stat === null ? { kind: "ABSENT" } : { kind: "OK", stat };
}

/**
 * Reads one file as text after `guardPath`. The caller must still have classified the
 * textual repo path with `isReadablePath` first.
 */
export function readFileImage(
  reader: CaptureFileReader,
  root: string,
  absolutePath: string,
): ImageReading {
  try {
    const access = guardPath(reader, root, absolutePath);

    if (access.kind === "BLOCKED") return { kind: "PROBLEM", problem: "BLOCKED_PATH" };
    if (access.kind === "ABSENT") return { kind: "IMAGE", image: { state: "ABSENT" } };

    const { stat } = access;

    if (!stat.isFile) return { kind: "PROBLEM", problem: "CONTENT_NOT_TEXT" };
    if (stat.size > MAX_CAPTURED_FILE_BYTES) {
      return { kind: "PROBLEM", problem: "CONTENT_TOO_LARGE" };
    }

    return imageFromBytes(reader.readBytes(absolutePath, MAX_CAPTURED_FILE_BYTES + 1));
  } catch {
    return { kind: "PROBLEM", problem: "CAPTURE_FAILED" };
  }
}
