import type {
  ConfirmationResult,
  EnforceAckReadResult,
  EnforceAckRecord,
  EnforceAckWriteStatus,
  LocalEnforceAckStore,
  ReviewHistoryRecord,
  ReviewHistoryStrictReadResult,
} from "@jevguard/node-infra";
import { MAX_ACK_RULE_IDS } from "@jevguard/node-infra";
import { describe, expect, test } from "vitest";
import { parseAckArguments } from "../src/ack/arguments";
import { ACK_LIST_LIMIT, listAckCandidates, recordAck } from "../src/ack/execute";
import { ackConfirmationMessage, describeAckList, describeAckRecorded } from "../src/ack/messages";
import type { AckDependencies } from "../src/ack/types";

const NOW = new Date("2026-03-01T12:00:00.000Z");

function unit(
  turnId: string,
  timestamp: string,
  results: ReviewHistoryRecord["results"],
): ReviewHistoryRecord {
  return {
    timestamp,
    turnId,
    summary: {
      highestVerdict: "FAIL",
      hasUnavailable: false,
      counts: { pass: 0, warn: 0, fail: 1, skipped: 0, unavailable: 0 },
    },
    results,
  };
}

function errorFail(ruleId: string): ReviewHistoryRecord["results"][number] {
  return {
    kind: "RULE",
    ruleId,
    severity: "error",
    scopedPaths: [],
    outcome: "FAIL",
    violationProbability: 0.9,
  };
}

function fail(turnId: string, timestamp: string, ruleId = "SECRETS-001"): ReviewHistoryRecord {
  return unit(turnId, timestamp, [errorFail(ruleId)]);
}

class FakeAcks implements LocalEnforceAckStore {
  readonly records: EnforceAckRecord[] = [];
  failRead = false;
  failWrite = false;

  async read(): Promise<EnforceAckReadResult> {
    return this.failRead
      ? { status: "FAILED" }
      : { status: "READ", records: this.records, skippedLineCount: 0 };
  }

  async append(record: EnforceAckRecord): Promise<EnforceAckWriteStatus> {
    if (this.failWrite) return "FAILED";

    this.records.push(record);

    return "WRITTEN";
  }
}

interface Harness {
  readonly deps: AckDependencies;
  readonly acks: FakeAcks;
  readonly prompts: string[];
  readonly answers: ConfirmationResult[];
  historyFails: boolean;
  interactive: boolean;
}

function harness(records: readonly ReviewHistoryRecord[]): Harness {
  const acks = new FakeAcks();
  const prompts: string[] = [];
  const answers: ConfirmationResult[] = [];
  const state = {
    historyFails: false,
    interactive: true,
  };
  const deps: AckDependencies = {
    history: {
      readStrict: async (): Promise<ReviewHistoryStrictReadResult> =>
        state.historyFails
          ? { status: "FAILED" }
          : { status: "READ", records, skippedLineCount: 0 },
    },
    acks,
    now: () => NOW,
    isInteractiveTerminal: () => state.interactive,
    confirm: async (message) => {
      prompts.push(message);

      return answers.shift() ?? { status: "DECLINED" };
    },
  };

  return {
    deps,
    acks,
    prompts,
    answers,
    get historyFails() {
      return state.historyFails;
    },
    set historyFails(value: boolean) {
      state.historyFails = value;
    },
    get interactive() {
      return state.interactive;
    },
    set interactive(value: boolean) {
      state.interactive = value;
    },
  };
}

describe("parseAckArguments", () => {
  test("lists without arguments and acknowledges a number", () => {
    expect(parseAckArguments([])).toEqual({ kind: "LIST" });
    expect(parseAckArguments(["2"])).toEqual({ kind: "ACK", number: 2 });
  });

  test("refuses any flag, zero and repetitions", () => {
    for (const args of [["--yes"], ["0"], ["1", "2"], ["-1"], ["1.5"], [""]]) {
      expect(parseAckArguments(args)).toEqual({ kind: "USAGE" });
    }
  });
});

describe("listAckCandidates", () => {
  test("lists error-severity rule FAILs newest first", async () => {
    const h = harness([
      fail("t-old", "2026-02-01T00:00:00.000Z", "SECRETS-001"),
      fail("t-new", "2026-02-02T00:00:00.000Z", "DESTRUCTIVE-001"),
    ]);

    const listed = await listAckCandidates(h.deps);

    expect(listed).toEqual({
      status: "LISTED",
      total: 2,
      items: [
        {
          number: 1,
          turnId: "t-new",
          ruleIds: ["DESTRUCTIVE-001"],
          timestamp: "2026-02-02T00:00:00.000Z",
        },
        {
          number: 2,
          turnId: "t-old",
          ruleIds: ["SECRETS-001"],
          timestamp: "2026-02-01T00:00:00.000Z",
        },
      ],
    });
  });

  test("leaves out warnings, PASSes, operational outcomes and acknowledged units", async () => {
    const h = harness([
      fail("t-blocked", "2026-02-01T00:00:00.000Z"),
      unit("t-warning", "2026-02-02T00:00:00.000Z", [
        {
          kind: "RULE",
          ruleId: "ARCH-001",
          severity: "warning",
          scopedPaths: [],
          outcome: "FAIL",
          violationProbability: 0.5,
        },
      ]),
      unit("t-pass", "2026-02-03T00:00:00.000Z", [
        {
          kind: "RULE",
          ruleId: "ARCH-001",
          severity: "error",
          scopedPaths: [],
          outcome: "PASS",
          violationProbability: 0.1,
        },
      ]),
      unit("t-unavailable", "2026-02-04T00:00:00.000Z", [
        { kind: "REVIEW", outcome: "UNAVAILABLE", reason: "MISSING_ATTRIBUTED_DIFF" },
      ]),
    ]);

    h.acks.records.push({
      turnId: "t-blocked",
      ruleIds: ["SECRETS-001"],
      timestamp: "2026-02-05T00:00:00.000Z",
    });

    await expect(listAckCandidates(h.deps)).resolves.toEqual({
      status: "LISTED",
      total: 0,
      items: [],
    });
  });

  test("caps the listing and still reports the total", async () => {
    const records = Array.from({ length: ACK_LIST_LIMIT + 2 }, (_, index) =>
      fail(`t-${index}`, `2026-02-0${(index % 9) + 1}T00:00:00.000Z`),
    );
    const listed = await listAckCandidates(harness(records).deps);

    expect(listed.status).toBe("LISTED");

    if (listed.status === "LISTED") {
      expect(listed.items).toHaveLength(ACK_LIST_LIMIT);
      expect(listed.total).toBe(ACK_LIST_LIMIT + 2);
    }
  });

  test("fails when the history or the ledger cannot be read", async () => {
    const historyFail = harness([]);
    historyFail.historyFails = true;
    await expect(listAckCandidates(historyFail.deps)).resolves.toEqual({ status: "READ_FAILED" });

    const ledgerFail = harness([]);
    ledgerFail.acks.failRead = true;
    await expect(listAckCandidates(ledgerFail.deps)).resolves.toEqual({ status: "READ_FAILED" });
  });
});

describe("recordAck", () => {
  test("refuses off an interactive terminal before reading anything", async () => {
    const h = harness([fail("t1", "2026-02-01T00:00:00.000Z")]);
    h.interactive = false;

    await expect(recordAck(1, h.deps)).resolves.toEqual({ status: "NOT_INTERACTIVE" });
    expect(h.prompts).toEqual([]);
    expect(h.acks.records).toEqual([]);
  });

  test("records only after an explicit confirmation", async () => {
    const h = harness([fail("t1", "2026-02-01T00:00:00.000Z")]);
    h.answers.push({ status: "CONFIRMED" });

    await expect(recordAck(1, h.deps)).resolves.toEqual({
      status: "RECORDED",
      turnId: "t1",
      ruleIds: ["SECRETS-001"],
    });
    expect(h.acks.records).toEqual([
      { turnId: "t1", ruleIds: ["SECRETS-001"], timestamp: NOW.toISOString() },
    ]);
  });

  test("a unit with more blocked rules than a ledger line keeps is recorded with the first 32", async () => {
    const ruleIds = Array.from({ length: MAX_ACK_RULE_IDS + 1 }, (_, i) => `RULE-${i}`);
    const h = harness([
      unit(
        "t1",
        "2026-02-01T00:00:00.000Z",
        ruleIds.map((id) => errorFail(id)),
      ),
    ]);
    h.answers.push({ status: "CONFIRMED" });

    await expect(recordAck(1, h.deps)).resolves.toEqual({
      status: "RECORDED",
      turnId: "t1",
      ruleIds: ruleIds.slice(0, MAX_ACK_RULE_IDS),
    });
    expect(h.acks.records).toEqual([
      { turnId: "t1", ruleIds: ruleIds.slice(0, MAX_ACK_RULE_IDS), timestamp: NOW.toISOString() },
    ]);
    // The recorded line is one the ledger's own reader keeps: the unit leaves the listing.
    const listed = await listAckCandidates(h.deps);

    if (listed.status === "LISTED") expect(listed.items).toEqual([]);
  });

  test("a decline writes nothing", async () => {
    const h = harness([fail("t1", "2026-02-01T00:00:00.000Z")]);
    h.answers.push({ status: "DECLINED" });

    await expect(recordAck(1, h.deps)).resolves.toEqual({ status: "DECLINED" });
    expect(h.acks.records).toEqual([]);
  });

  test("a number past the displayed list still acknowledges its unit", async () => {
    const records = Array.from({ length: ACK_LIST_LIMIT + 2 }, (_, index) =>
      fail(`t-${index}`, `2026-02-0${(index % 9) + 1}T00:00:00.000Z`),
    );
    const h = harness(records);
    h.answers.push({ status: "CONFIRMED" });

    // Numbers count every unit, newest first: the oldest of the list is the last record.
    await expect(recordAck(ACK_LIST_LIMIT + 2, h.deps)).resolves.toEqual({
      status: "RECORDED",
      turnId: "t-0",
      ruleIds: ["SECRETS-001"],
    });
    expect(h.acks.records).toEqual([
      { turnId: "t-0", ruleIds: ["SECRETS-001"], timestamp: NOW.toISOString() },
    ]);
  });

  test("an out-of-range number writes nothing", async () => {
    const h = harness([fail("t1", "2026-02-01T00:00:00.000Z")]);

    await expect(recordAck(2, h.deps)).resolves.toEqual({ status: "NUMBER_OUT_OF_RANGE" });
    expect(h.prompts).toEqual([]);
  });

  test("a failed ledger write is reported", async () => {
    const h = harness([fail("t1", "2026-02-01T00:00:00.000Z")]);
    h.answers.push({ status: "CONFIRMED" });
    h.acks.failWrite = true;

    await expect(recordAck(1, h.deps)).resolves.toEqual({ status: "WRITE_FAILED" });
  });

  test("the confirmation names the unit and the rules only", () => {
    const message = ackConfirmationMessage({
      number: 1,
      turnId: "claude-code:session-1:0123456789abcdef:0",
      ruleIds: ["SECRETS-001", "DESTRUCTIVE-001"],
      timestamp: "2026-02-01T00:00:00.000Z",
    });

    expect(message).toContain("claude-code:session-1:0123456789abcdef:0");
    expect(message).toContain("SECRETS-001 + DESTRUCTIVE-001");
    // The gate reads the ledger on this branch, so the text can promise the silence.
    expect(message).toContain("The gate will not block it again.");
  });

  test("the recorded line names the unit and the rules only", () => {
    const message = describeAckRecorded({
      status: "RECORDED",
      turnId: "claude-code:session-1:0123456789abcdef:0",
      ruleIds: ["SECRETS-001"],
    });

    expect(message).toContain("claude-code:session-1:0123456789abcdef:0");
    expect(message).toContain("SECRETS-001");
    expect(message).toContain("The gate will not block it again.");
  });

  test("the listing text numbers the units and shows how to acknowledge", () => {
    const text = describeAckList(
      {
        status: "LISTED",
        total: 2,
        items: [
          {
            number: 1,
            turnId: "t-new",
            ruleIds: ["SECRETS-001"],
            timestamp: "2026-02-01T11:55:00.000Z",
          },
        ],
      },
      NOW,
    );

    expect(text).toContain("Units a FAIL could block");
    expect(text).toContain("jevguard ack 1");
    expect(text).toContain("Showing 1 of 2; the rest keep their numbers");
    expect(text).toContain("t-new");
  });
});
