export { InMemoryTurnDeduplicator } from "./deduplicator";
export { executionTask, type LocatedExecution, locateExecution } from "./execution";
export { normalizeFileDiff } from "./normalize-patch";
export { type AttributionContext, createOpenCodeSessionFacade } from "./opencode";
export {
  attributeSnapshotDiff,
  captureSnapshot,
  MAX_SNAPSHOT_FILE_BYTES,
  MAX_SNAPSHOT_TOTAL_BYTES,
  type WorkingSnapshot,
} from "./turn-snapshot";
export {
  createTurnTracker,
  MAX_OPEN_SNAPSHOTS,
  type TurnTracker,
  type TurnTrackerDependencies,
} from "./turn-tracker";
export { writtenPaths } from "./written-paths";
export type {
  AttributionFailureReason,
  FileContent,
  OpenCodeFileDiff,
  OpenCodeMessage,
  OpenCodeSessionFacade,
  PatchNormalization,
  TurnAttribution,
  TurnDeduplicator,
  WorkingFileDiff,
} from "./types";
