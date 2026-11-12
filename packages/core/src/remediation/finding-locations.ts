import type {
  BuiltInReviewResult,
  RuleEvidenceMetadata,
  RuleReviewResult,
  TurnFile,
} from "../domain/types";
import { hunkRangeOf } from "../evidence/hunk-header";
import { type FindingLocation, MAX_FINDING_LOCATIONS } from "./types";

/**
 * Where a `FAIL` finding applies. Sliced evidence names the files and hunks whose
 * slice judgments failed; any other evidence falls back to the finding's scoped paths.
 */
export function locationsOf(
  result: RuleReviewResult | BuiltInReviewResult,
  files: readonly TurnFile[],
): readonly FindingLocation[] {
  const evidence = result.kind === "RULE" ? result.evidence : undefined;
  const sliced = evidence === undefined ? [] : slicedLocations(evidence, files);
  const locations = sliced.length > 0 ? sliced : pathLocations(result.scopedPaths);

  return locations.slice(0, MAX_FINDING_LOCATIONS);
}

function pathLocations(paths: readonly string[]): readonly FindingLocation[] {
  return paths.map((path) => ({ path, hunk: null }));
}

function slicedLocations(
  evidence: RuleEvidenceMetadata,
  files: readonly TurnFile[],
): readonly FindingLocation[] {
  if (evidence.mode !== "SLICED") {
    return [];
  }

  const locations: FindingLocation[] = [];

  for (const judgment of evidence.sliceJudgments) {
    const slice = evidence.slices[judgment.index];

    if (judgment.outcome !== "FAIL" || slice?.path == null) {
      continue;
    }

    locations.push({ path: slice.path, hunk: hunkOf(slice, files) });
  }

  return locations;
}

function hunkOf(
  slice: RuleEvidenceMetadata["slices"][number],
  files: readonly TurnFile[],
): FindingLocation["hunk"] {
  if (slice.kind !== "HUNK" || slice.hunkOrdinal === null) {
    return null;
  }

  const patch = files.find((file) => file.path === slice.path)?.patch;
  const range = patch === undefined ? null : hunkRangeOf(patch, slice.hunkOrdinal);

  return range === null ? null : { ordinal: slice.hunkOrdinal, ...range };
}
