import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  utimesSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type {
  DeliveryFindings,
  RemediationProposalRequest,
  RemediationRuleFinding,
} from "@jevguard/core";
import { buildProposalText, deliveryFindingsOf, PROPOSER_AGENT_PROMPT } from "@jevguard/core";
import { afterEach, beforeEach, describe, expect, test } from "vitest";
import { ORPHAN_TTL_MS } from "../src/capture/unit-state";
import type { ClaudeReviewHandoff } from "../src/hook";
import { parseProposalRequestFile } from "../src/presentation";
import {
  createNodeProposalStore,
  createNodeWorkerFileSystem,
  encodeProposalRequestFile,
} from "../src/worker";

const NOW = new Date("2026-10-05T12:00:00.000Z");
const EPOCH = "0123456789abcdef";
const TURN_ID = `claude-code:sess1:${EPOCH}:2`;

let dataHome = "";

beforeEach(() => {
  dataHome = mkdtempSync(join(tmpdir(), "jevguard-proposals-"));
});

afterEach(() => {
  rmSync(dataHome, { recursive: true, force: true });
});

const RULE_FINDING: RemediationRuleFinding = {
  ruleId: "no-eval",
  severity: "error",
  rule: {
    id: "no-eval",
    description: "No eval",
    violation: "Calls eval.",
    allowed: "Tests may.",
  },
  probability: 0.93,
  scopedPaths: ["src/a.ts"],
  locations: [{ path: "src/a.ts", hunk: { ordinal: 1, newStart: 3, newLines: 4 } }],
};

function request(overrides: Partial<RemediationProposalRequest> = {}): RemediationProposalRequest {
  return {
    evaluationId: TURN_ID,
    sessionID: "sess1",
    messageID: TURN_ID,
    model: "anthropic/project-model",
    task: "TASK_MARKER",
    paths: ["src/a.ts"],
    diff: "diff --git a/src/a.ts b/src/a.ts\n+DIFF_MARKER",
    ruleFindings: [RULE_FINDING],
    builtInFindings: [],
    ...overrides,
  };
}

function handoff(sessionId = "sess1"): ClaudeReviewHandoff {
  return {
    version: 1,
    turnId: `claude-code:${sessionId}:${EPOCH}:2`,
    sessionId,
    ordinal: 2,
    projectRoot: "/project",
    closedAt: NOW.toISOString(),
    shellCoverage: [],
    epoch: EPOCH,
    resolution: { status: "SKIPPED", reason: "NO_ATTRIBUTED_PATCH" },
  };
}

function storeFor(variables: Record<string, string>) {
  return createNodeProposalStore(
    { get: (name) => variables[name] },
    () => NOW,
    createNodeWorkerFileSystem(),
  );
}

const FINDINGS: DeliveryFindings = {
  findings: deliveryFindingsOf({ ruleFindings: [RULE_FINDING], builtInFindings: [] }),
  omitted: 0,
};

function encoded(
  delivery: "user" | "agent" = "user",
  model: string | null = "sonnet",
  overrides: Partial<Parameters<typeof encodeProposalRequestFile>[0]> = {},
) {
  return encodeProposalRequestFile({
    request: request(),
    findings: FINDINGS,
    fromDelivery: false,
    settings: { delivery, model },
    turnId: TURN_ID,
    now: NOW,
    ...overrides,
  });
}

const directory = () => join(dataHome, "jevguard", "claude-code", "proposals", "sess1");
const fileOf = () => join(directory(), `${EPOCH}-2.json`);

describe("encodeProposalRequestFile", () => {
  test("carries the core's system prompt and proposal text unchanged", () => {
    const file = encoded();

    expect(file.system).toBe(PROPOSER_AGENT_PROMPT);
    expect(file.prompt).toBe(buildProposalText(request()));
  });

  test("expires exactly 24 hours after it is created", () => {
    const file = encoded();

    expect(Date.parse(file.expiresAt) - Date.parse(file.createdAt)).toBe(ORPHAN_TTL_MS);
    expect(file.createdAt).toBe(NOW.toISOString());
  });

  test("uses the user's model, never the project's", () => {
    expect(encoded("user", "sonnet").model).toBe("sonnet");
    expect(encoded("user", null).model).toBeNull();
  });

  test("keeps the user's delivery and flags a unit that is itself a delivery", () => {
    const automatic = encoded("agent", null, { fromDelivery: true });

    expect(automatic.delivery).toBe("agent");
    expect(automatic.fromDelivery).toBe(true);
    expect(encoded("agent").fromDelivery).toBe(false);
  });

  test("an agent request carries every finding and a user request none", () => {
    expect(encoded("agent").findings).toEqual([
      {
        id: "no-eval",
        kind: "RULE",
        description: "No eval",
        severity: "error",
        probability: 0.93,
        violation: "Calls eval.",
        allowed: "Tests may.",
        locations: RULE_FINDING.locations,
      },
    ]);
    expect(encoded("user").findings).toEqual([]);
    expect(encoded("agent").v).toBe(2);
  });

  test("without a proposer request the prompts are null and the findings stay", () => {
    const findingsOnly = encoded("agent", null, { request: null });

    expect(findingsOnly.system).toBeNull();
    expect(findingsOnly.prompt).toBeNull();
    expect(findingsOnly.findings).toEqual(FINDINGS.findings);
    expect(
      parseProposalRequestFile(JSON.stringify(findingsOnly), { turnId: TURN_ID }, NOW.getTime()),
    ).toEqual(findingsOnly);
  });

  test("a full findings set is written whole with its omitted count, never downgraded", () => {
    const many = Array.from({ length: 32 }, (_, index) => ({
      ...RULE_FINDING,
      ruleId: `rule-${index}`,
      rule: { ...RULE_FINDING.rule, id: `rule-${index}`, violation: "x".repeat(1000) },
    }));
    const file = encoded("agent", null, {
      findings: {
        findings: deliveryFindingsOf({ ruleFindings: many, builtInFindings: [] }),
        omitted: 8,
      },
    });

    expect(file.delivery).toBe("agent");
    expect(file.findings).toHaveLength(32);
    expect(file.omitted).toBe(8);
    expect(
      parseProposalRequestFile(JSON.stringify(file), { turnId: TURN_ID }, NOW.getTime()),
    ).toEqual(file);
  });
});

describe("createNodeProposalStore", () => {
  test("writes a request the mod's parser accepts", () => {
    const file = encoded();

    expect(storeFor({ XDG_DATA_HOME: dataHome }).write(handoff(), file)).toBe("WRITTEN");
    expect(readFileSync(fileOf(), "utf8")).toBe(JSON.stringify(file));
    expect(
      parseProposalRequestFile(readFileSync(fileOf(), "utf8"), { turnId: TURN_ID }, NOW.getTime()),
    ).toEqual(file);
  });

  test.skipIf(process.platform === "win32")("the file is 0600 and its directory 0700", () => {
    storeFor({ XDG_DATA_HOME: dataHome }).write(handoff(), encoded());

    expect(statSync(fileOf()).mode & 0o777).toBe(0o600);
    expect(statSync(directory()).mode & 0o777).toBe(0o700);
  });

  test("never writes inside the project or its Git working tree", () => {
    const file = encoded();
    const repository = join(dataHome, "repo");
    const nested = join(repository, "packages", "app");

    mkdirSync(join(repository, ".git"), { recursive: true });
    mkdirSync(nested, { recursive: true });

    const insideTree = storeFor({ XDG_DATA_HOME: join(repository, "data") });
    const insideProject = storeFor({ XDG_DATA_HOME: join(nested, "data") });
    const monorepoRoot = { ...handoff(), projectRoot: nested };

    expect(insideTree.write(monorepoRoot, file)).toBe("FAILED");
    expect(insideProject.write({ ...handoff(), projectRoot: nested }, file)).toBe("FAILED");
    expect(existsSync(join(repository, "data"))).toBe(false);
    expect(existsSync(join(nested, "data"))).toBe(false);
    expect(storeFor({ XDG_DATA_HOME: dataHome }).write(monorepoRoot, file)).toBe("WRITTEN");
  });

  test("remove deletes the request of a unit", () => {
    const store = storeFor({ XDG_DATA_HOME: dataHome });

    store.write(handoff(), encoded());
    store.remove(handoff());

    expect(existsSync(fileOf())).toBe(false);
    expect(() => store.remove(handoff("../escape"))).not.toThrow();
  });

  test("an unsafe session id or an empty environment writes nothing", () => {
    const file = encoded();

    expect(storeFor({ XDG_DATA_HOME: dataHome }).write(handoff("../escape"), file)).toBe("FAILED");
    expect(storeFor({}).write(handoff(), file)).toBe("FAILED");
    expect(existsSync(join(dataHome, "jevguard"))).toBe(false);
  });

  test("sweep removes blank and expired requests and keeps recent ones", () => {
    mkdirSync(directory(), { recursive: true });

    const blank = join(directory(), "blank.json");
    const exact = join(directory(), "exact.json");
    const stale = join(directory(), "stale.json");
    const recent = join(directory(), "recent.json");

    for (const path of [exact, stale, recent]) writeFileSync(path, '{"sensitive":true}');

    writeFileSync(blank, "");

    const age = (path: string, milliseconds: number) => {
      const when = new Date(NOW.getTime() - milliseconds);

      utimesSync(path, when, when);
    };

    age(exact, ORPHAN_TTL_MS);
    age(stale, ORPHAN_TTL_MS + 1);
    age(recent, 1000);
    storeFor({ XDG_DATA_HOME: dataHome }).sweep();

    expect(existsSync(blank)).toBe(false);
    expect(existsSync(stale)).toBe(false);
    expect(existsSync(exact)).toBe(true);
    expect(existsSync(recent)).toBe(true);
  });

  test("sweep decides by size and age and never reads a request", () => {
    mkdirSync(directory(), { recursive: true });

    const kept = join(directory(), "kept.json");

    writeFileSync(kept, "x".repeat(1_000_000));

    const reads: string[] = [];
    const files = createNodeWorkerFileSystem();
    const store = createNodeProposalStore({ get: () => dataHome }, () => NOW, {
      ...files,
      read: (path) => {
        reads.push(path);

        return files.read(path);
      },
    });

    store.sweep();

    expect(reads).toEqual([]);
    expect(existsSync(kept)).toBe(true);
  });

  test("sweep never throws without a proposals directory", () => {
    expect(() => storeFor({ XDG_DATA_HOME: dataHome }).sweep()).not.toThrow();
    expect(() => storeFor({}).sweep()).not.toThrow();
  });
});
