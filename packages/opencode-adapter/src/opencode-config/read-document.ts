import { dirname, join } from "node:path";
import { createDefaultConfigDocument } from "./entry";
import type { ConfigFileSystem, InstallInspectionFailureReason } from "./types";

type ReadableFileSystem = Pick<ConfigFileSystem, "readFile" | "fileExists">;

export type DocumentRead =
  | { readonly status: "READ"; readonly document: unknown }
  | { readonly status: "FAILED"; readonly reason: InstallInspectionFailureReason };

type OptionalContents =
  | { readonly status: "READ"; readonly value: string | null }
  | { readonly status: "FAILED"; readonly reason: "READ_FAILURE" };

export async function readConfigDocument(
  fileSystem: ReadableFileSystem,
  path: string,
): Promise<DocumentRead> {
  const contents = await readOptionalContents(fileSystem, path);

  if (contents.status === "FAILED") {
    return contents;
  }

  if (contents.value === null) {
    return readMissingConfigDocument(fileSystem, path);
  }

  try {
    return { status: "READ", document: JSON.parse(contents.value) as unknown };
  } catch {
    return { status: "FAILED", reason: "INVALID_JSON" };
  }
}

async function readOptionalContents(
  fileSystem: ReadableFileSystem,
  path: string,
): Promise<OptionalContents> {
  try {
    return { status: "READ", value: await fileSystem.readFile(path) };
  } catch {
    return { status: "FAILED", reason: "READ_FAILURE" };
  }
}

async function readMissingConfigDocument(
  fileSystem: ReadableFileSystem,
  path: string,
): Promise<DocumentRead> {
  try {
    const hasJsonc = await fileSystem.fileExists(join(dirname(path), "opencode.jsonc"));

    if (hasJsonc) {
      return { status: "FAILED", reason: "UNSUPPORTED_JSONC" };
    }

    return { status: "READ", document: createDefaultConfigDocument() };
  } catch {
    return { status: "FAILED", reason: "READ_FAILURE" };
  }
}
