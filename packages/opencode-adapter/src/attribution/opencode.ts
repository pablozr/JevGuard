import { readFile, stat } from "node:fs/promises";
import { join } from "node:path";
import type { Plugin } from "@opencode/plugin";
import { MAX_SNAPSHOT_FILE_BYTES } from "./turn-snapshot";
import type { FileContent, OpenCodeMessage, OpenCodeSessionFacade, WorkingFileDiff } from "./types";

/** The slice of the 2.2.x plugin context attribution reads. */
export interface AttributionContext {
  readonly session: Pick<Plugin.Context["session"], "context" | "get">;
  readonly vcs: Pick<Plugin.Context["vcs"], "diff">;
}

type ContextMessage = Awaited<ReturnType<Plugin.Context["session"]["context"]>>[number];

/**
 * Concrete read-only facade over the OpenCode 2.2.x plugin context. Messages come
 * from `session.context`; the working diff from `vcs.diff` (mode `working`, untracked
 * files included); contents from disk under `root`, each bounded by the per-file cap.
 * It never calls the session diff endpoint.
 */
export function createOpenCodeSessionFacade(
  context: AttributionContext,
  root: string,
): OpenCodeSessionFacade {
  return {
    async listMessages(sessionID): Promise<readonly OpenCodeMessage[]> {
      const messages = await context.session.context({ sessionID });

      return messages.map(toMessage);
    },

    async snapshotWorking(): Promise<readonly WorkingFileDiff[]> {
      const result = await context.vcs.diff({ mode: "working", untracked: "files" });

      return result.data.map((diff) => ({
        file: diff.file,
        patch: diff.patch,
        ...(diff.more === true ? { more: true } : {}),
      }));
    },

    async readFiles(paths): Promise<ReadonlyMap<string, FileContent>> {
      const entries = await Promise.all(
        paths.map(async (path) => [path, await readBounded(join(root, path))] as const),
      );

      return new Map(entries);
    },

    async parentSessionID(sessionID): Promise<string | null> {
      const session = await context.session.get({ sessionID });

      return session.parentID ?? null;
    },
  };
}

function toMessage(message: ContextMessage): OpenCodeMessage {
  const base = {
    id: message.id,
    type: message.type,
    completed: message.type === "assistant" && message.time.completed !== undefined,
    ...(message.metadata === undefined ? {} : { metadata: message.metadata }),
  };

  return message.type === "user" || message.type === "synthetic"
    ? { ...base, text: message.text }
    : base;
}

async function readBounded(path: string): Promise<FileContent> {
  try {
    const info = await stat(path);

    if (info.size > MAX_SNAPSHOT_FILE_BYTES) {
      return { kind: "OVERSIZED" };
    }

    return { kind: "TEXT", text: await readFile(path, "utf8") };
  } catch (error) {
    if (isNotFound(error)) {
      return { kind: "MISSING" };
    }

    throw error;
  }
}

function isNotFound(error: unknown): boolean {
  return typeof error === "object" && error !== null && "code" in error && error.code === "ENOENT";
}
