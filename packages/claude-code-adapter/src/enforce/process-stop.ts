import {
  createUserEnforceSettings,
  type EnforceUserSettingsResult,
} from "@jevguard/node-infra/enforce";
import {
  createLocalReviewHistory,
  createNodeReviewHistoryFileSystem,
  createProcessReviewHistoryContext,
  resolveHistoryFilePath,
} from "@jevguard/node-infra/history";
import type { CaptureFileReader } from "../capture/types";
import { readBlockedUnit, recordBlockedUnit } from "../capture/unit-state";
import { CLAUDE_CONFIG_FILE_NAME } from "../presentation";
import { waitForReview } from "./review-watch";
import { enforceStop, type EnforceStopRequest } from "./stop-gate";
import type { EnforceGateLogCode, EnforceStopOutput } from "./types";

export interface ProcessEnforceStopDependencies {
  readonly environment: { get(name: string): string | undefined };
  readonly files: Pick<CaptureFileReader, "stat">;
  readonly now: () => Date;
  readonly monotonicNow: () => number;
  readonly sleep: (ms: number) => Promise<void>;
}

export interface ProcessEnforceStop {
  run(
    request: EnforceStopRequest,
    remainingBudgetMs: () => number,
    report: (code: EnforceGateLogCode) => void,
  ): Promise<EnforceStopOutput | null>;
}

function blockedMarkerOf(unit: { readonly epoch: string; readonly ordinal: number }): string {
  return `${unit.epoch}:${unit.ordinal}`;
}

/**
 * Real-process wiring of the `Stop` gate: the user's `claude-code.yaml`, the local
 * review history the worker writes, and the session's per-unit marker. Everything it
 * touches is local and content-free — no credential, no Jev, no network — so the hook
 * keeps its boundary; the review itself stays in the worker, and this only waits for
 * its record.
 */
export function createProcessEnforceStop(
  dependencies: ProcessEnforceStopDependencies,
): ProcessEnforceStop {
  const context = createProcessReviewHistoryContext();
  const historyPath = resolveHistoryFilePath(context);
  const settingsFor: (projectRoot: string) => EnforceUserSettingsResult = createUserEnforceSettings(
    {
      environment: dependencies.environment,
      fileName: CLAUDE_CONFIG_FILE_NAME,
    },
  );
  const history = createLocalReviewHistory({
    context,
    fileSystem: createNodeReviewHistoryFileSystem(),
    now: dependencies.now,
  });

  return {
    run: (request, remainingBudgetMs, report) =>
      enforceStop(request, {
        environment: dependencies.environment,
        settingsFor,
        waitForReview: (turnId, budgetMs) =>
          waitForReview(
            {
              history,
              historyPath,
              statOf: (path) => dependencies.files.stat(path),
              sleep: dependencies.sleep,
              monotonicNow: dependencies.monotonicNow,
            },
            turnId,
            budgetMs,
          ),
        blockedUnits: {
          isBlocked(unit) {
            try {
              return readBlockedUnit(unit.sessionDirectory) === blockedMarkerOf(unit);
            } catch {
              return false;
            }
          },
          record(unit) {
            try {
              recordBlockedUnit(unit);
            } catch {
              report("STATE_WRITE_FAILED");
            }
          },
        },
        remainingBudgetMs,
        report,
      }),
  };
}
