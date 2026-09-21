import { buildFixtures, DEFAULT_FIXTURE_COUNT, MAX_FIXTURE_COUNT } from "./fixture-catalog";
import { hashFixtures } from "./fixture-io";
import { validateFixtures, type CorpusCounts } from "./fixture-validation";
import type { SyntheticCalibrationFixture } from "./types";

export interface GenerateCorpusOptions {
  readonly seed: string;
  readonly count: number;
}

export interface GeneratedCorpus {
  readonly fixtures: readonly SyntheticCalibrationFixture[];
  readonly corpusHash: string;
  readonly counts: CorpusCounts;
}

export class CorpusGenerationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "CorpusGenerationError";
  }
}

/**
 * Builds and validates the deterministic synthetic corpus. An invalid corpus — a
 * duplicate id, unsafe path, unselectable evidence, missing category, or unbalanced
 * labels — aborts generation before anything is written.
 */
export function generateCorpus(options: GenerateCorpusOptions): GeneratedCorpus {
  if (!Number.isInteger(options.count) || options.count < 1 || options.count > MAX_FIXTURE_COUNT) {
    throw new CorpusGenerationError(`count must be an integer between 1 and ${MAX_FIXTURE_COUNT}`);
  }

  const fixtures = buildFixtures(options.seed, options.count);
  const report = validateFixtures(fixtures);

  if (!report.valid) {
    const first = report.issues[0];

    throw new CorpusGenerationError(
      `generated corpus is invalid: ${first?.message ?? "unknown issue"}`,
    );
  }

  return { fixtures, corpusHash: hashFixtures(fixtures), counts: report.counts };
}

export { DEFAULT_FIXTURE_COUNT };
