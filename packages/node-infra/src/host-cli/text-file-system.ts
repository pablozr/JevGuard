import { randomUUID } from "node:crypto";
import { access, mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { basename, dirname, join } from "node:path";
import type { TextFileSystem } from "./types";

/** Node text file system; writes go to a temporary sibling and are renamed into place. */
export function createNodeTextFileSystem(): TextFileSystem {
  return { readText, exists, writeTextAtomic, makeDirectory };
}

async function readText(path: string): Promise<string | null> {
  try {
    return await readFile(path, "utf8");
  } catch (error) {
    if (isMissingFileError(error)) {
      return null;
    }

    throw error;
  }
}

async function exists(path: string): Promise<boolean> {
  try {
    await access(path);

    return true;
  } catch {
    return false;
  }
}

async function writeTextAtomic(path: string, text: string): Promise<void> {
  const temporaryPath = join(dirname(path), `.${basename(path)}.jevguard-tmp-${randomUUID()}`);

  try {
    await writeFile(temporaryPath, text, "utf8");
    await rename(temporaryPath, path);
  } catch (error) {
    await rm(temporaryPath, { force: true }).catch(() => undefined);

    throw error;
  }
}

async function makeDirectory(path: string): Promise<void> {
  await mkdir(path, { recursive: true });
}

function isMissingFileError(error: unknown): boolean {
  return typeof error === "object" && error !== null && "code" in error && error.code === "ENOENT";
}
