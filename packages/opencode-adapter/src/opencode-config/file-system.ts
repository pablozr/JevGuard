import { randomUUID } from "node:crypto";
import { access, mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import type { ConfigFileSystem } from "./types";

/** Node filesystem implementation of the `opencode.json` port. */
export function createNodeConfigFileSystem(): ConfigFileSystem {
  return {
    readFile: readOptionalFile,
    fileExists,
    writeFile: writeConfigFile,
    ensureParentDirectory,
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

async function fileExists(path: string): Promise<boolean> {
  try {
    await access(path);

    return true;
  } catch {
    return false;
  }
}

async function writeConfigFile(path: string, contents: string): Promise<void> {
  const temporaryPath = join(dirname(path), `.opencode.json.jevguard-tmp-${randomUUID()}`);

  try {
    await writeFile(temporaryPath, contents, "utf8");
    await rename(temporaryPath, path);
  } catch (error) {
    await rm(temporaryPath, { force: true }).catch(() => undefined);

    throw error;
  }
}

async function ensureParentDirectory(path: string): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
}

function isMissingFileError(error: unknown): boolean {
  return typeof error === "object" && error !== null && "code" in error && error.code === "ENOENT";
}
