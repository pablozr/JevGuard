import { dirname } from "node:path";
import { createNodeTextFileSystem, type TextFileSystem } from "@jevguard/node-infra";
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
