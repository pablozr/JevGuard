import type { Turn } from "@jevguard/core";
import { executionDelivery, executionTask, locateExecution } from "./execution";
import {
  attributeSnapshotDiff,
  captureSnapshot,
  diffPaths,
  type WorkingSnapshot,
} from "./turn-snapshot";
import type {
  AttributionFailureReason,
  OpenCodeSessionFacade,
  TurnAttribution,
  TurnDeduplicator,
} from "./types";

/** Open start snapshots kept at once; the oldest is evicted first (FIFO). */
export const MAX_OPEN_SNAPSHOTS = 64;

export interface TurnTrackerDependencies {
  readonly facade: OpenCodeSessionFacade;
  readonly deduplicator: TurnDeduplicator;
}

/**
 * Per-session execution tracking for the OpenCode 2.2.x lifecycle. The caller
 * serializes `start`, `finish`, and `discard` in event order; `noteStarted` and
 * `recordWrite` are synchronous and safe to call at arrival time.
 *
 * - `noteStarted` stamps the arrival generation of an `execution.started`, so a new
 *   execution that arrives before the previous one is consumed is a `BOUNDARY_RACE`.
 * - `start` captures the working-tree snapshot. A session whose parent has an open
 *   execution is a nested host subagent: it gets no snapshot, its writes count toward
 *   the parent, and it is never reviewed on its own.
 * - `finish` attributes the succeeded execution; `discard` drops it.
 * - `recordWrite` records a project-relative path a write tool touched; a path the
 *   diff never shows (for example, ignored by Git) makes the turn incomplete.
 */
export interface TurnTracker {
  noteStarted(sessionID: string): number;
  start(sessionID: string, generation: number): Promise<void>;
  finish(sessionID: string): Promise<TurnAttribution>;
  discard(sessionID: string): { readonly nested: boolean };
  recordWrite(sessionID: string, path: string): void;
}

interface OpenExecution {
  readonly generation: number;
  readonly snapshot: WorkingSnapshot | null;
  concurrent: boolean;
}

export function createTurnTracker(dependencies: TurnTrackerDependencies): TurnTracker {
  const { facade, deduplicator } = dependencies;
  const generations = new Map<string, number>();
  const open = new Map<string, OpenExecution>();
  const nestedRoots = new Map<string, string>();
  const writes = new Map<string, Set<string>>();

  function takeWrites(sessionID: string): Set<string> {
    const taken = writes.get(sessionID) ?? new Set<string>();

    writes.delete(sessionID);

    return taken;
  }

  /** Moves a nested session's writes to its root execution and forgets the nesting. */
  function closeNested(sessionID: string): boolean {
    const root = nestedRoots.get(sessionID);

    if (root === undefined) {
      return false;
    }

    nestedRoots.delete(sessionID);

    for (const path of takeWrites(sessionID)) {
      addWrite(root, path);
    }

    return true;
  }

  function addWrite(sessionID: string, path: string): void {
    const paths = writes.get(sessionID) ?? new Set<string>();

    paths.add(path);
    writes.set(sessionID, paths);
  }

  function rootOf(sessionID: string): string | null {
    if (open.has(sessionID)) {
      return sessionID;
    }

    return nestedRoots.get(sessionID) ?? null;
  }

  return {
    noteStarted(sessionID) {
      const generation = (generations.get(sessionID) ?? 0) + 1;

      generations.set(sessionID, generation);

      return generation;
    },

    async start(sessionID, generation) {
      const parentID = await orNull(() => facade.parentSessionID(sessionID));
      const root = parentID === null ? null : rootOf(parentID);

      if (root !== null) {
        nestedRoots.set(sessionID, root);
        return;
      }

      const snapshot = await orNull(() => captureSnapshot(facade));
      const execution: OpenExecution = { generation, snapshot, concurrent: false };

      for (const [otherID, other] of open) {
        if (otherID !== sessionID) {
          other.concurrent = true;
          execution.concurrent = true;
        }
      }

      open.delete(sessionID);

      if (open.size >= MAX_OPEN_SNAPSHOTS) {
        const oldest = open.keys().next().value;

        if (oldest !== undefined) {
          open.delete(oldest);
        }
      }

      open.set(sessionID, execution);
    },

    async finish(sessionID) {
      if (closeNested(sessionID)) {
        return { status: "NONE" };
      }

      const execution = open.get(sessionID);
      const written = takeWrites(sessionID);

      open.delete(sessionID);

      if (execution === undefined) {
        return finishWithoutStart(sessionID);
      }

      if (generations.get(sessionID) !== execution.generation) {
        return unavailable("BOUNDARY_RACE");
      }

      if (execution.concurrent) {
        return unavailable("CONCURRENT_SESSIONS");
      }

      return attributeExecution(sessionID, execution.snapshot, written);
    },

    discard(sessionID) {
      if (closeNested(sessionID)) {
        return { nested: true };
      }

      open.delete(sessionID);
      writes.delete(sessionID);

      return { nested: false };
    },

    recordWrite(sessionID, path) {
      addWrite(sessionID, path);
    },
  };

  /**
   * A `succeeded` with no open execution: a duplicate of an already reviewed execution
   * or one with no completed assistant is silent; anything else lost its start.
   */
  async function finishWithoutStart(sessionID: string): Promise<TurnAttribution> {
    const messages = await orNull(() => facade.listMessages(sessionID));
    const execution = messages === null ? null : locateExecution(messages);

    if (messages !== null && execution === null) {
      return { status: "NONE" };
    }

    if (execution !== null && deduplicator.hasProcessed(execution.assistant.id)) {
      return { status: "ALREADY_PROCESSED" };
    }

    return unavailable("MISSING_TURN_START");
  }

  async function attributeExecution(
    sessionID: string,
    snapshot: WorkingSnapshot | null,
    written: ReadonlySet<string>,
  ): Promise<TurnAttribution> {
    const messages = await orNull(() => facade.listMessages(sessionID));

    if (messages === null) {
      return unavailable("MESSAGE_READ_FAILURE");
    }

    const execution = locateExecution(messages);

    if (execution === null) {
      return { status: "NONE" };
    }

    if (deduplicator.hasProcessed(execution.assistant.id)) {
      return { status: "ALREADY_PROCESSED" };
    }

    if (execution.inputs.length === 0) {
      return unavailable("MISSING_TASK_MESSAGE");
    }

    const task = executionTask(execution.inputs);

    if (task === null) {
      return unavailable("EMPTY_TASK");
    }

    if (snapshot === null) {
      return unavailable("DIFF_READ_FAILURE");
    }

    const endDiffs = await orNull(() => facade.snapshotWorking());

    if (endDiffs === null) {
      return unavailable("DIFF_READ_FAILURE");
    }

    const visible = diffPaths(snapshot, endDiffs);

    if ([...written].some((path) => !visible.has(path))) {
      return unavailable("INCOMPLETE_FILE_DIFF");
    }

    const files = await orNull(() => attributeSnapshotDiff(snapshot, endDiffs, facade));

    if (files === null) {
      return unavailable("INCOMPLETE_FILE_DIFF");
    }

    deduplicator.markProcessed(execution.assistant.id);

    const turn: Turn = { id: execution.assistant.id, task, files };

    return { status: "ATTRIBUTED", turn, delivery: executionDelivery(execution.inputs) };
  }
}

/** Runs a host read, mapping any failure to `null`. */
async function orNull<T>(work: () => Promise<T>): Promise<T | null> {
  try {
    return await work();
  } catch {
    return null;
  }
}

function unavailable(reason: AttributionFailureReason): TurnAttribution {
  return { status: "UNAVAILABLE", reason };
}
