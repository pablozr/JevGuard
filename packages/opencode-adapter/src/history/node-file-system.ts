import { randomUUID } from "node:crypto";
import { appendFile, mkdir, readFile, rename, rm, stat, writeFile } from "node:fs/promises";
import { basename, dirname, join } from "node:path";
import type { ReviewHistoryFileSystem } from "./types";

/** Node filesystem implementation of the local review-history port. */
export function createNodeReviewHistoryFileSystem(): ReviewHistoryFileSystem {
  return {
    readFile: readOptionalFile,
    appendFile: appendHistoryFile,
    sizeOf: sizeOfOptionalFile,
    writeFileAtomic,
    ensureParentDirectory: async (path) => {
      await mkdir(dirname(path), { recursive: true });
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
  await appendFile(path, data, "utf8");
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
    await writeFile(temporaryPath, data, "utf8");
    await rename(temporaryPath, path);
  } catch (error) {
    await rm(temporaryPath, { force: true }).catch(() => undefined);

    throw error;
  }
}

function isMissingFileError(error: unknown): boolean {
  return typeof error === "object" && error !== null && "code" in error && error.code === "ENOENT";
}
