import { dirname, join } from "node:path";
import { addPluginEntry, createDefaultConfigDocument, JEVGUARD_PLUGIN_ENTRY } from "./entry";
import { resolveConfigPath } from "./paths";
import type {
  ConfigFileSystem,
  ConfirmationPrompt,
  InstallDependencies,
  InstallFailureReason,
  InstallOutcome,
  InstallTarget,
} from "./types";

const CONFIRMATION_MESSAGE = "Add JevGuard to the opencode.json plugin list?";

type DocumentRead =
  | { readonly status: "READ"; readonly document: unknown }
  | { readonly status: "FAILED"; readonly reason: InstallFailureReason };

type OptionalContents =
  | { readonly status: "READ"; readonly value: string | null }
  | { readonly status: "FAILED"; readonly reason: "READ_FAILURE" };

/**
 * Registers the JevGuard plugin in the target `opencode.json`. It is idempotent,
 * requires explicit confirmation before writing, never touches a `.jsonc`, and never
 * throws: every failure maps to a typed reason.
 */
export async function install(dependencies: InstallDependencies): Promise<InstallOutcome> {
  const path = resolveConfigPath(dependencies.target, dependencies);
  const read = await readConfigDocument(dependencies.fileSystem, path);

  if (read.status === "FAILED") {
    return failed(dependencies.target, path, read.reason);
  }

  const mutation = addPluginEntry(read.document, JEVGUARD_PLUGIN_ENTRY);

  if (mutation.status === "INVALID_SHAPE") {
    return failed(dependencies.target, path, "INVALID_CONFIG_SHAPE");
  }

  if (mutation.status === "PRESENT") {
    return { status: "ALREADY_INSTALLED", target: dependencies.target, path };
  }

  const confirmation = await requestConfirmation(dependencies.confirmation);

  if (confirmation.status === "FAILED") {
    return failed(dependencies.target, path, confirmation.reason);
  }

  if (confirmation.status === "DECLINED") {
    return { status: "ABORTED", target: dependencies.target, path };
  }

  const written = await writeConfigDocument(dependencies.fileSystem, path, mutation.document);

  if (!written) {
    return failed(dependencies.target, path, "WRITE_FAILURE");
  }

  return { status: "INSTALLED", target: dependencies.target, path };
}

async function readConfigDocument(
  fileSystem: ConfigFileSystem,
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
  fileSystem: ConfigFileSystem,
  path: string,
): Promise<OptionalContents> {
  try {
    return { status: "READ", value: await fileSystem.readFile(path) };
  } catch {
    return { status: "FAILED", reason: "READ_FAILURE" };
  }
}

async function readMissingConfigDocument(
  fileSystem: ConfigFileSystem,
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

async function requestConfirmation(
  confirmation: ConfirmationPrompt,
): Promise<
  | { readonly status: "CONFIRMED" | "DECLINED" }
  | { readonly status: "FAILED"; readonly reason: InstallFailureReason }
> {
  try {
    const result = await confirmation.confirm(CONFIRMATION_MESSAGE);

    if (result.status === "FAILED") {
      return { status: "FAILED", reason: result.reason };
    }

    return { status: result.status };
  } catch {
    return { status: "FAILED", reason: "NOT_A_TTY" };
  }
}

async function writeConfigDocument(
  fileSystem: ConfigFileSystem,
  path: string,
  document: Readonly<Record<string, unknown>>,
): Promise<boolean> {
  const serialized = `${JSON.stringify(document, null, 2)}\n`;

  try {
    await fileSystem.ensureParentDirectory(path);
    await fileSystem.writeFile(path, serialized);

    return true;
  } catch {
    return false;
  }
}

function failed(target: InstallTarget, path: string, reason: InstallFailureReason): InstallOutcome {
  return { status: "FAILED", target, path, reason };
}
