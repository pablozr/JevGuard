import { join } from "node:path";
import type { JevEvaluationPort, Turn } from "@jevguard/core";
import { parseUnifiedDiff } from "@jevguard/core";
import { describe, expect, it } from "vitest";
import { loadCorpus } from "../corpus";
import { createCoreRunner, createHostRunner, ruleObservation } from "../hosts";

const SHIPPED_CORPUS = join(process.cwd(), "benchmarks", "corpus");

function fakePort(probability: number): JevEvaluationPort {
  const noul = { violationProbability: probability };

  return {
    async evaluate(request) {
      if (request.kind === "RULE") {
        return { kind: "RULE", status: "EVALUATED", noul };
      }

      return {
        kind: "BUILT_IN_BATCH",
        status: "EVALUATED",
        answers: {
          scopeCreep: { status: "EVALUATED", noul },
          complexity: { status: "EVALUATED", noul },
          testAdequacy: { status: "EVALUATED", noul },
        },
      };
    },
    async evaluateRuleBatch(requests) {
      return requests.map(() => ({ kind: "RULE" as const, status: "EVALUATED" as const, noul }));
    },
  };
}

async function turnFor(caseId: string, ruleId: string): Promise<Turn> {
  const loaded = await loadCorpus(SHIPPED_CORPUS);

  if (loaded.status !== "READY") throw new Error("the shipped corpus must load");

  const item = loaded.corpus.cases.find((candidate) => candidate.id === caseId);

  if (item === undefined) throw new Error(`missing case ${caseId}`);

  const parsed = parseUnifiedDiff(item.diff);

  if (parsed.status !== "PARSED") throw new Error("the shipped corpus must parse");

  expect(item.ruleId).toBe(ruleId);

  return { id: item.id, task: item.task, files: parsed.files };
}

const SECRET_CASE = "SECRETS-001/hardcoded-api-key";

describe("review runners", () => {
  it("reads the case rule through the core rule lane", async () => {
    const turn = await turnFor(SECRET_CASE, "SECRETS-001");
    const review = await createCoreRunner(fakePort(0.93)).review(turn, "SECRETS-001");
    const result = ruleObservation(review, "SECRETS-001");

    expect(result.observed).toBe("FAIL");
    expect(result.probability).toBe(0.93);
    expect(result.reason).toBeNull();
  });

  it("reads the same rule through the OpenCode review entry", async () => {
    const turn = await turnFor(SECRET_CASE, "SECRETS-001");
    const review = await createHostRunner("opencode", fakePort(0.93)).review(turn, "SECRETS-001");

    expect(ruleObservation(review, "SECRETS-001").observed).toBe("FAIL");
  });

  it("reads the same rule through the Claude Code worker entry", async () => {
    const turn = await turnFor(SECRET_CASE, "SECRETS-001");
    const review = await createHostRunner("claude-code", fakePort(0.93)).review(
      turn,
      "SECRETS-001",
    );

    expect(ruleObservation(review, "SECRETS-001").observed).toBe("FAIL");
  });

  it("keeps a clean case clean when the probability stays under the warning threshold", async () => {
    const turn = await turnFor("QUALITY-001/reformat-without-behavior-change", "QUALITY-001");
    const review = await createHostRunner("opencode", fakePort(0.1)).review(turn, "QUALITY-001");

    expect(ruleObservation(review, "QUALITY-001").observed).toBe("PASS");
  });

  it("reports a rule the review never returned as unavailable, never as a pass", () => {
    const result = ruleObservation(
      {
        turnId: "unit",
        results: [
          {
            kind: "REVIEW",
            ruleId: null,
            severity: null,
            turnId: "unit",
            scopedPaths: [],
            outcome: "UNAVAILABLE",
            reason: "JEV_FAILURE",
          },
        ],
        summary: {
          verdict: null,
          hasUnavailable: true,
          counts: { pass: 0, warn: 0, fail: 0, skipped: 0, unavailable: 1 },
        },
      },
      "SECRETS-001",
    );

    expect(result.observed).toBe("UNAVAILABLE");
    expect(result.reason).toBe("JEV_FAILURE");
  });
});
