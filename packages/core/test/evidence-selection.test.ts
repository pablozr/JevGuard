import { describe, expect, test } from "vitest";
import { DEFAULT_EVIDENCE_POLICY, selectRuleEvidence, selectTurnEvidence } from "../src/index";
import type { EvidencePolicy, ParsedRule, Turn, TurnFile } from "../src/index";

function file(path: string, patch: string): TurnFile {
  return { path, patch };
}

function makeTurn(overrides: Partial<Turn> = {}): Turn {
  return {
    id: "turn-1",
    task: "Add rate limiting.",
    files: [file("src/auth/login.ts", "diff --git a/src/auth/login.ts\n+const limit = 5;")],
    ...overrides,
  };
}

function makeRule(overrides: Partial<ParsedRule> = {}): ParsedRule {
  return {
    id: "ARCH-001",
    severity: "error",
    scope: null,
    description: "Controllers must not hold business logic.",
    violation: "A controller performs domain decisions directly.",
    allowed: null,
    ...overrides,
  };
}

describe("selectRuleEvidence", () => {
  test("skips when the turn has no attributed patch", () => {
    expect(selectRuleEvidence(makeTurn({ files: [] }), makeRule())).toEqual({
      status: "SKIPPED",
      reason: "NO_ATTRIBUTED_PATCH",
    });

    expect(selectRuleEvidence(makeTurn({ files: [file("src/a.ts", "")] }), makeRule())).toEqual({
      status: "SKIPPED",
      reason: "NO_ATTRIBUTED_PATCH",
    });

    expect(
      selectRuleEvidence(makeTurn({ files: [file("src/a.ts", "   \n")] }), makeRule()),
    ).toEqual({ status: "SKIPPED", reason: "NO_ATTRIBUTED_PATCH" });
  });

  test("skips when the scope matches no changed file", () => {
    const turn = makeTurn({ files: [file("docs/readme.md", "patch-md")] });
    const rule = makeRule({ scope: "src/**" });

    expect(selectRuleEvidence(turn, rule)).toEqual({
      status: "SKIPPED",
      reason: "NO_SCOPE_MATCH",
    });
  });

  test("selects every changed file and concatenates their patches when there is no scope", () => {
    const turn = makeTurn({
      files: [file("src/a.ts", "patch-a"), file("docs/b.md", "patch-b")],
    });
    const result = selectRuleEvidence(turn, makeRule({ scope: null }));

    expect(result).toEqual({
      status: "SELECTED",
      evidence: { files: ["src/a.ts", "docs/b.md"], diff: "patch-a\npatch-b" },
    });
  });

  test("a mixed turn sends only the patches applicable to the scope", () => {
    const turn = makeTurn({
      files: [
        file("src/a.ts", "patch-src-a"),
        file("backend/b.ts", "patch-backend-b"),
        file("src/c.ts", "patch-src-c"),
      ],
    });
    const result = selectRuleEvidence(turn, makeRule({ scope: "src/**" }));

    expect(result).toEqual({
      status: "SELECTED",
      evidence: { files: ["src/a.ts", "src/c.ts"], diff: "patch-src-a\npatch-src-c" },
    });

    if (result.status === "SELECTED") {
      expect(result.evidence.diff).not.toContain("patch-backend-b");
    }
  });

  test("matches Windows-style paths against POSIX scope globs", () => {
    const turn = makeTurn({
      files: [file("backend\\src\\app.ts", "patch-backend")],
    });
    const result = selectRuleEvidence(turn, makeRule({ scope: "backend/**" }));

    expect(result).toEqual({
      status: "SELECTED",
      evidence: { files: ["backend\\src\\app.ts"], diff: "patch-backend" },
    });
  });

  test("matches recursive scope globs including the repository root", () => {
    const turn = makeTurn({
      files: [file("root.ts", "patch-root"), file("src/deep/file.ts", "patch-deep")],
    });
    const result = selectRuleEvidence(turn, makeRule({ scope: "**/*.ts" }));

    expect(result.status).toBe("SELECTED");

    if (result.status === "SELECTED") {
      expect(result.evidence.files).toEqual(["root.ts", "src/deep/file.ts"]);
    }
  });

  test("counts the size limit only over the concatenated scoped diff", () => {
    const policy: EvidencePolicy = { ...DEFAULT_EVIDENCE_POLICY, maxDiffLength: 10 };
    const turn = makeTurn({
      files: [file("src/a.ts", "0123456789"), file("backend/big.ts", "x".repeat(1_000))],
    });
    const rule = makeRule({ scope: "src/**" });

    expect(selectRuleEvidence(turn, rule, policy).status).toBe("SELECTED");

    const overLimit = makeTurn({ files: [file("src/a.ts", "01234567890")] });

    expect(selectRuleEvidence(overLimit, makeRule({ scope: "src/**" }), policy)).toEqual({
      status: "UNAVAILABLE",
      reason: "OVERSIZED_DIFF",
    });
  });

  test("a sensitive file outside the scope is not sent and does not block", () => {
    const turn = makeTurn({
      files: [file("src/a.ts", "patch-src"), file(".env", "SECRET=1")],
    });
    const result = selectRuleEvidence(turn, makeRule({ scope: "src/**" }));

    expect(result).toEqual({
      status: "SELECTED",
      evidence: { files: ["src/a.ts"], diff: "patch-src" },
    });
  });

  test("a sensitive file inside the scope blocks the whole rule", () => {
    const turn = makeTurn({
      files: [file("src/a.ts", "patch-src"), file(".env", "SECRET=1")],
    });
    const result = selectRuleEvidence(turn, makeRule({ scope: "**" }));

    expect(result).toEqual({ status: "UNAVAILABLE", reason: "BLOCKED_EVIDENCE" });
  });

  test("blocks environment, key, and credential paths case-insensitively", () => {
    const files = [
      ".env",
      "config/.env.production",
      "keys/server.pem",
      "id_rsa",
      "home/.ssh/id_ed25519",
      "home/.aws/credentials",
      "certs/CLIENT.P12",
      "secrets/credentials.json",
      "C:\\repo\\.ENV.LOCAL",
      "C:\\Users\\me\\.SSH\\id_rsa",
    ];

    for (const path of files) {
      expect(selectRuleEvidence(makeTurn({ files: [file(path, "patch")] }), makeRule())).toEqual({
        status: "UNAVAILABLE",
        reason: "BLOCKED_EVIDENCE",
      });
    }
  });

  test("blocks an applicable file without an allowlisted extension", () => {
    const turn = makeTurn({ files: [file("src/a.ts", "patch-src"), file("Dockerfile", "patch")] });
    const result = selectRuleEvidence(turn, makeRule({ scope: null }));

    expect(result).toEqual({ status: "UNAVAILABLE", reason: "BLOCKED_EVIDENCE" });
  });

  test("without scope, safety evaluates every changed file", () => {
    const turn = makeTurn({ files: [file("src/a.ts", "patch-src"), file(".env", "SECRET=1")] });
    const result = selectRuleEvidence(turn, makeRule({ scope: null }));

    expect(result).toEqual({ status: "UNAVAILABLE", reason: "BLOCKED_EVIDENCE" });
  });

  test("never returns partial evidence for a rejected rule", () => {
    const turn = makeTurn({
      files: [file("src/a.ts", "patch-src"), file("src/.env", "SECRET=1")],
    });
    const result = selectRuleEvidence(turn, makeRule({ scope: "src/**" }));

    expect(result.status).not.toBe("SELECTED");
  });
});

describe("selectTurnEvidence", () => {
  test("selects every attributed nonempty file with no scope filtering", () => {
    const turn = makeTurn({
      files: [
        file("src/a.ts", "patch-src"),
        file("docs/readme.md", "patch-docs"),
        file("config/app.yaml", "patch-config"),
      ],
    });

    expect(selectTurnEvidence(turn)).toEqual({
      status: "SELECTED",
      evidence: {
        files: ["src/a.ts", "docs/readme.md", "config/app.yaml"],
        diff: "patch-src\npatch-docs\npatch-config",
      },
    });
  });

  test("skips when the turn has no attributed patch", () => {
    expect(selectTurnEvidence(makeTurn({ files: [] }))).toEqual({
      status: "SKIPPED",
      reason: "NO_ATTRIBUTED_PATCH",
    });

    expect(selectTurnEvidence(makeTurn({ files: [file("src/a.ts", "")] }))).toEqual({
      status: "SKIPPED",
      reason: "NO_ATTRIBUTED_PATCH",
    });

    expect(selectTurnEvidence(makeTurn({ files: [file("src/a.ts", "  \n")] }))).toEqual({
      status: "SKIPPED",
      reason: "NO_ATTRIBUTED_PATCH",
    });
  });

  test("drops empty patches but keeps every nonempty attributed file", () => {
    const turn = makeTurn({
      files: [
        file("src/a.ts", "patch-src"),
        file("docs/readme.md", ""),
        file("config/app.yaml", "patch-config"),
      ],
    });

    expect(selectTurnEvidence(turn)).toEqual({
      status: "SELECTED",
      evidence: { files: ["src/a.ts", "config/app.yaml"], diff: "patch-src\npatch-config" },
    });
  });

  test("blocks the whole selection when any attributed file is unsafe", () => {
    const turn = makeTurn({
      files: [file("src/a.ts", "patch-src"), file(".env", "SECRET=1")],
    });

    expect(selectTurnEvidence(turn)).toEqual({
      status: "UNAVAILABLE",
      reason: "BLOCKED_EVIDENCE",
    });
  });

  test("blocks an attributed file without an allowlisted extension", () => {
    const turn = makeTurn({ files: [file("Dockerfile", "patch")] });

    expect(selectTurnEvidence(turn)).toEqual({
      status: "UNAVAILABLE",
      reason: "BLOCKED_EVIDENCE",
    });
  });

  test("reports an oversized diff before evaluating safety", () => {
    const policy: EvidencePolicy = { ...DEFAULT_EVIDENCE_POLICY, maxDiffLength: 4 };
    const turn = makeTurn({ files: [file("src/.env", "SECRET=1")] });

    expect(selectTurnEvidence(turn, policy)).toEqual({
      status: "UNAVAILABLE",
      reason: "OVERSIZED_DIFF",
    });
  });

  test("counts the size limit over the complete concatenated diff", () => {
    const policy: EvidencePolicy = { ...DEFAULT_EVIDENCE_POLICY, maxDiffLength: 10 };
    const turn = makeTurn({
      files: [file("src/a.ts", "0123456789"), file("docs/b.md", "x".repeat(1_000))],
    });

    expect(selectTurnEvidence(turn, policy)).toEqual({
      status: "UNAVAILABLE",
      reason: "OVERSIZED_DIFF",
    });
  });

  test("never returns partial evidence", () => {
    const turn = makeTurn({
      files: [file("src/a.ts", "patch-src"), file("src/.env", "SECRET=1")],
    });

    expect(selectTurnEvidence(turn).status).not.toBe("SELECTED");
  });
});
