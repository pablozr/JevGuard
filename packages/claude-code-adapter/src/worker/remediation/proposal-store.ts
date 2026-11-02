import { dirname } from "node:path";
import type { ChainState } from "@jevguard/core";
import { parseChainState } from "@jevguard/core";
import { createNodeFileReader } from "../../capture/node-ports";
import type { CaptureFileReader } from "../../capture/types";
import { writeAtomic } from "../../capture/unit-state";
import {
  type ProposalOutcomeFile,
  parseProposalOutcome,
  proposalDirectoryOf,
  proposalRequestFileOf,
} from "../../presentation";
import { feedEnvironmentOf } from "../environment";
import { isExpired, namesIn } from "../expiry";
import type { WorkerFileSystem } from "../types";
import { isInsideProject, projectProbeOf, realPathOfNearest } from "./containment";
import type { ChainClosure, WorkerProposalStore } from "./types";

const CHAIN_FILE_UNSAFE = /[^A-Za-z0-9._-]/g;
const CHAIN_FILE_PREFIX = "chain-";
const OUTCOME_SUFFIX = ".outcome.json";

interface ChainFile {
  readonly path: string;
  readonly state: ChainState | null;
}

/**
 * Writes and sweeps the private proposal requests under the user's data home. Requests
 * carry the task and the attributed patch, so they are `0600` in a `0700` directory and
 * are never written inside the project or its Git working tree. The mod blanks a request
 * as it reads it; the sweep removes blank and expired ones. Chain states (ids, hashes and
 * counts, no text) sit next to the requests of their session and expire with them. Every
 * failure is contained.
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

  function chainFileOf(handoff: { sessionId: string; turnId: string }, chainId: string) {
    const request = requestFileOf(handoff);

    return request === null
      ? null
      : `${dirname(request)}/${CHAIN_FILE_PREFIX}${chainId.replace(CHAIN_FILE_UNSAFE, "_")}.json`;
  }

  function readChain(path: string): ChainState | null {
    try {
      const text = files.read(path);

      return text === null ? null : parseChainState(JSON.parse(text));
    } catch {
      return null;
    }
  }

  function removeQuietly(path: string): void {
    try {
      files.remove(path);
    } catch {}
  }

  /** The chain files of one session directory, parsed; an unreadable one has a `null` state. */
  function chainsIn(sessionDirectory: string): ChainFile[] {
    return namesIn(files, sessionDirectory)
      .filter((name) => name.startsWith(CHAIN_FILE_PREFIX) && !name.endsWith(OUTCOME_SUFFIX))
      .map((name) => {
        const path = `${sessionDirectory}/${name}`;

        return { path, state: readChain(path) };
      });
  }

  function readOutcome(path: string): ProposalOutcomeFile | null {
    try {
      const text = files.read(path);

      return text === null ? null : parseProposalOutcome(text);
    } catch {
      return null;
    }
  }

  /**
   * Ends the chain a delivery outcome names; the outcome file is spent either way. `chains`
   * is the session's list, read once; an ended chain is taken out of it.
   */
  function applyOutcomes(
    sessionDirectory: string,
    chains: ChainFile[],
    closures: ChainClosure[],
  ): void {
    for (const name of namesIn(files, sessionDirectory)) {
      if (!name.endsWith(OUTCOME_SUFFIX)) continue;

      const path = `${sessionDirectory}/${name}`;
      const outcome = readOutcome(path);

      removeQuietly(path);

      if (outcome === null) continue;

      const index = chains.findIndex((chain) => chain.state?.turnIds.at(-1) === outcome.turnId);
      const named = index === -1 ? undefined : chains[index];

      if (named?.state) {
        closures.push({ state: named.state, code: outcome.code });
        removeQuietly(named.path);
        chains.splice(index, 1);
      }
    }
  }

  function closeExpiredChains(
    chains: readonly ChainFile[],
    nowMs: number,
    closures: ChainClosure[],
  ): void {
    for (const { path, state } of chains) {
      try {
        if (!isExpired(files, path, nowMs)) continue;
      } catch {
        continue;
      }

      if (state !== null) closures.push({ state, code: "EXPIRED" });

      removeQuietly(path);
    }
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
    loadChain(handoff, chainId) {
      const path = chainFileOf(handoff, chainId);
      const state = path === null ? null : readChain(path);

      return state !== null && state.chainId === chainId ? state : null;
    },
    saveChain(handoff, state) {
      const path = chainFileOf(handoff, state.chainId);

      if (path === null) return false;

      try {
        files.ensureDirectory(dirname(path));
        writeAtomic(path, JSON.stringify(state));

        return true;
      } catch {
        return false;
      }
    },
    removeChain(handoff, chainId) {
      const path = chainFileOf(handoff, chainId);

      if (path === null) return;

      removeQuietly(path);
    },
    activeChain(handoff) {
      const request = requestFileOf(handoff);

      if (request === null) return null;

      let newest: { state: ChainState; modifiedMs: number } | null = null;

      for (const { path, state } of chainsIn(dirname(request))) {
        if (state === null) continue;

        const modifiedMs = files.modifiedMs(path) ?? 0;

        if (newest === null || modifiedMs > newest.modifiedMs) newest = { state, modifiedMs };
      }

      return newest?.state ?? null;
    },
    sweep() {
      const directory = proposalDirectoryOf(feedEnvironment);
      const closures: ChainClosure[] = [];

      if (directory === null) return closures;

      const nowMs = now().getTime();

      for (const session of namesIn(files, directory)) {
        const sessionDirectory = `${directory}/${session}`;

        const chains = chainsIn(sessionDirectory);

        applyOutcomes(sessionDirectory, chains, closures);
        closeExpiredChains(chains, nowMs, closures);

        for (const name of namesIn(files, sessionDirectory)) {
          const path = `${sessionDirectory}/${name}`;

          try {
            if (files.sizeBytes(path) === 0 || isExpired(files, path, nowMs)) files.remove(path);
          } catch {}
        }
      }

      return closures;
    },
  };
}
