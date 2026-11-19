import { describe, expect, it } from "vitest";
import { buildHostSummary, buildReport, renderMarkdown } from "../report";
import { summarizeLatency } from "../metrics";
import type { CaseObservation } from "../types";

const TASK_TEXT = "Add a trim option that nobody should ever see in a report";

function observation(overrides: Partial<CaseObservation> = {}): CaseObservation {
  return {
    caseId: "QUALITY-001/behavior-change-with-covering-test",
    ruleId: "QUALITY-001",
    expected: "PASS",
    observed: "PASS",
    probability: 0.12,
    reason: null,
    latencyMs: 250,
    inputTokens: 1000,
    outputTokens: 5,
    ...overrides,
  };
}

describe("renderMarkdown", () => {
  it("writes the per-rule and per-host tables with the measured counts", () => {
    const report = buildReport({
      metadata: {
        runId: "bench-1",
        generatedAt: "2026-11-19T18:00:00.000Z",
        corpusHash: "0123456789abcdef",
        requestedModel: "jev-latest",
        returnedModels: { "jev-1.14.0": 20 },
        repeat: 1,
        hosts: ["opencode"],
        probeCaseIds: ["QUALITY-001/behavior-change-with-covering-test"],
        pricing: {
          inputUsdPerMillionTokens: 0.042,
          outputUsdPerMillionTokens: 0,
          source: "test price",
        },
      },
      rules: [{ id: "QUALITY-001", severity: "warning" }],
      observations: [
        observation(),
        observation({
          caseId: "QUALITY-001/behavior-change-without-test",
          expected: "WARN",
          observed: "WARN",
        }),
      ],
      hostMeasurements: [
        buildHostSummary(
          "opencode",
          [
            {
              caseId: "QUALITY-001/behavior-change-with-covering-test",
              ruleId: "QUALITY-001",
              observed: "PASS",
              probability: 0.12,
              reason: null,
              latencyMs: 900,
              inputTokens: 2000,
              outputTokens: 10,
            },
          ],
          summarizeLatency([900]),
          2000,
          10,
          1,
          { inputUsdPerMillionTokens: 0.042, outputUsdPerMillionTokens: 0 },
        ),
      ],
    });

    const markdown = renderMarkdown(report);

    expect(markdown).toContain("| QUALITY-001 | warning | 2 | 2/2 (100%) |");
    expect(markdown).toContain("| opencode | 1 | 900 ms |");
    expect(markdown).toContain("Author-labeled synthetic corpus");
    expect(markdown).toContain("jev-1.14.0");
  });

  it("never writes a task or a diff into the report", () => {
    const report = buildReport({
      metadata: {
        runId: "bench-1",
        generatedAt: "2026-11-19T18:00:00.000Z",
        corpusHash: "0123456789abcdef",
        requestedModel: "jev-latest",
        returnedModels: {},
        repeat: 1,
        hosts: [],
        probeCaseIds: [],
        pricing: {
          inputUsdPerMillionTokens: 0.042,
          outputUsdPerMillionTokens: 0,
          source: "test price",
        },
      },
      rules: [{ id: "QUALITY-001", severity: "warning" }],
      observations: [observation({ expected: "PASS", observed: "PASS" })],
      hostMeasurements: [],
    });

    const markdown = renderMarkdown(report);

    expect(markdown).not.toContain(TASK_TEXT);
    expect(markdown).not.toContain("diff --git");
  });
});
