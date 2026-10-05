import { randomUUID } from "node:crypto";
import {
  closeSync,
  existsSync,
  fsyncSync,
  linkSync,
  mkdirSync,
  openSync,
  renameSync,
  rmSync,
  writeSync,
} from "node:fs";
import { join } from "node:path";
import type { HandoffDelivery, HandoffSink } from "./types";
import { DIR_MODE, FILE_MODE, keyOf } from "./unit-state";

/** Creates `newPath` as a hard link to `existingPath`; throws when it cannot. */
export type LinkFile = (existingPath: string, newPath: string) => void;

const LINK_UNSUPPORTED = new Set(["ENOTSUP", "EPERM", "EXDEV", "ENOSYS"]);

function errorCode(error: unknown): string | null {
  return typeof error === "object" && error !== null && "code" in error ? String(error.code) : null;
}

function writeDurably(path: string, content: string): void {
  const descriptor = openSync(path, "wx", FILE_MODE);

  try {
    writeSync(descriptor, content);
    fsyncSync(descriptor);
  } finally {
    closeSync(descriptor);
  }
}

/** Publishes by rename after an existence check; used only where hard links are unsupported. */
function publishByRename(temporaryPath: string, finalPath: string): HandoffDelivery {
  if (existsSync(finalPath)) return "EXISTS";

  renameSync(temporaryPath, finalPath);

  return "CREATED";
}

/**
 * File-backed handoff sink. Each handoff is written completely to a temporary file and
 * then hard-linked to its final name, so it appears whole and exactly once per unit.
 * Where the file system cannot hard-link, an existence-checked rename publishes it. A
 * partial `.json` is never visible: the temporary name does not end in `.json`.
 */
export function createFileHandoffSink(directory: string, link: LinkFile = linkSync): HandoffSink {
  return {
    deliver(handoff): HandoffDelivery {
      const name = `${keyOf(handoff.sessionId)}-${handoff.epoch}-${handoff.ordinal}.json`;
      const finalPath = join(directory, name);
      const temporaryPath = `${finalPath}.${randomUUID()}.tmp`;
      const content = JSON.stringify(handoff);

      try {
        mkdirSync(directory, { recursive: true, mode: DIR_MODE });
        writeDurably(temporaryPath, content);

        try {
          link(temporaryPath, finalPath);

          return "CREATED";
        } catch (error) {
          const code = errorCode(error);

          if (code === "EEXIST") return "EXISTS";

          return code !== null && LINK_UNSUPPORTED.has(code)
            ? publishByRename(temporaryPath, finalPath)
            : "FAILED";
        }
      } catch {
        return "FAILED";
      } finally {
        rmSync(temporaryPath, { force: true });
      }
    },
  };
}
