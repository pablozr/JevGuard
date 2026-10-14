import { dirname } from "node:path";
import { createNodeFileReader } from "../../capture/node-ports";
import type { CaptureFileReader } from "../../capture/types";
import { writeAtomic } from "../../capture/unit-state";
import { proposalDirectoryOf, proposalRequestFileOf } from "../../presentation";
import { feedEnvironmentOf } from "../environment";
import { isExpired, namesIn } from "../expiry";
import type { WorkerFileSystem } from "../types";
import { isInsideProject, projectProbeOf, realPathOfNearest } from "./containment";
import type { WorkerProposalStore } from "./types";

/**
 * Writes and sweeps the private proposal requests under the user's data home. Requests
 * carry the task and the attributed patch, so they are `0600` in a `0700` directory and
 * are never written inside the project or its Git working tree. The mod blanks a request
 * as it reads it; the sweep removes blank and expired ones. Every failure is contained.
 */
export function createNodeProposalStore(
  environment: { get(name: string): string | undefined },
  now: () => Date,
  files: WorkerFileSystem,
  reader: CaptureFileReader = createNodeFileReader(),
): WorkerProposalStore {
  const feedEnvironment = feedEnvironmentOf(environment);
  const probe = projectProbeOf(reader);

  function requestFileOf(handoff: { sessionId: string; turnId: string }): string | null {
    return proposalRequestFileOf(feedEnvironment, handoff.sessionId, handoff.turnId);
  }

  return {
    write(handoff, file) {
      const path = requestFileOf(handoff);

      if (path === null) return "FAILED";

      try {
        const directory = dirname(path);
        const real = realPathOfNearest(directory, probe);

        if (real === null || isInsideProject(real, handoff.projectRoot, probe)) return "FAILED";

        files.ensureDirectory(directory);
        writeAtomic(path, JSON.stringify(file));

        return "WRITTEN";
      } catch {
        return "FAILED";
      }
    },
    remove(handoff) {
      const path = requestFileOf(handoff);

      if (path === null) return;

      try {
        files.remove(path);
      } catch {}
    },
    sweep() {
      const directory = proposalDirectoryOf(feedEnvironment);

      if (directory === null) return;

      const nowMs = now().getTime();

      for (const session of namesIn(files, directory)) {
        const sessionDirectory = `${directory}/${session}`;

        for (const name of namesIn(files, sessionDirectory)) {
          const path = `${sessionDirectory}/${name}`;

          try {
            if (files.sizeBytes(path) === 0 || isExpired(files, path, nowMs)) files.remove(path);
          } catch {}
        }
      }
    },
  };
}
