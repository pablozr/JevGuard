import { readdir, readFile } from "node:fs/promises";
import { dirname } from "node:path";
import { createNodeTextFileSystem, type TextFileSystem } from "@jevguard/node-infra";
import type { PluginCacheFileSystem } from "./resolution";
import type { ConfigFileSystem } from "./types";

/** Adapts the host-neutral text file port to the `opencode.json` port. */
export function createConfigFileSystem(files: TextFileSystem): ConfigFileSystem {
  return {
    readFile: files.readText,
    fileExists: files.exists,
    writeFile: files.writeTextAtomic,
    ensureParentDirectory: (path) => files.makeDirectory(dirname(path)),
  };
}

/** Node filesystem implementation of the `opencode.json` port. */
export function createNodeConfigFileSystem(): ConfigFileSystem {
  return createConfigFileSystem(createNodeTextFileSystem());
}

/**
 * Node filesystem implementation of the host plugin-cache port. Only `ENOENT` becomes
 * `null`; any other error is rethrown so the doctor reports that it cannot prove the
 * resolution instead of guessing.
 */
export function createNodePluginCacheFileSystem(): PluginCacheFileSystem {
  return {
    readDirectory: async (path) => {
      try {
        return await readdir(path);
      } catch (error) {
        return missingOrThrow(error);
      }
    },
    readFile: async (path) => {
      try {
        return await readFile(path, "utf8");
      } catch (error) {
        return missingOrThrow(error);
      }
    },
  };
}

function missingOrThrow(error: unknown): null {
  if ((error as NodeJS.ErrnoException).code === "ENOENT") {
    return null;
  }

  throw error;
}
