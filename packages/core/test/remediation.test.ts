import { describe, expect, test } from "vitest";
import {
  buildProposalRequest,
  buildProposalText,
  createRemediationProposalStore,
  DEFAULT_REMEDIATION_CONFIG,
  DEFAULT_EVIDENCE_POLICY,
  parseModelSpecifier,
  PROPOSER_AGENT_PROMPT,
  REMEDIATION_MAX_TASK_LENGTH,
  resolveRemediationConfig,
  type ParsedRule,
  type RemediationConfig,
  type ReviewResult,
  type RuleParseResults,
  type Turn,
} from "../src/index";

const PATCH = ["--- a/src/a.ts", "+++ b/src/a.ts", "@@ -1 +1 @@", "-old", "+new", ""].join("\n");
const DOCS_PATCH = [
  "--- a/docs/readme.md",
  "+++ b/docs/readme.md",
  "@@ -1 +1 @@",
  "-a",
  "+b",
  "",
].join("\n");
const OTHER_PATCH = ["--- a/outside.txt", "+++ b/outside.txt", "@@ -1 +1 @@", "-c", "+d", ""].join(
  "\n",
);

function parsedRule(overrides: Partial<ParsedRule> = {}): ParsedRule {
  return {
    id: "TEST-1",
    severity: "error",
    scope: "src/**",
    description: "Module description.",
    violation: "The change violates the rule.",
    allowed: null,
    ...overrides,
  };
}

function parsedRules(...rules: readonly ParsedRule[]): RuleParseResults {
  return rules.map((rule) => ({ status: "PARSED" as const, rule }));
}

function turn(overrides: Partial<Turn> = {}): Turn {
  return {
    id: "msg_1",
    task: "Implement the thing.",
    files: [{ path: "src/a.ts", patch: PATCH }],
    ...overrides,
  };
}

function ruleFail(probability = 0.8): Extract<ReviewResult, { kind: "RULE" }> {
  return {
    kind: "RULE",
    turnId: "msg_1",
    ruleId: "TEST-1",
    severity: "error",
    scopedPaths: ["src/a.ts"],
    outcome: "FAIL",
    violationProbability: probability,
  };
}

function builtInFail(probability = 0.95): ReviewResult {
  return {
    kind: "BUILT_IN",
    turnId: "msg_1",
    ruleId: null,
    checkId: "SCOPE-CREEP",
    severity: "error",
    scopedPaths: ["src/a.ts"],
    outcome: "FAIL",
    violationProbability: probability,
  };
}

const ENABLED: RemediationConfig = DEFAULT_REMEDIATION_CONFIG;

function config(overrides: Partial<RemediationConfig> = {}): RemediationConfig {
  return { ...DEFAULT_REMEDIATION_CONFIG, ...overrides };
}

describe("resolveRemediationConfig", () => {
  test("uses the documented defaults when the config or section is absent", () => {
    const expected = {
      status: "VALID",
      config: { autoPropose: true, proposeOn: ["FAIL"], model: "opencode/gpt-5.6-luna" },
    };

    expect(resolveRemediationConfig(null)).toEqual(expected);
    expect(resolveRemediationConfig(undefined)).toEqual(expected);
    expect(resolveRemediationConfig({})).toEqual(expected);
    expect(resolveRemediationConfig({ version: 1, thresholds: {} })).toEqual(expected);
    expect(resolveRemediationConfig({ version: 1, remediation: {} })).toEqual(expected);
  });

  test("accepts an explicit valid remediation section", () => {
    expect(
      resolveRemediationConfig({
        version: 1,
        remediation: { auto_propose: false, propose_on: ["FAIL"], model: "openai/gpt-5" },
      }),
    ).toEqual({
      status: "VALID",
      config: { autoPropose: false, proposeOn: ["FAIL"], model: "openai/gpt-5" },
    });
  });

  test.each([
    { label: "non-record config", value: 1 },
    { label: "non-record section", value: { remediation: 1 } },
    { label: "non-boolean auto_propose", value: { remediation: { auto_propose: "yes" } } },
    { label: "empty propose_on", value: { remediation: { propose_on: [] } } },
    { label: "WARN propose_on", value: { remediation: { propose_on: ["WARN"] } } },
    { label: "non-array propose_on", value: { remediation: { propose_on: "FAIL" } } },
    { label: "model without provider", value: { remediation: { model: "gpt-5" } } },
    { label: "model with extra segment", value: { remediation: { model: "a/b/c" } } },
    { label: "empty model", value: { remediation: { model: "" } } },
    { label: "unknown remediation key", value: { remediation: { auto_propose: true, extra: 1 } } },
  ])("rejects $label as INVALID_CONFIG", ({ value }) => {
    expect(resolveRemediationConfig(value)).toEqual({
      status: "INVALID",
      reason: "INVALID_CONFIG",
    });
  });
});

describe("parseModelSpecifier", () => {
  test("splits one provider/model specifier", () => {
    expect(parseModelSpecifier("opencode/gpt-5.6-luna")).toEqual({
      providerID: "opencode",
      modelID: "gpt-5.6-luna",
    });
  });

  test.each(["", "gpt-5", "a/b/c", "/model", "provider/", "a b/c", "a/b c"])(
    "rejects the malformed specifier %j",
    (model) => {
      expect(parseModelSpecifier(model)).toBeNull();
    },
  );
});

describe("buildProposalRequest", () => {
  test("builds one aggregate request from the complete safe full attributed patch", () => {
    const request = buildProposalRequest({
      turn: turn({
        files: [
          { path: "src/a.ts", patch: PATCH },
          { path: "docs/readme.md", patch: DOCS_PATCH },
          { path: "outside.txt", patch: OTHER_PATCH },
        ],
      }),
      sessionID: "ses_1",
      rules: parsedRules(parsedRule({ allowed: "Delegation is allowed." })),
      results: [ruleFail(0.8), builtInFail(0.95)],
      config: ENABLED,
    });

    expect(request).toEqual({
      evaluationId: "msg_1",
      sessionID: "ses_1",
      messageID: "msg_1",
      model: "opencode/gpt-5.6-luna",
      task: "Implement the thing.",
      paths: ["src/a.ts", "docs/readme.md", "outside.txt"],
      diff: [PATCH, DOCS_PATCH, OTHER_PATCH].join("\n"),
      ruleFindings: [
        {
          ruleId: "TEST-1",
          severity: "error",
          rule: {
            id: "TEST-1",
            description: "Module description.",
            violation: "The change violates the rule.",
            allowed: "Delegation is allowed.",
          },
          probability: 0.8,
          scopedPaths: ["src/a.ts"],
        },
      ],
      builtInFindings: [
        {
          checkId: "SCOPE-CREEP",
          severity: "error",
          probability: 0.95,
          scopedPaths: ["src/a.ts"],
        },
      ],
    });
  });

  test("uses the empty string for an absent Allowed section", () => {
    const request = buildProposalRequest({
      turn: turn(),
      sessionID: "ses_1",
      rules: parsedRules(parsedRule()),
      results: [ruleFail()],
      config: ENABLED,
    });

    expect(request?.ruleFindings[0]?.rule.allowed).toBe("");
  });

  test("keeps rules in result order and built-ins separately", () => {
    const request = buildProposalRequest({
      turn: turn(),
      sessionID: "ses_1",
      rules: parsedRules(parsedRule({ id: "SRC-1" }), parsedRule({ id: "SRC-2" })),
      results: [
        { ...ruleFail(0.8), ruleId: "SRC-1" } as ReviewResult,
        { ...ruleFail(0.9), ruleId: "SRC-2" } as ReviewResult,
        builtInFail(0.95),
      ],
      config: ENABLED,
    });

    expect(request?.ruleFindings.map((finding) => finding.ruleId)).toEqual(["SRC-1", "SRC-2"]);
    expect(request?.builtInFindings.map((finding) => finding.checkId)).toEqual(["SCOPE-CREEP"]);
  });

  test("returns null when auto-propose is disabled", () => {
    expect(
      buildProposalRequest({
        turn: turn(),
        sessionID: "ses_1",
        rules: parsedRules(parsedRule()),
        results: [ruleFail()],
        config: config({ autoPropose: false }),
      }),
    ).toBeNull();
  });

  test("returns null when FAIL is not a configured trigger", () => {
    expect(
      buildProposalRequest({
        turn: turn(),
        sessionID: "ses_1",
        rules: parsedRules(parsedRule()),
        results: [ruleFail()],
        config: config({ proposeOn: [] }),
      }),
    ).toBeNull();
  });

  test("returns null for a task longer than the bound instead of truncating", () => {
    expect(
      buildProposalRequest({
        turn: turn({ task: "x".repeat(REMEDIATION_MAX_TASK_LENGTH + 1) }),
        sessionID: "ses_1",
        rules: parsedRules(parsedRule()),
        results: [ruleFail()],
        config: ENABLED,
      }),
    ).toBeNull();
  });

  test.each([
    { label: "PASS", result: { ...ruleFail(), outcome: "PASS" } as ReviewResult },
    { label: "WARN", result: { ...ruleFail(), outcome: "WARN" } as ReviewResult },
    { label: "warning severity", result: { ...ruleFail(), severity: "warning" } as ReviewResult },
    {
      label: "UNAVAILABLE",
      result: { ...ruleFail(), outcome: "UNAVAILABLE", reason: "JEV_FAILURE" } as ReviewResult,
    },
    {
      label: "built-in WARN",
      result: { ...builtInFail(), outcome: "WARN" } as ReviewResult,
    },
  ])("returns null when no result is a $label failure", ({ result }) => {
    expect(
      buildProposalRequest({
        turn: turn(),
        sessionID: "ses_1",
        rules: parsedRules(parsedRule()),
        results: [result],
        config: ENABLED,
      }),
    ).toBeNull();
  });

  test("returns null when the parsed rule for a FAIL is missing", () => {
    expect(
      buildProposalRequest({
        turn: turn(),
        sessionID: "ses_1",
        rules: [],
        results: [ruleFail()],
        config: ENABLED,
      }),
    ).toBeNull();
  });

  test("returns null when the turn has no attributed patch", () => {
    expect(
      buildProposalRequest({
        turn: turn({ files: [{ path: "src/a.ts", patch: "" }] }),
        sessionID: "ses_1",
        rules: parsedRules(parsedRule()),
        results: [ruleFail()],
        config: ENABLED,
      }),
    ).toBeNull();
  });

  test("returns null when a rule-scoped FAIL meets blocked full-turn evidence", () => {
    expect(
      buildProposalRequest({
        turn: turn({
          files: [
            { path: "src/a.ts", patch: PATCH },
            { path: "docs/.env", patch: "SECRET=1" },
          ],
        }),
        sessionID: "ses_1",
        rules: parsedRules(parsedRule({ scope: "src/**" })),
        results: [ruleFail()],
        config: ENABLED,
      }),
    ).toBeNull();
  });

  test("returns null when a rule-scoped FAIL meets oversized full-turn evidence", () => {
    expect(
      buildProposalRequest({
        turn: turn({
          files: [
            { path: "src/a.ts", patch: PATCH },
            {
              path: "docs/big.ts",
              patch: "x".repeat(DEFAULT_EVIDENCE_POLICY.maxDiffLength + 1),
            },
          ],
        }),
        sessionID: "ses_1",
        rules: parsedRules(parsedRule({ scope: "src/**" })),
        results: [ruleFail()],
        config: ENABLED,
      }),
    ).toBeNull();
  });
});

describe("buildProposalText", () => {
  const request = buildProposalRequest({
    turn: turn(),
    sessionID: "ses_1",
    rules: parsedRules(parsedRule({ allowed: "Delegation is allowed." })),
    results: [ruleFail(0.8), builtInFail(0.95)],
    config: ENABLED,
  });

  test("carries the structured findings, task, and full attributed diff as data", () => {
    if (request === null) {
      throw new Error("expected a proposal request");
    }

    const text = buildProposalText(request);

    expect(text).toContain("rule_findings:");
    expect(text).toContain("- id: TEST-1");
    expect(text).toContain("violation_probability: 0.8");
    expect(text).toContain("allowed: Delegation is allowed.");
    expect(text).toContain("built_in_findings:");
    expect(text).toContain("- check_id: SCOPE-CREEP");
    expect(text).toContain("violation_probability: 0.95");
    expect(text).toContain("task:\nImplement the thing.");
    expect(text).toContain(PATCH);
    expect(text).toMatch(/untrusted data/i);
  });

  test("the proposer agent prompt asks for the exact output and forbids tools", () => {
    expect(PROPOSER_AGENT_PROMPT).toMatch(/Strategy, Why, Manual apply/);
    expect(PROPOSER_AGENT_PROMPT).toMatch(/no tools/i);
    expect(PROPOSER_AGENT_PROMPT).toMatch(/must not output code, a diff, or a patch/i);
    expect(PROPOSER_AGENT_PROMPT).toMatch(/never claim that any change was made/i);
  });
});

describe("remediation proposal store", () => {
  test("admits at most one proposal per evaluation identity", () => {
    const store = createRemediationProposalStore();

    expect(store.claim("msg_1")).toBe(true);
    expect(store.claim("msg_1")).toBe(false);
    expect(store.claim("msg_2")).toBe(true);
  });

  test("rejects an empty evaluation identity", () => {
    expect(createRemediationProposalStore().claim("")).toBe(false);
  });

  test("tracks child sessions independently of claims", () => {
    const store = createRemediationProposalStore();

    store.registerChildSession("ses_child");

    expect(store.isChildSession("ses_child")).toBe(true);
    expect(store.isChildSession("ses_other")).toBe(false);
    expect(store.claim("ses_child")).toBe(true);
  });

  test("does not register an empty child session", () => {
    const store = createRemediationProposalStore();

    store.registerChildSession("");

    expect(store.isChildSession("")).toBe(false);
  });
});
