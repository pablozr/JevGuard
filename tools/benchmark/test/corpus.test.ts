import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { hashCases, loadCorpus } from "../corpus";

const SHIPPED_CORPUS = join(process.cwd(), "benchmarks", "corpus");

const VALID_DIFF = [
  "diff --git a/src/number.ts b/src/number.ts",
  "index 1111111..2222222 100644",
  "--- a/src/number.ts",
  "+++ b/src/number.ts",
  "@@ -1,3 +1,3 @@",
  " export function double(value: number): number {",
  "-  return value + value;",
  "+  return value * 2;",
  " }",
];

describe("loadCorpus", () => {
  it("accepts the shipped corpus and loads every rule of the starter pack", async () => {
    const loaded = await loadCorpus(SHIPPED_CORPUS);

    expect(loaded.status).toBe("READY");

    if (loaded.status !== "READY") return;

    expect(loaded.corpus.cases).toHaveLength(20);
    expect(loaded.corpus.rules.map((rule) => rule.id).sort()).toEqual([
      "API-001",
      "QUALITY-001",
      "SCOPE-001",
      "SECRETS-001",
    ]);
    expect(loaded.corpus.hash).toHaveLength(16);
  });

  it("rejects an expectation the rule's severity can never reach", async () => {
    const directory = await writeCorpus({
      "QUALITY-001.json": document("QUALITY-001", [caseOf("q-1", "PASS"), caseOf("q-2", "FAIL")]),
    });

    const loaded = await loadCorpus(directory);

    expect(loaded.status).toBe("INVALID");
    if (loaded.status !== "INVALID") return;
    expect(loaded.codes).toContain("EXPECTED_NOT_FEASIBLE");
  });

  it("rejects a duplicated case id", async () => {
    const directory = await writeCorpus({
      "SECRETS-001.json": document("SECRETS-001", [caseOf("same", "PASS"), caseOf("same", "FAIL")]),
    });

    const loaded = await loadCorpus(directory);

    expect(loaded.status).toBe("INVALID");
    if (loaded.status !== "INVALID") return;
    expect(loaded.codes).toContain("DUPLICATE_CASE_ID");
  });

  it("rejects a diff the plugin itself would refuse", async () => {
    const directory = await writeCorpus({
      "SECRETS-001.json": document("SECRETS-001", [
        caseOf("s-1", "PASS"),
        {
          ...caseOf("s-2", "FAIL"),
          diff: ["@@ -1 +1 @@", "-a", "+b"],
        },
      ]),
    });

    const loaded = await loadCorpus(directory);

    expect(loaded.status).toBe("INVALID");
    if (loaded.status !== "INVALID") return;
    expect(loaded.codes).toContain("DIFF_INVALID");
  });

  it("requires a clean case and a flagging case for every rule", async () => {
    const directory = await writeCorpus({
      "QUALITY-001.json": document("QUALITY-001", [caseOf("q-1", "WARN"), caseOf("q-2", "WARN")]),
    });

    const loaded = await loadCorpus(directory);

    expect(loaded.status).toBe("INVALID");
    if (loaded.status !== "INVALID") return;
    expect(loaded.codes).toContain("MISSING_CLEAN_CASE");
  });

  it("requires a case that should be flagged for every rule", async () => {
    const directory = await writeCorpus({
      "QUALITY-001.json": document("QUALITY-001", [caseOf("q-1", "PASS"), caseOf("q-2", "PASS")]),
    });

    const loaded = await loadCorpus(directory);

    expect(loaded.status).toBe("INVALID");
    if (loaded.status !== "INVALID") return;
    expect(loaded.codes).toContain("MISSING_VIOLATION_CASE");
  });

  it("hashes case content so a report names the corpus it used", () => {
    const first = hashCases([
      { id: "a", ruleId: "R", task: "t", diff: "d", expected: "PASS", rationale: "r" },
    ]);
    const second = hashCases([
      { id: "a", ruleId: "R", task: "t", diff: "d2", expected: "PASS", rationale: "r" },
    ]);

    expect(first).not.toBe(second);
  });
});

function document(rule: string, cases: readonly unknown[]): unknown {
  return { version: 1, rule, cases };
}

function caseOf(id: string, expected: string): Record<string, unknown> {
  return {
    id,
    task: "Change double to multiply by two.",
    expected,
    rationale: "Test case.",
    diff: VALID_DIFF,
  };
}

async function writeCorpus(files: Readonly<Record<string, unknown>>): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), "jevguard-benchmark-"));

  for (const [name, content] of Object.entries(files)) {
    await writeFile(join(directory, name), JSON.stringify(content));
  }

  return directory;
}
