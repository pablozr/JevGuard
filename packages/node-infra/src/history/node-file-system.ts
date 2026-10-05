import { randomUUID } from "node:crypto";
import { appendFile, mkdir, readFile, rename, rm, stat, writeFile } from "node:fs/promises";
import { basename, dirname, join } from "node:path";
import type { ReviewHistoryFileSystem } from "./types";

const PRIVATE_DIRECTORY_MODE = 0o700;
const PRIVATE_FILE_MODE = 0o600;

/**
 * Node filesystem implementation of the local review-history port. The history holds
 * per-review paths and outcomes, so files it creates are owner-only (0600 inside a 0700
 * directory); permissions are a no-op on Windows, where the profile ACL applies.
 */
export function createNodeReviewHistoryFileSystem(): ReviewHistoryFileSystem {
  return {
    readFile: readOptionalFile,
    appendFile: appendHistoryFile,
    sizeOf: sizeOfOptionalFile,
    writeFileAtomic,
    ensureParentDirectory: async (path) => {
      await mkdir(dirname(path), { recursive: true, mode: PRIVATE_DIRECTORY_MODE });
    },
  };
}

async function readOptionalFile(path: string): Promise<string | null> {
  try {
    return await readFile(path, "utf8");
  } catch (error) {
    if (isMissingFileError(error)) {
      return null;
    }

    throw error;
  }
}

async function appendHistoryFile(path: string, data: string): Promise<void> {
  await appendFile(path, data, { encoding: "utf8", mode: PRIVATE_FILE_MODE });
}

async function sizeOfOptionalFile(path: string): Promise<number | null> {
  try {
    const info = await stat(path);

    return info.size;
  } catch (error) {
    if (isMissingFileError(error)) {
      return null;
    }

    throw error;
  }
}

async function writeFileAtomic(path: string, data: string): Promise<void> {
  const temporaryPath = join(dirname(path), `.${basename(path)}.jevguard-tmp-${randomUUID()}`);

  try {
    await writeFile(temporaryPath, data, { encoding: "utf8", mode: PRIVATE_FILE_MODE });
    await rename(temporaryPath, path);
  } catch (error) {
    await rm(temporaryPath, { force: true }).catch(() => undefined);

    throw error;
  }
}

function isMissingFileError(error: unknown): boolean {
  return typeof error === "object" && error !== null && "code" in error && error.code === "ENOENT";
}
