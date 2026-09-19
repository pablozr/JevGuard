import { readFile } from "node:fs/promises";
import { join } from "node:path";
import type {
  PolicyFileSystem,
  PolicyLoader,
  PolicyLoaderDependencies,
  PolicyLoadResult,
} from "./types";

type OptionalFileRead =
  | { readonly status: "READ"; readonly value: string | null }
  | { readonly status: "FAILED" };

/**
 * Reads `.jev/rules.md` and `.jev/config.yaml` as UTF-8 from fixed paths under the
 * configured root. ENOENT means the file is absent (`null`); any other I/O failure
 * fails the load so absence is never inferred from an error.
 */
export function createPolicyFileLoader(dependencies: PolicyLoaderDependencies): PolicyLoader {
  return {
    async load(): Promise<PolicyLoadResult> {
      const rules = await readOptionalFile(
        dependencies.fileSystem,
        join(dependencies.root, ".jev", "rules.md"),
      );

      if (rules.status === "FAILED") {
        return { status: "FAILED", reason: "RULES_READ_FAILURE" };
      }

      const config = await readOptionalFile(
        dependencies.fileSystem,
        join(dependencies.root, ".jev", "config.yaml"),
      );

      if (config.status === "FAILED") {
        return { status: "FAILED", reason: "CONFIG_READ_FAILURE" };
      }

      return {
        status: "LOADED",
        source: { rules: rules.value, config: config.value },
      };
    },
  };
}

/** Node filesystem implementation; callers pass only the loader's fixed paths. */
export function createNodePolicyFileSystem(): PolicyFileSystem {
  return {
    readFile: (path) => readFile(path, "utf8"),
  };
}

async function readOptionalFile(
  fileSystem: PolicyFileSystem,
  path: string,
): Promise<OptionalFileRead> {
  try {
    return { status: "READ", value: await fileSystem.readFile(path) };
  } catch (error) {
    if (isMissingFileError(error)) {
      return { status: "READ", value: null };
    }

    return { status: "FAILED" };
  }
}

function isMissingFileError(error: unknown): boolean {
  return typeof error === "object" && error !== null && "code" in error && error.code === "ENOENT";
}
