import type {
  JevEvaluationPort,
  JevEvaluationResult,
  JevRequest,
  JevRuleEvaluationResult,
  JevRuleRequest,
  PolicyLoader,
} from "@jevguard/core";
import type { ReviewHistoryFileSystem, ReviewHistoryRecord } from "@jevguard/node-infra";
import { createLocalReviewHistory } from "@jevguard/node-infra";
import { describe, expect, test } from "vitest";
import type { ClaudeReviewHandoff } from "../src/hook";
import type {
  DeadlineResult,
  RenameResult,
  WorkerDependencies,
  WorkerFileSystem,
  WorkerLogCode,
} from "../src/worker";
import { CLAIM_ABANDONED_AFTER_MS, parseHandoff, runWorker } from "../src/worker";

const DIRECTORY = "/state/handoff";
const NOW = new Date("2026-10-05T12:00:00.000Z");
const PROMPT_MARKER = "PROMPT_MARKER_9917";
const PATCH_MARKER = "PATCH_MARKER_5530";
const PATH_MARKER = "src/path-marker-7741.ts";

class MemoryWorkerFiles implements WorkerFileSystem {
  readonly files = new Map<string, string>();
  readonly modified = new Map<string, number>();
  readonly failingRemovals = new Map<string, number>();
  readonly unreadable = new Set<string>();
  renameResult: "MOVED" | "FAILED" = "MOVED";

  list(directory: string): readonly string[] {
    const prefix = `${directory}/`;

    return [...this.files.keys()]
      .filter((path) => path.startsWith(prefix) && !path.slice(prefix.length).includes("/"))
      .map((path) => path.slice(prefix.length));
  }

  read(path: string): string | null {
    if ([...this.unreadable].some((suffix) => path.endsWith(suffix))) throw new Error("EIO");

    return this.files.get(path) ?? null;
  }

  modifiedMs(path: string): number | null {
    return this.files.has(path) ? (this.modified.get(path) ?? NOW.getTime() - 3_600_000) : null;
  }

  rename(from: string, to: string): RenameResult {
    const content = this.files.get(from);

    if (content === undefined) return "LOST";
    if (this.renameResult === "FAILED") return "FAILED";

    this.files.delete(from);
    this.files.set(to, content);

    return "MOVED";
  }

  remove(path: string): void {
    const failures = this.failingRemovals.get(path) ?? 0;

    if (failures > 0) {
      this.failingRemovals.set(path, failures - 1);

      throw new Error("EPERM");
    }

    this.files.delete(path);
  }

  ensureDirectory(): void {}

  put(name: string, content: string): void {
    this.files.set(`${DIRECTORY}/${name}`, content);
  }

  pending(): readonly string[] {
    return this.list(DIRECTORY);
  }

  claimed(): readonly string[] {
    return this.list(`${DIRECTORY}/claimed`);
  }
}

class FakeJev implements JevEvaluationPort {
  readonly requests: JevRequest[] = [];
  failure = false;
  hang = false;

  async evaluate(request: JevRequest): Promise<JevEvaluationResult> {
    this.requests.push(request);

    if (this.hang) return new Promise(() => undefined);

    if (request.kind === "BUILT_IN_BATCH") {
      if (this.failure) {
        return { kind: "BUILT_IN_BATCH", status: "FAILED", reason: "MISSING_CREDENTIAL" };
      }

      const answer = { status: "EVALUATED", noul: { violationProbability: 0.1 } } as const;

      return {
        kind: "BUILT_IN_BATCH",
        status: "EVALUATED",
        answers: { scopeCreep: answer, complexity: answer },
      };
    }

    return this.failure
      ? { kind: "RULE", status: "FAILED", reason: "MISSING_CREDENTIAL" }
      : { kind: "RULE", status: "EVALUATED", noul: { violationProbability: 0.1 } };
  }

  async evaluateRuleBatch(
    requests: readonly JevRuleRequest[],
  ): Promise<readonly JevRuleEvaluationResult[]> {
    const results = await Promise.all(requests.map((request) => this.evaluate(request)));

    return results.map((result) =>
      result.kind === "RULE"
        ? result
        : { kind: "RULE", status: "FAILED", reason: "INVALID_RESPONSE" },
    );
  }
}

class MemoryHistoryFiles implements ReviewHistoryFileSystem {
  contents = "";

  async readFile(): Promise<string | null> {
    return this.contents;
  }

  async appendFile(_path: string, data: string): Promise<void> {
    this.contents += data;
  }

  async sizeOf(): Promise<number | null> {
    return this.contents.length;
  }

  async writeFileAtomic(_path: string, data: string): Promise<void> {
    this.contents = data;
  }

  async ensureParentDirectory(): Promise<void> {}

  records(): readonly ReviewHistoryRecord[] {
    return this.contents
      .split("\n")
      .filter((line) => line !== "")
      .map((line) => JSON.parse(line));
  }
}

const RULES = [
  "## Example",
  "",
  "severity: error",
  "scope: src/**",
  "",
  "### Rule",
  "",
  "Module description.",
  "",
  "### Violation",
  "",
  "The change violates the rule.",
  "",
  "### Allowed",
  "",
  "Supporting changes.",
].join("\n");

const policy: PolicyLoader = {
  async load() {
    return { status: "LOADED", source: { rules: RULES, config: null } };
  },
};

class Harness {
  readonly files = new MemoryWorkerFiles();
  readonly jev = new FakeJev();
  readonly historyFiles = new MemoryHistoryFiles();
  readonly logs: WorkerLogCode[] = [];
  readonly policyRoots: string[] = [];
  readonly jevQueue: FakeJev[] = [];
  jevCreations = 0;
  policyLoader: PolicyLoader = policy;
  expireDeadline = false;
  expiredDeadlines = Number.POSITIVE_INFINITY;

  dependencies(): WorkerDependencies {
    return {
      handoffDirectory: DIRECTORY,
      files: this.files,
      now: () => NOW,
      history: createLocalReviewHistory({
        context: { cwd: "/cwd", environment: { get: () => undefined }, homedir: "/home/user" },
        fileSystem: this.historyFiles,
        now: () => NOW,
      }),
      policyFor: (root) => {
        this.policyRoots.push(root);

        return this.policyLoader;
      },
      parseConfig: () => ({ status: "PARSED", value: null }),
      jevFor: () => {
        this.jevCreations += 1;

        return this.jevQueue.shift() ?? this.jev;
      },
      deadline: {
        race: async <T>(work: Promise<T>): Promise<DeadlineResult<T>> => {
          if (this.expireDeadline && this.expiredDeadlines > 0) {
            this.expiredDeadlines -= 1;

            return { status: "DEADLINE" };
          }

          return { status: "DONE", value: await work };
        },
      },
      log: (code) => this.logs.push(code),
    };
  }

  run(): Promise<void> {
    return runWorker(this.dependencies());
  }

  turnIds(): readonly string[] {
    return this.historyFiles.records().map((record) => record.turnId);
  }
}

const SKIPPED = { status: "SKIPPED", reason: "NO_ATTRIBUTED_PATCH" } as const;

function handoff(
  ordinal: number,
  resolution: ClaudeReviewHandoff["resolution"],
  closedAt = `2026-10-05T11:0${ordinal}:00.000Z`,
): ClaudeReviewHandoff {
  return {
    version: 1,
    turnId: `claude-code:s:e:${ordinal}`,
    sessionId: "s",
    ordinal,
    projectRoot: `/project-${ordinal}`,
    closedAt,
    shellCoverage: [],
    epoch: "e",
    resolution,
  };
}

function turnResolution(ordinal: number): ClaudeReviewHandoff["resolution"] {
  return {
    status: "TURN",
    turn: {
      id: `claude-code:s:e:${ordinal}`,
      task: PROMPT_MARKER,
      files: [{ path: PATH_MARKER, patch: `diff --git a/x b/x\n+${PATCH_MARKER}` }],
    },
  };
}

function put(harness: Harness, value: ClaudeReviewHandoff): void {
  harness.files.put(`s-e-${value.ordinal}.json`, JSON.stringify(value));
}

describe("runWorker", () => {
  test("records a TURN through reviewTurn, loads policy from the handoff root and deletes it", async () => {
    const harness = new Harness();

    put(harness, handoff(0, turnResolution(0)));
    await harness.run();

    const [record, ...rest] = harness.historyFiles.records();

    expect(rest).toEqual([]);
    expect(record?.turnId).toBe("claude-code:s:e:0");
    expect(record?.summary.highestVerdict).toBe("PASS");
    expect(harness.jev.requests.length).toBeGreaterThan(0);
    expect(harness.policyRoots).toEqual(["/project-0"]);
    expect(harness.files.pending()).toEqual([]);
    expect(harness.files.claimed()).toEqual([]);
    expect(harness.logs).toContain("REVIEW_RECORDED:PASS");
  });

  test("records SKIPPED and UNAVAILABLE units without any Jev call", async () => {
    const harness = new Harness();

    put(harness, handoff(0, SKIPPED));
    put(
      harness,
      handoff(1, { status: "UNAVAILABLE", reason: "BLOCKED_EVIDENCE", causes: ["BLOCKED_PATH"] }),
    );
    await harness.run();

    const [skipped, unavailable] = harness.historyFiles.records();

    expect(harness.jev.requests).toEqual([]);
    expect(skipped?.summary.counts.skipped).toBeGreaterThan(0);
    expect(skipped?.summary.hasUnavailable).toBe(false);
    expect(unavailable?.results).toMatchObject([
      { outcome: "UNAVAILABLE", reason: "BLOCKED_EVIDENCE" },
    ]);
    expect(harness.logs).toContain("UNIT_UNAVAILABLE:BLOCKED_PATH");
    expect(harness.files.pending()).toEqual([]);
  });

  test("a failing Jev or missing credential records the core reason and continues", async () => {
    const harness = new Harness();

    harness.jev.failure = true;
    put(harness, handoff(0, turnResolution(0)));
    put(harness, handoff(1, turnResolution(1)));
    await harness.run();

    const records = harness.historyFiles.records();

    expect(harness.turnIds()).toEqual(["claude-code:s:e:0", "claude-code:s:e:1"]);
    expect(records.every((record) => record.summary.hasUnavailable)).toBe(true);
    expect(JSON.stringify(records)).toContain("JEV_FAILURE");
  });

  test("processes handoffs in closedAt order", async () => {
    const harness = new Harness();

    put(harness, handoff(0, SKIPPED, "2026-10-05T11:30:00.000Z"));
    put(harness, handoff(1, SKIPPED, "2026-10-05T11:10:00.000Z"));
    put(harness, handoff(2, SKIPPED, "2026-10-05T11:20:00.000Z"));
    await harness.run();

    expect(harness.turnIds()).toEqual([
      "claude-code:s:e:1",
      "claude-code:s:e:2",
      "claude-code:s:e:0",
    ]);
  });

  test("two concurrent workers record each handoff exactly once", async () => {
    const harness = new Harness();

    for (let ordinal = 0; ordinal < 4; ordinal += 1) {
      put(harness, handoff(ordinal, turnResolution(ordinal)));
    }

    await Promise.all([harness.run(), harness.run()]);

    expect([...harness.turnIds()].sort()).toEqual([
      "claude-code:s:e:0",
      "claude-code:s:e:1",
      "claude-code:s:e:2",
      "claude-code:s:e:3",
    ]);
    expect(harness.files.pending()).toEqual([]);
    expect(harness.files.claimed()).toEqual([]);
  });

  test("drops a claim older than one hour without re-reviewing it", async () => {
    const harness = new Harness();
    const abandoned = NOW.getTime() - CLAIM_ABANDONED_AFTER_MS - 1;
    const fresh = NOW.getTime() - CLAIM_ABANDONED_AFTER_MS;
    const content = JSON.stringify(handoff(0, turnResolution(0)));

    harness.files.put(`claimed/${abandoned}-s-e-0.json`, content);
    harness.files.put(`claimed/${fresh}-s-e-1.json`, content);
    await harness.run();

    expect(harness.historyFiles.records()).toEqual([]);
    expect(harness.files.claimed()).toEqual([`${fresh}-s-e-1.json`]);
    expect(harness.logs.filter((code) => code === "WORKER_CLAIM_ABANDONED")).toHaveLength(1);
  });

  test("deletes an invalid handoff with a log and no record", async () => {
    const harness = new Harness();
    const wrongVersion = { ...handoff(8, turnResolution(8)), version: 2 };

    harness.files.put("s-e-7.json", "{broken");
    harness.files.put("s-e-8.json", JSON.stringify(wrongVersion));
    await harness.run();

    expect(harness.historyFiles.records()).toEqual([]);
    expect(harness.files.pending()).toEqual([]);
    expect(harness.logs.filter((code) => code === "HANDOFF_INVALID")).toHaveLength(2);
  });

  test("a spent deadline records UNAVAILABLE/JEV_FAILURE and the worker continues", async () => {
    const harness = new Harness();

    harness.jev.hang = true;
    harness.expireDeadline = true;
    put(harness, handoff(0, turnResolution(0)));
    put(harness, handoff(1, SKIPPED));
    await harness.run();

    const [first, second] = harness.historyFiles.records();

    expect(first?.results).toMatchObject([{ outcome: "UNAVAILABLE", reason: "JEV_FAILURE" }]);
    expect(second?.turnId).toBe("claude-code:s:e:1");
    expect(harness.logs).toContain("REVIEW_DEADLINE_EXCEEDED");
  });

  test("a SKIPPED unit never touches the policy, even a missing or invalid one", async () => {
    const harness = new Harness();

    harness.policyLoader = {
      load: async () => ({ status: "FAILED", reason: "RULES_READ_FAILURE" }),
    };
    put(harness, handoff(0, SKIPPED));
    put(harness, handoff(1, SKIPPED));
    await harness.run();

    const records = harness.historyFiles.records();

    expect(records).toHaveLength(2);
    expect(records.every((record) => !record.summary.hasUnavailable)).toBe(true);
    expect(records[0]?.results.every((result) => result.outcome === "SKIPPED")).toBe(true);
    expect(JSON.stringify(records)).toContain("NO_ATTRIBUTED_PATCH");
    expect(harness.policyRoots).toEqual([]);
    expect(harness.jevCreations).toBe(0);
    expect(harness.jev.requests).toEqual([]);
  });

  test("a review that blows its deadline does not delay the next one", async () => {
    const harness = new Harness();
    const stuck = new FakeJev();
    const healthy = new FakeJev();

    stuck.hang = true;
    harness.jevQueue.push(stuck, healthy);
    harness.expireDeadline = true;
    harness.expiredDeadlines = 1;
    put(harness, handoff(0, turnResolution(0)));
    put(harness, handoff(1, turnResolution(1)));
    await harness.run();

    const [first, second] = harness.historyFiles.records();

    expect(harness.jevCreations).toBe(2);
    expect(first?.results).toMatchObject([{ outcome: "UNAVAILABLE", reason: "JEV_FAILURE" }]);
    expect(second?.summary.highestVerdict).toBe("PASS");
    expect(healthy.requests.length).toBeGreaterThan(0);
  });

  test("a half-written handoff is left for the next pass, an old broken one is deleted", async () => {
    const harness = new Harness();

    harness.files.put("s-e-0.json", "");
    harness.files.modified.set(`${DIRECTORY}/s-e-0.json`, NOW.getTime() - 1_000);
    harness.files.put("s-e-1.json", "");
    harness.files.modified.set(`${DIRECTORY}/s-e-1.json`, NOW.getTime() - 60_000);
    await harness.run();

    expect(harness.files.pending()).toEqual(["s-e-0.json"]);
    expect(harness.logs.filter((code) => code === "HANDOFF_INVALID")).toHaveLength(1);
    expect(harness.historyFiles.records()).toEqual([]);
  });

  test("a failed deletion is retried at the end and never stops the next handoff", async () => {
    const harness = new Harness();

    put(harness, handoff(0, SKIPPED));
    put(harness, handoff(1, SKIPPED));
    harness.files.failingRemovals.set(`${DIRECTORY}/claimed/${NOW.getTime()}-s-e-0.json`, 1);
    await harness.run();

    expect(harness.turnIds()).toEqual(["claude-code:s:e:0", "claude-code:s:e:1"]);
    expect(harness.files.claimed()).toEqual([]);
    expect(harness.logs).not.toContain("HANDOFF_CLEANUP_FAILED");
  });

  test("a deletion that keeps failing is logged and the drain still finishes", async () => {
    const harness = new Harness();

    put(harness, handoff(0, SKIPPED));
    put(harness, handoff(1, SKIPPED));
    harness.files.failingRemovals.set(`${DIRECTORY}/claimed/${NOW.getTime()}-s-e-0.json`, 99);
    await harness.run();

    expect(harness.turnIds()).toEqual(["claude-code:s:e:0", "claude-code:s:e:1"]);
    expect(harness.logs).toContain("HANDOFF_CLEANUP_FAILED");
  });

  test("a read error on one pending handoff does not abort the drain", async () => {
    const harness = new Harness();

    put(harness, handoff(0, SKIPPED));
    put(harness, handoff(1, SKIPPED));
    harness.files.unreadable.add("s-e-0.json");
    await harness.run();

    expect(harness.turnIds()).toEqual(["claude-code:s:e:1"]);
    expect(harness.logs).toContain("HANDOFF_PROCESS_FAILED");
  });

  test("entries that are not .json files are ignored in claimed", async () => {
    const harness = new Harness();

    harness.files.put("claimed/some-directory", "x");
    harness.files.put("claimed/1-s-e-0.json.tmp", "x");
    put(harness, handoff(0, SKIPPED));
    await harness.run();

    expect(harness.turnIds()).toEqual(["claude-code:s:e:0"]);
    expect(harness.files.claimed()).toEqual(["some-directory", "1-s-e-0.json.tmp"]);
    expect(harness.logs).not.toContain("WORKER_CLAIM_ABANDONED");
  });

  test("a rename that fails for a real reason is logged and does not loop", async () => {
    const harness = new Harness();

    harness.files.renameResult = "FAILED";
    put(harness, handoff(0, SKIPPED));
    await harness.run();

    expect(harness.logs).toContain("WORKER_CLAIM_FAILED");
    expect(harness.files.pending()).toEqual(["s-e-0.json"]);
    expect(harness.historyFiles.records()).toEqual([]);
  });

  test("the worker log never carries prompt, patch or path markers", async () => {
    const harness = new Harness();

    put(harness, handoff(0, turnResolution(0)));
    await harness.run();

    const log = JSON.stringify(harness.logs);

    for (const marker of [PROMPT_MARKER, PATCH_MARKER, PATH_MARKER, "/project-0"]) {
      expect(log).not.toContain(marker);
    }
  });

  test("ignores temporary files when listing pending work", async () => {
    const harness = new Harness();

    harness.files.put("s-e-0.json.abc.tmp", "{}");
    await harness.run();

    expect(harness.historyFiles.records()).toEqual([]);
    expect(harness.logs).toEqual(["WORKER_STARTED"]);
  });
});

describe("parseHandoff", () => {
  test("rejects a TURN whose id differs from the handoff turn id", () => {
    const value = handoff(0, turnResolution(1));

    expect(parseHandoff(JSON.stringify(value)).status).toBe("INVALID");
  });

  test("rejects a relative project root and an unknown shell coverage", () => {
    const valid = handoff(0, SKIPPED);

    expect(parseHandoff(JSON.stringify({ ...valid, projectRoot: "relative/dir" })).status).toBe(
      "INVALID",
    );
    expect(parseHandoff(JSON.stringify({ ...valid, shellCoverage: ["OTHER"] })).status).toBe(
      "INVALID",
    );
    expect(
      parseHandoff(JSON.stringify({ ...valid, shellCoverage: ["ADAPTER_GIT_DIFF"] })).status,
    ).toBe("VALID");
  });

  test("rejects unknown acquisition causes and shapes", () => {
    const unavailable = handoff(0, {
      status: "UNAVAILABLE",
      reason: "BLOCKED_EVIDENCE",
      causes: ["BLOCKED_PATH"],
    });
    const forged = {
      ...unavailable,
      resolution: { ...unavailable.resolution, causes: ["/etc/secret"] },
    };

    expect(parseHandoff(JSON.stringify(unavailable)).status).toBe("VALID");
    expect(parseHandoff(JSON.stringify(forged)).status).toBe("INVALID");
    expect(parseHandoff("[]").status).toBe("INVALID");
  });
});
