import { randomUUID } from "node:crypto";
import {
  closeSync,
  fsyncSync,
  linkSync,
  mkdirSync,
  openSync,
  rmSync,
  writeFileSync,
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

function createExclusively(finalPath: string, content: string): HandoffDelivery {
  let descriptor: number;

  try {
    descriptor = openSync(finalPath, "wx", FILE_MODE);
  } catch (error) {
    return errorCode(error) === "EEXIST" ? "EXISTS" : "FAILED";
  }

  try {
    writeSync(descriptor, content);
    fsyncSync(descriptor);
  } catch {
    closeSync(descriptor);
    rmSync(finalPath, { force: true });

    return "FAILED";
  }

  closeSync(descriptor);

  return "CREATED";
}

/**
 * File-backed handoff sink. Each handoff is written completely to a temporary file and
 * then hard-linked to its final name, so it appears whole and exactly once per unit.
 * Where the file system cannot hard-link, an exclusive create keeps the same guarantee.
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
        writeFileSync(temporaryPath, content, { mode: FILE_MODE });
        link(temporaryPath, finalPath);

        return "CREATED";
      } catch (error) {
        const code = errorCode(error);

        if (code === "EEXIST") return "EXISTS";

        return code !== null && LINK_UNSUPPORTED.has(code)
          ? createExclusively(finalPath, content)
          : "FAILED";
      } finally {
        rmSync(temporaryPath, { force: true });
      }
    },
  };
}
