import { DEFAULT_EVIDENCE_POLICY, checkFilePath, selectTurnEvidence } from "@jevguard/core";
import { describe, expect, test } from "vitest";
import {
  CALIBRATION_SEED,
  DEFAULT_FIXTURE_COUNT,
  MAX_FIXTURE_COUNT,
  buildFixtures,
} from "../fixture-catalog";
import { serializeFixtures } from "../fixture-io";
import { CorpusGenerationError, generateCorpus } from "../generate-corpus";
import { parseFixtureDocument, validateFixtures } from "../fixture-validation";
import { CALIBRATION_CATEGORIES, type SyntheticCalibrationFixture } from "../types";

function defaultCorpus(): readonly SyntheticCalibrationFixture[] {
  return generateCorpus({ seed: CALIBRATION_SEED, count: DEFAULT_FIXTURE_COUNT }).fixtures;
}

function firstFixture(): SyntheticCalibrationFixture {
  const [fixture] = buildFixtures(CALIBRATION_SEED, 1);

  if (fixture === undefined) {
    throw new Error("expected a generated fixture");
  }

  return fixture;
}

function quadrantOf(fixture: SyntheticCalibrationFixture): string {
  return `${fixture.expected.scopeCreep}/${fixture.expected.complexity}`;
}

describe("deterministic corpus generation", () => {
  test("the same seed and count produce byte-identical JSONL", () => {
    const first = serializeFixtures(
      generateCorpus({ seed: CALIBRATION_SEED, count: 160 }).fixtures,
    );
    const second = serializeFixtures(
      generateCorpus({ seed: CALIBRATION_SEED, count: 160 }).fixtures,
    );

    expect(first).toBe(second);
  });

  test("a different seed changes the corpus", () => {
    const first = serializeFixtures(generateCorpus({ seed: "seed-a", count: 160 }).fixtures);
    const second = serializeFixtures(generateCorpus({ seed: "seed-b", count: 160 }).fixtures);

    expect(first).not.toBe(second);
  });

  test.each([0, MAX_FIXTURE_COUNT + 1])("rejects count %s", (count) => {
    expect(() => generateCorpus({ seed: CALIBRATION_SEED, count })).toThrow(CorpusGenerationError);
  });
});

describe("corpus shape", () => {
  const fixtures = defaultCorpus();

  test("produces 160 fixtures with unique stable ids", () => {
    expect(fixtures).toHaveLength(160);
    expect(new Set(fixtures.map((fixture) => fixture.id)).size).toBe(160);
  });

  test("balances all four label quadrants exactly", () => {
    const counts = new Map<string, number>();

    for (const fixture of fixtures) {
      const key = quadrantOf(fixture);
      counts.set(key, (counts.get(key) ?? 0) + 1);
    }

    expect(counts.get("NO_VIOLATION/NO_VIOLATION")).toBe(40);
    expect(counts.get("VIOLATION/NO_VIOLATION")).toBe(40);
    expect(counts.get("NO_VIOLATION/VIOLATION")).toBe(40);
    expect(counts.get("VIOLATION/VIOLATION")).toBe(40);
  });

  test("reserves roughly a quarter of the corpus for borderline cases", () => {
    const borderline = fixtures.filter((fixture) => fixture.difficulty === "borderline");

    expect(borderline).toHaveLength(40);
  });

  test("represents every category and every exemption scenario", () => {
    const categories = new Set(fixtures.map((fixture) => fixture.category));

    for (const category of CALIBRATION_CATEGORIES) {
      expect(categories.has(category)).toBe(true);
    }
  });

  test("borderline cases span positive and negative labels", () => {
    const borderline = fixtures.filter((fixture) => fixture.difficulty === "borderline");
    const scopeLabels = new Set(borderline.map((fixture) => fixture.expected.scopeCreep));
    const complexityLabels = new Set(borderline.map((fixture) => fixture.expected.complexity));

    expect(scopeLabels).toEqual(new Set(["VIOLATION", "NO_VIOLATION"]));
    expect(complexityLabels).toEqual(new Set(["VIOLATION", "NO_VIOLATION"]));
  });

  test("every fixture carries the synthetic-author provenance and a schema version", () => {
    for (const fixture of fixtures) {
      expect(fixture.provenance).toBe("synthetic-author");
      expect(fixture.schemaVersion).toBe(1);
    }
  });

  test("interleaves quadrants so a limited run is not a biased prefix", () => {
    const prefix = fixtures.slice(0, 20);
    const quadrants = new Set(prefix.map((fixture) => quadrantOf(fixture)));
    const categories = new Set(prefix.map((fixture) => fixture.category));

    expect(quadrants.size).toBeGreaterThanOrEqual(2);
    expect(categories.size).toBeGreaterThanOrEqual(4);
  });

  test("passes internal validation", () => {
    const report = validateFixtures(fixtures);

    expect(report.issues).toEqual([]);
    expect(report.valid).toBe(true);
  });
});

describe("fixture evidence safety", () => {
  const fixtures = defaultCorpus();

  test("every path passes the default evidence policy", () => {
    for (const fixture of fixtures) {
      for (const file of fixture.files) {
        expect(checkFilePath(file.path, DEFAULT_EVIDENCE_POLICY).allowed).toBe(true);
      }
    }
  });

  test("every fixture selects complete evidence", () => {
    for (const fixture of fixtures) {
      const selection = selectTurnEvidence(
        { id: fixture.id, task: fixture.task, files: fixture.files },
        DEFAULT_EVIDENCE_POLICY,
      );

      expect(selection.status).toBe("SELECTED");
    }
  });

  test("every file patch is nonempty and changes at least one line", () => {
    for (const fixture of fixtures) {
      expect(fixture.task.trim()).not.toBe("");

      for (const file of fixture.files) {
        const changed = file.patch
          .split("\n")
          .some(
            (line) =>
              (line.startsWith("+") || line.startsWith("-")) &&
              !line.startsWith("+++") &&
              !line.startsWith("---"),
          );

        expect(changed).toBe(true);
      }
    }
  });

  test("no fixture path is denied or contains a credential-like name", () => {
    for (const fixture of fixtures) {
      for (const file of fixture.files) {
        expect(file.path).not.toMatch(/\.(pem|key|p12|pfx)$/i);
        expect(file.path.toLowerCase()).not.toContain("id_rsa");
        expect(file.path.toLowerCase()).not.toContain(".env");
      }
    }
  });
});

describe("fixture document parsing", () => {
  test("parses serialized fixtures", () => {
    const result = parseFixtureDocument(serializeFixtures(buildFixtures(CALIBRATION_SEED, 10)));

    expect(result.status).toBe("PARSED");
  });

  test("rejects an empty document", () => {
    expect(parseFixtureDocument("")).toEqual({
      status: "INVALID",
      reason: "fixture document is empty",
    });
  });

  test("rejects a line that is not valid JSON", () => {
    expect(parseFixtureDocument("not json").status).toBe("INVALID");
  });

  test.each([
    ["empty object", {}],
    ["missing provenance", { ...firstFixture(), provenance: "observed" }],
    ["unknown category", { ...firstFixture(), category: "not-a-category" }],
    ["unknown difficulty", { ...firstFixture(), difficulty: "medium" }],
    [
      "bad label",
      { ...firstFixture(), expected: { scopeCreep: "MAYBE", complexity: "NO_VIOLATION" } },
    ],
    ["empty files", { ...firstFixture(), files: [] }],
  ])("rejects a structurally invalid fixture: %s", (_label, value) => {
    const result = parseFixtureDocument(JSON.stringify(value));

    expect(result.status).toBe("INVALID");
  });

  test("does not require assertions to reject invalid input", () => {
    const result = parseFixtureDocument('{"schemaVersion":1}');

    expect(result.status).toBe("INVALID");
  });
});
