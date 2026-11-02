import { describe, expect, it } from "vitest";
import type { ChainEndRecord, ChainState, RemediationProposalRequest } from "../src";
import { chainEndOf, deliveryFindingsOf, recordClosures } from "../src";

const STATE: ChainState = {
  chainId: "c1",
  originIds: ["R-1", "R-2"],
  signatures: ["s1"],
  turnIds: ["t1"],
  attempts: 2,
  scopes: {},
};

describe("chainEndOf", () => {
  it("adds the reviewed turn and keeps the step's ids and result", () => {
    const ids = { resolvedIds: ["R-1"], remainingIds: ["R-2"] };

    expect(
      chainEndOf({ kind: "STOP", code: "LIMIT", maxAttempts: 2, state: STATE, ids }, "t2"),
    ).toEqual({
      chainId: "c1",
      turnIds: ["t1", "t2"],
      attempts: 2,
      maxAttempts: 2,
      signatures: ["s1"],
      originIds: ["R-1", "R-2"],
      resolvedIds: ["R-1"],
      remainingIds: ["R-2"],
      result: "LIMIT",
    });
    expect(
      chainEndOf({ kind: "RESOLVED", maxAttempts: 2, state: STATE, ids }, "t1").turnIds,
    ).toEqual(["t1"]);
    expect(chainEndOf({ kind: "RESOLVED", maxAttempts: 2, state: STATE, ids }, "t1").result).toBe(
      "RESOLVED",
    );
  });
});

describe("recordClosures", () => {
  it("logs then records each closure with nothing fixed and a bound never below the attempts", async () => {
    const calls: Array<[string, ChainEndRecord]> = [];

    await recordClosures([{ state: STATE, code: "DELIVERY_FAILED" }], 1, {
      stopped: (code, entry) => {
        calls.push([code, entry]);
      },
      record: async (entry) => {
        calls.push(["record", entry]);
      },
    });

    const entry: ChainEndRecord = {
      chainId: "c1",
      turnIds: ["t1"],
      attempts: 2,
      maxAttempts: 2,
      signatures: ["s1"],
      originIds: ["R-1", "R-2"],
      resolvedIds: [],
      remainingIds: ["R-1", "R-2"],
      result: "DELIVERY_FAILED",
    };

    expect(calls).toEqual([
      ["DELIVERY_FAILED", entry],
      ["record", entry],
    ]);
  });
});

describe("deliveryFindingsOf", () => {
  it("lists rule findings with their own text, then built-in checks", () => {
    const request = {
      ruleFindings: [
        {
          ruleId: "R-1",
          severity: "error",
          probability: 0.9,
          scopedPaths: ["a.ts"],
          rule: { id: "R-1", description: "d", violation: "v", allowed: "a" },
        },
      ],
      builtInFindings: [
        { checkId: "SCOPE-CREEP", severity: "error", probability: 0.8, scopedPaths: ["b.ts"] },
      ],
    } as unknown as RemediationProposalRequest;

    expect(deliveryFindingsOf(request)).toEqual([
      {
        id: "R-1",
        severity: "error",
        probability: 0.9,
        paths: ["a.ts"],
        violation: "v",
        allowed: "a",
      },
      {
        id: "SCOPE-CREEP",
        severity: "error",
        probability: 0.8,
        paths: ["b.ts"],
        violation: null,
        allowed: null,
      },
    ]);
  });
});
