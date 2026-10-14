import { describe, expect, expectTypeOf, test } from "vitest";
import type {
  EpisodeProvenance,
  EpisodeRequest,
  EpisodeUnavailableReason,
  ReviewEpisode,
} from "../src/index";

const attempt = { attemptId: "attempt-1", sessionId: "session-1", rootId: "root-1" };
const closure = { closureId: "closure-1", attempt };
const ready = {
  status: "READY",
  closure,
  requests: [
    { deliveryId: "delivery-2", text: "Add a limit." },
    { deliveryId: "delivery-1", text: "Use five, not ten." },
  ],
  policy: { snapshotId: "policy-1", source: { rules: "initial policy", config: null } },
  provenance: {
    kind: "OBSERVED_NET_DELTA",
    baselineId: "baseline-1",
    finalSnapshotId: "final-1",
    coverageId: "coverage-1",
    captureVersion: "capture-contract-1",
    snapshotMode: "NON_ATOMIC",
  },
  files: [{ path: "src/limit.ts", patch: "@@ -1 +1 @@\n-10\n+5" }],
} satisfies ReviewEpisode;

function identity(episode: ReviewEpisode): string {
  switch (episode.status) {
    case "OPEN":
      return episode.attempt.attemptId;
    case "READY":
      return episode.closure.closureId;
    case "UNAVAILABLE":
      return episode.reason;
    default: {
      const exhaustive: never = episode;
      return exhaustive;
    }
  }
}

describe("episode acquisition contracts", () => {
  test("discriminates acquisition phases without changing V1 review outcomes", () => {
    const episodes: readonly ReviewEpisode[] = [
      { status: "OPEN", attempt },
      ready,
      { status: "UNAVAILABLE", attempt, closure: null, reason: "HISTORY_UNAVAILABLE" },
      { status: "UNAVAILABLE", attempt, closure, reason: "WRITER_UNSETTLED" },
    ];

    expect(episodes.map(identity)).toEqual([
      "attempt-1",
      "closure-1",
      "HISTORY_UNAVAILABLE",
      "WRITER_UNSETTLED",
    ]);
  });

  test("represents ordered steering and frozen policy separately from closure identity", () => {
    expect(ready.requests.map((request) => request.deliveryId)).toEqual([
      "delivery-2",
      "delivery-1",
    ]);
    expect(ready.policy.source.config).toBeNull();
    expect(ready.closure.attempt.attemptId).not.toBe(ready.closure.closureId);
  });

  test("keeps exported provenance and acquisition discriminants exact", () => {
    expectTypeOf<EpisodeProvenance["kind"]>().toEqualTypeOf<"OBSERVED_NET_DELTA">();
    expectTypeOf<EpisodeProvenance["snapshotMode"]>().toEqualTypeOf<"NON_ATOMIC">();
    expectTypeOf<ReviewEpisode["status"]>().toEqualTypeOf<"OPEN" | "READY" | "UNAVAILABLE">();
    expectTypeOf<
      Extract<ReviewEpisode, { status: "READY" }>["provenance"]
    >().toEqualTypeOf<EpisodeProvenance>();
  });

  test("exposes readonly evidence and a closed reason union at compile time", () => {
    expectTypeOf<Extract<ReviewEpisode, { status: "READY" }>["requests"]>().toEqualTypeOf<
      readonly EpisodeRequest[]
    >();
    expectTypeOf<string>().not.toExtend<EpisodeUnavailableReason>();
    expectTypeOf<Extract<ReviewEpisode, { status: "OPEN" }>>().not.toHaveProperty("files");
    expectTypeOf<Extract<ReviewEpisode, { status: "UNAVAILABLE" }>>().not.toHaveProperty("policy");
  });
});
