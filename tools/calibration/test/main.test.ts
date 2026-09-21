import { describe, expect, test } from "vitest";
import type { RunCommand } from "../args";
import { CALIBRATION_SEED, DEFAULT_FIXTURE_COUNT } from "../fixture-catalog";
import { serializeFixtures } from "../fixture-io";
import { generateCorpus } from "../generate-corpus";
import { type CorpusRunDependencies, loadCorpus, runCorpusCommand } from "../main";
import type { SyntheticCalibrationFixture } from "../types";

const SENTINEL_TASK = "SENTINEL_TASK_TEXT";
const SENTINEL_PATCH = "SENTINEL_PATCH_TEXT";
const SENTINEL_ID = "SENTINEL_ID_TEXT";
const SENTINEL_UNTRUSTED = "sentinel task diff path id";

const ALLOWED_VALIDATION_CODES = new Set<string>([
  "STRUCTURAL_VALIDATION_FAILED",
  "DUPLICATE_FIXTURE_ID",
  "EMPTY_TASK",
  "FIXTURE_HAS_NO_FILES",
  "EMPTY_PATCH",
  "PATCH_WITHOUT_CHANGES",
  "UNSUPPORTED_PATH",
  "SECRET_LIKE_MARKER",
  "EVIDENCE_UNAVAILABLE",
  "MISSING_CATEGORY",
  "QUADRANT_TOTAL_MISMATCH",
  "BORDERLINE_SHARE_MISMATCH",
  "QUADRANT_UNREPRESENTED",
  "BORDERLINE_ABSENT",
  "VALIDATION_FAILED",
]);

function generatedCorpus(): readonly SyntheticCalibrationFixture[] {
  return generateCorpus({ seed: CALIBRATION_SEED, count: DEFAULT_FIXTURE_COUNT }).fixtures;
}

function unsafeFixture(): SyntheticCalibrationFixture {
  return {
    schemaVersion: 1,
    id: SENTINEL_ID,
    provenance: "synthetic-author",
    category: "requested-direct",
    difficulty: "clear",
    task: `${SENTINEL_TASK} read secrets`,
    files: [{ path: ".env", patch: `+SECRET=${SENTINEL_PATCH}` }],
    expected: { scopeCreep: "NO_VIOLATION", complexity: "NO_VIOLATION" },
  };
}

function equalSentinelsFixture(): SyntheticCalibrationFixture {
  return {
    schemaVersion: 1,
    id: SENTINEL_UNTRUSTED,
    provenance: "synthetic-author",
    category: "requested-direct",
    difficulty: "clear",
    task: SENTINEL_UNTRUSTED,
    files: [{ path: SENTINEL_UNTRUSTED, patch: SENTINEL_UNTRUSTED }],
    expected: { scopeCreep: "NO_VIOLATION", complexity: "NO_VIOLATION" },
  };
}

function runCommand(overrides: Partial<RunCommand> = {}): RunCommand {
  return {
    kind: "run",
    input: "fixtures.jsonl",
    limit: 5,
    concurrency: 2,
    repeat: 1,
    difficulty: null,
    categories: [],
    confirmLiveApi: null,
    ...overrides,
  };
}

interface Harness {
  readonly deps: CorpusRunDependencies;
  readonly errors: string[];
  readonly state: {
    executeCalls: number;
    lastFixtures: readonly SyntheticCalibrationFixture[] | null;
  };
}

function harness(text: string, exitCode = 0): Harness {
  const errors: string[] = [];
  const state: Harness["state"] = { executeCalls: 0, lastFixtures: null };
  const deps: CorpusRunDependencies = {
    readFile: async () => text,
    error: (line) => {
      errors.push(line);
    },
    execute: async (_command, fixtures) => {
      state.executeCalls += 1;
      state.lastFixtures = fixtures;

      return exitCode;
    },
  };

  return { deps, errors, state };
}

describe("corpus load validation", () => {
  test("rejects an unsafe custom fixture with safe codes only", () => {
    const result = loadCorpus(serializeFixtures([unsafeFixture()]));

    expect(result.status).toBe("INVALID");

    if (result.status !== "INVALID") {
      throw new Error("expected invalid corpus");
    }

    const combined = result.codes.join("\n");

    expect(result.codes.length).toBeGreaterThan(0);
    expect(combined).toContain("UNSUPPORTED_PATH");
    expect(combined).not.toContain(SENTINEL_TASK);
    expect(combined).not.toContain(SENTINEL_PATCH);
    expect(combined).not.toContain(SENTINEL_ID);
  });

  test("never echoes fixture data when task, patch, path, and id are identical", () => {
    const result = loadCorpus(serializeFixtures([equalSentinelsFixture()]));

    expect(result.status).toBe("INVALID");

    if (result.status !== "INVALID") {
      throw new Error("expected invalid corpus");
    }

    const combined = result.codes.join("\n");

    expect(result.codes.length).toBeGreaterThan(0);
    expect(combined).not.toContain(SENTINEL_UNTRUSTED);
    expect(combined).toContain("UNSUPPORTED_PATH");

    for (const code of result.codes) {
      expect(ALLOWED_VALIDATION_CODES.has(code)).toBe(true);
    }
  });

  test("rejects a malformed document without echoing the parse reason", () => {
    const result = loadCorpus("not json");

    expect(result.status).toBe("INVALID");

    if (result.status !== "INVALID") {
      throw new Error("expected invalid document");
    }

    expect(result.codes).toEqual(["STRUCTURAL_VALIDATION_FAILED"]);
  });

  test("accepts the generated corpus", () => {
    const result = loadCorpus(serializeFixtures(generatedCorpus()));

    expect(result.status).toBe("READY");
  });
});

describe("run command validation gate", () => {
  test("rejects unsafe custom input before any credential or port work", async () => {
    const h = harness(serializeFixtures([unsafeFixture()]), 0);
    const code = await runCorpusCommand(runCommand(), h.deps);
    const combined = h.errors.join("\n");

    expect(code).toBe(1);
    expect(h.state.executeCalls).toBe(0);
    expect(combined).toContain("failed validation");
    expect(combined).not.toContain(SENTINEL_TASK);
    expect(combined).not.toContain(SENTINEL_PATCH);
    expect(combined).not.toContain(SENTINEL_ID);
  });

  test("never prints fixture data when task, patch, path, and id are identical", async () => {
    const h = harness(serializeFixtures([equalSentinelsFixture()]), 0);
    const code = await runCorpusCommand(runCommand(), h.deps);
    const combined = h.errors.join("\n");

    expect(code).toBe(1);
    expect(h.state.executeCalls).toBe(0);
    expect(combined).toContain("failed validation");
    expect(combined).not.toContain(SENTINEL_UNTRUSTED);
  });

  test("rejects malformed input before any credential or port work", async () => {
    const h = harness("not json", 0);
    const code = await runCorpusCommand(runCommand(), h.deps);

    expect(code).toBe(1);
    expect(h.state.executeCalls).toBe(0);
    expect(h.errors.join("\n")).not.toContain("not valid JSON");
    expect(h.errors.join("\n")).not.toContain("not json");
  });

  test("passes generated input through to the executor", async () => {
    const corpus = generatedCorpus();
    const h = harness(serializeFixtures(corpus), 7);
    const code = await runCorpusCommand(runCommand(), h.deps);

    expect(code).toBe(7);
    expect(h.state.executeCalls).toBe(1);
    expect(h.state.lastFixtures).toEqual(corpus);
  });
});
