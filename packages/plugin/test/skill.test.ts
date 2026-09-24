import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { afterAll, describe, expect, test } from "vitest";
import type { PluginInput } from "@opencode-ai/plugin";
import { JevGuardPlugin } from "../src/index";
import { appendSkillPath, createConfigHook } from "../src/skills/config-hook";
import { summarizeRules } from "../src/skills/jevguard-rules/rules-summary";
import {
  BUNDLED_SKILL_NAMES,
  resolveInstalledSkillDirectories,
  resolveSkillDirectory,
} from "../src/skills/skill-directory";

const TEST_DIR = dirname(fileURLToPath(import.meta.url));
const PACKAGE_DIR = resolve(TEST_DIR, "..");
const SKILL_MD = join(PACKAGE_DIR, "skills", "jevguard-rules", "SKILL.md");
const VALIDATOR = join(PACKAGE_DIR, "src", "skills", "jevguard-rules", "validate-rules.ts");
const INIT_SKILL_MD = join(PACKAGE_DIR, "skills", "jev-init", "SKILL.md");
const INIT_VALIDATOR = join(PACKAGE_DIR, "src", "skills", "jev-init", "validate-init.ts");

const RULE_BODY_SENTINEL = "POLICY_BODY_SENTINEL_4c1f";
const SECRET_SENTINEL = "SECRET_SENTINEL_9a7b";

const VALID_DOCUMENT = [
  "## ARCH-001",
  "",
  "severity: error",
  "scope: src/**",
  "",
  "### Rule",
  "",
  `Changes under src must stay readable. ${RULE_BODY_SENTINEL}`,
  "",
  "### Violation",
  "",
  "The change introduces unclear or unnecessarily complex code.",
  "",
  "### Allowed",
  "",
  "Straightforward implementation needed for the task.",
  "",
].join("\n");

const INVALID_DOCUMENT = [
  "## BROKEN-1",
  "",
  "### Rule",
  "",
  "Missing severity metadata.",
  "",
  "### Violation",
  "",
  "The block has no severity.",
  "",
].join("\n");

const VALID_CONFIG = [
  "version: 1",
  "",
  "thresholds:",
  "  error:",
  "    warn: 0.40",
  "    fail: 0.70",
  "  warning:",
  "    warn: 0.60",
  "",
  "remediation:",
  "  auto_propose: true",
  "  propose_on:",
  "    - FAIL",
  "  model: opencode/gpt-5.6-luna",
  "",
].join("\n");

const PROVENANCE_PREAMBLE = [
  "```yaml",
  "rules:",
  "  ARCH-001:",
  "    source: user",
  "  LANG-002:",
  "    source: inferred",
  "    evidence:",
  "      - AGENTS.md",
  "      - package.json",
  "```",
  "",
  "",
].join("\n");

const INIT_VALID_RULES =
  PROVENANCE_PREAMBLE +
  [
    "## ARCH-001",
    "",
    "severity: error",
    "",
    "### Rule",
    "",
    `Controllers hold no business logic. ${RULE_BODY_SENTINEL}`,
    "",
    "### Violation",
    "",
    "A controller makes a domain decision.",
    "",
    "## LANG-002",
    "",
    "severity: warning",
    "",
    "### Rule",
    "",
    "Public functions carry explicit return types.",
    "",
    "### Violation",
    "",
    "A public function omits its return type.",
    "",
  ].join("\n");

interface Frontmatter {
  readonly name: string;
  readonly description: string;
}

function inferredRuleDocument(severity: string, evidence: readonly string[]): string {
  return [
    "```yaml",
    "rules:",
    "  ARCH-001:",
    "    source: inferred",
    "    evidence:",
    ...evidence.map((entry) => `      - ${entry}`),
    "```",
    "",
    "## ARCH-001",
    "",
    `severity: ${severity}`,
    "",
    "### Rule",
    "",
    "A rule.",
    "",
    "### Violation",
    "",
    "A breach.",
    "",
  ].join("\n");
}

let tempRoot = "";

function tempDir(): string {
  if (tempRoot === "") {
    tempRoot = mkdtempSync(join(tmpdir(), "jevguard-skill-"));
  }

  return tempRoot;
}

afterAll(() => {
  if (tempRoot !== "") {
    rmSync(tempRoot, { recursive: true, force: true });
  }
});

function runValidator(args: readonly string[]): { status: number; stdout: string; stderr: string } {
  return runScript(VALIDATOR, args);
}

function runInitValidator(args: readonly string[]): {
  status: number;
  stdout: string;
  stderr: string;
} {
  return runScript(INIT_VALIDATOR, args);
}

function runScript(
  script: string,
  args: readonly string[],
): { status: number; stdout: string; stderr: string } {
  const result = spawnSync("bun", [script, ...args], {
    cwd: PACKAGE_DIR,
    encoding: "utf8",
  });

  return { status: result.status ?? -1, stdout: result.stdout ?? "", stderr: result.stderr ?? "" };
}

function writeTempFile(name: string, text: string): string {
  const path = join(tempDir(), name);

  writeFileSync(path, text, "utf8");

  return path;
}

function canCreateSymlink(): boolean {
  const target = join(tempDir(), "symlink-probe-target.txt");
  const link = join(tempDir(), "symlink-probe-link.txt");

  try {
    writeFileSync(target, "probe", "utf8");
    rmSync(link, { force: true });
    symlinkSync(target, link);
    rmSync(link, { force: true });

    return true;
  } catch {
    return false;
  }
}

const CAN_CREATE_SYMLINK = canCreateSymlink();

function parseFrontmatter(text: string): Frontmatter {
  const match = /^---\r?\n([\s\S]*?)\r?\n---/.exec(text);

  if (match === null) {
    throw new Error("missing frontmatter");
  }

  const body = match[1] ?? "";
  const name = /^name:\s*(.+)$/m.exec(body)?.[1]?.trim() ?? "";
  const description = /^description:\s*(.+)$/m.exec(body)?.[1]?.trim() ?? "";

  return { name, description };
}

function skillPaths(config: object): readonly string[] {
  const skills = Reflect.get(config, "skills");

  if (typeof skills !== "object" || skills === null) {
    return [];
  }

  const paths = Reflect.get(skills, "paths");

  return Array.isArray(paths)
    ? paths.filter((entry): entry is string => typeof entry === "string")
    : [];
}

describe("jevguard-rules summary", () => {
  test("summarizes a valid document with IDs and no invalid blocks", () => {
    expect(summarizeRules(VALID_DOCUMENT)).toEqual({
      status: "valid",
      ruleCount: 1,
      ruleIds: ["ARCH-001"],
      invalidCount: 0,
      invalidRuleIds: [],
      errorCodes: [],
    });
  });

  test("summarizes an invalid block with its ID and error code", () => {
    const summary = summarizeRules(INVALID_DOCUMENT);

    expect(summary.status).toBe("invalid");
    expect(summary.invalidCount).toBe(1);
    expect(summary.invalidRuleIds).toEqual(["BROKEN-1"]);
    expect(summary.errorCodes).toEqual(["MISSING_SEVERITY"]);
  });

  test("reports an empty document as a single MISSING_ID failure", () => {
    expect(summarizeRules("")).toEqual({
      status: "invalid",
      ruleCount: 1,
      ruleIds: [],
      invalidCount: 1,
      invalidRuleIds: [null],
      errorCodes: ["MISSING_ID"],
    });
  });
});

describe("jevguard-rules validator CLI", () => {
  test("reports a valid document without echoing policy content", () => {
    const path = writeTempFile("valid.md", VALID_DOCUMENT);
    const result = runValidator([path]);

    expect(result.status).toBe(0);

    const report = JSON.parse(result.stdout) as {
      readonly status: string;
      readonly ruleIds: readonly string[];
    };

    expect(report.status).toBe("valid");
    expect(report.ruleIds).toEqual(["ARCH-001"]);
    expect(result.stdout).not.toContain(RULE_BODY_SENTINEL);
    expect(result.stdout).not.toContain(SECRET_SENTINEL);
  });

  test("reports an invalid document with a safe error code", () => {
    const path = writeTempFile("invalid.md", INVALID_DOCUMENT);
    const result = runValidator([path]);

    expect(result.status).toBe(1);

    const report = JSON.parse(result.stdout) as {
      readonly status: string;
      readonly errorCodes: readonly string[];
    };

    expect(report.status).toBe("invalid");
    expect(report.errorCodes).toEqual(["MISSING_SEVERITY"]);
    expect(result.stdout).not.toContain("Missing severity metadata");
  });

  test("fails safely on a missing argument", () => {
    const result = runValidator([]);

    expect(result.status).toBe(2);
    expect(JSON.parse(result.stdout)).toEqual({
      status: "error",
      errorCode: "EXPECTED_ONE_PATH_ARGUMENT",
    });
  });

  test("fails safely on a missing file", () => {
    const result = runValidator([join(tempDir(), "does-not-exist.md")]);

    expect(result.status).toBe(2);
    expect(JSON.parse(result.stdout)).toEqual({ status: "error", errorCode: "NOT_A_FILE" });
  });

  test("fails safely when the path is a directory", () => {
    const result = runValidator([tempDir()]);

    expect(result.status).toBe(2);
    expect(JSON.parse(result.stdout)).toEqual({ status: "error", errorCode: "NOT_A_FILE" });
  });
});

describe("jev-init validator CLI", () => {
  test("reports a valid init pair with rule IDs and no content", () => {
    const rules = writeTempFile("init-valid-rules.md", INIT_VALID_RULES);
    const config = writeTempFile("init-valid-config.yaml", VALID_CONFIG);
    const result = runInitValidator([rules, config]);

    expect(result.status).toBe(0);

    const report = JSON.parse(result.stdout) as {
      readonly status: string;
      readonly ruleIds: readonly string[];
      readonly codes: readonly string[];
    };

    expect(report.status).toBe("valid");
    expect(report.ruleIds).toEqual(["ARCH-001", "LANG-002"]);
    expect(report.codes).toEqual([]);
    expect(result.stdout).not.toContain(RULE_BODY_SENTINEL);
    expect(result.stdout).not.toContain(SECRET_SENTINEL);
  });

  test("reports a missing provenance preamble", () => {
    const rules = writeTempFile(
      "init-no-provenance.md",
      VALID_DOCUMENT.replace("scope: src/**\n", ""),
    );
    const config = writeTempFile("init-no-provenance.yaml", VALID_CONFIG);
    const result = runInitValidator([rules, config]);

    expect(result.status).toBe(1);

    const report = JSON.parse(result.stdout) as {
      readonly status: string;
      readonly codes: readonly string[];
    };

    expect(report.status).toBe("invalid");
    expect(report.codes).toEqual(["PROVENANCE_MISSING"]);
  });

  test("reports unknown and missing rule associations", () => {
    const rules = writeTempFile(
      "init-association.md",
      [
        "```yaml",
        "rules:",
        "  GHOST-999:",
        "    source: user",
        "```",
        "",
        "## ARCH-001",
        "",
        "severity: error",
        "",
        "### Rule",
        "",
        "A rule.",
        "",
        "### Violation",
        "",
        "A breach.",
        "",
      ].join("\n"),
    );
    const config = writeTempFile("init-association.yaml", VALID_CONFIG);
    const result = runInitValidator([rules, config]);

    expect(result.status).toBe(1);

    const report = JSON.parse(result.stdout) as { readonly codes: readonly string[] };

    expect(report.codes).toEqual(["PROVENANCE_MISSING_RULE", "PROVENANCE_UNKNOWN_RULE"]);
  });

  test("requires evidence for an inferred rule", () => {
    const rules = writeTempFile(
      "init-inferred.md",
      [
        "```yaml",
        "rules:",
        "  ARCH-001:",
        "    source: inferred",
        "```",
        "",
        "## ARCH-001",
        "",
        "severity: warning",
        "",
        "### Rule",
        "",
        "A rule.",
        "",
        "### Violation",
        "",
        "A breach.",
        "",
      ].join("\n"),
    );
    const config = writeTempFile("init-inferred.yaml", VALID_CONFIG);
    const result = runInitValidator([rules, config]);

    expect(result.status).toBe(1);

    const report = JSON.parse(result.stdout) as { readonly codes: readonly string[] };

    expect(report.codes).toContain("PROVENANCE_MISSING_EVIDENCE");
  });

  test("rejects an inferred rule with only one safe evidence path", () => {
    const rules = writeTempFile(
      "init-one-evidence.md",
      inferredRuleDocument("warning", ["AGENTS.md"]),
    );
    const config = writeTempFile("init-one-evidence.yaml", VALID_CONFIG);
    const result = runInitValidator([rules, config]);

    expect(result.status).toBe(1);

    const report = JSON.parse(result.stdout) as { readonly codes: readonly string[] };

    expect(report.codes).toEqual(["PROVENANCE_INSUFFICIENT_EVIDENCE"]);
  });

  test("rejects an inferred rule that did not parse as warning severity", () => {
    const rules = writeTempFile(
      "init-inferred-error.md",
      inferredRuleDocument("error", ["AGENTS.md", "package.json"]),
    );
    const config = writeTempFile("init-inferred-error.yaml", VALID_CONFIG);
    const result = runInitValidator([rules, config]);

    expect(result.status).toBe(1);

    const report = JSON.parse(result.stdout) as { readonly codes: readonly string[] };

    expect(report.codes).toEqual(["PROVENANCE_INFERRED_SEVERITY"]);
  });

  test("accepts an inferred rule with warning severity and two safe evidence paths", () => {
    const rules = writeTempFile(
      "init-inferred-valid.md",
      inferredRuleDocument("warning", ["AGENTS.md", "package.json"]),
    );
    const config = writeTempFile("init-inferred-valid.yaml", VALID_CONFIG);
    const result = runInitValidator([rules, config]);

    expect(result.status).toBe(0);

    const report = JSON.parse(result.stdout) as {
      readonly status: string;
      readonly codes: readonly string[];
    };

    expect(report.status).toBe("valid");
    expect(report.codes).toEqual([]);
  });

  test("rejects a .git evidence path", () => {
    const rules = writeTempFile(
      "init-git-evidence.md",
      inferredRuleDocument("warning", [".git/config", "AGENTS.md"]),
    );
    const config = writeTempFile("init-git-evidence.yaml", VALID_CONFIG);
    const result = runInitValidator([rules, config]);

    expect(result.status).toBe(1);

    const report = JSON.parse(result.stdout) as { readonly codes: readonly string[] };

    expect(report.codes).toContain("PROVENANCE_INVALID_EVIDENCE");
    expect(result.stdout).not.toContain(".git");
  });

  test("rejects unsafe and absolute evidence paths", () => {
    const rules = writeTempFile(
      "init-evidence.md",
      [
        "```yaml",
        "rules:",
        "  ARCH-001:",
        "    source: inferred",
        "    evidence:",
        "      - ../secrets/.env",
        "      - /etc/passwd",
        "      - .ssh/id_rsa",
        "```",
        "",
        "## ARCH-001",
        "",
        "severity: warning",
        "",
        "### Rule",
        "",
        "A rule.",
        "",
        "### Violation",
        "",
        "A breach.",
        "",
      ].join("\n"),
    );
    const config = writeTempFile("init-evidence.yaml", VALID_CONFIG);
    const result = runInitValidator([rules, config]);

    expect(result.status).toBe(1);

    const report = JSON.parse(result.stdout) as { readonly codes: readonly string[] };

    expect(report.codes).toContain("PROVENANCE_INVALID_EVIDENCE");
    expect(result.stdout).not.toContain("passwd");
    expect(result.stdout).not.toContain("id_rsa");
  });

  test("rejects a rule heading smuggled inside the manifest", () => {
    const rules = writeTempFile(
      "init-unsafe.md",
      [
        "```yaml",
        "rules:",
        "  ARCH-001:",
        "    source: user",
        "## HACK-001",
        "```",
        "",
        "## ARCH-001",
        "",
        "severity: error",
        "",
        "### Rule",
        "",
        "A rule.",
        "",
        "### Violation",
        "",
        "A breach.",
        "",
      ].join("\n"),
    );
    const config = writeTempFile("init-unsafe.yaml", VALID_CONFIG);
    const result = runInitValidator([rules, config]);

    expect(result.status).toBe(1);

    const report = JSON.parse(result.stdout) as { readonly codes: readonly string[] };

    expect(report.codes).toContain("PROVENANCE_UNSAFE_PREAMBLE");
    expect(result.stdout).not.toContain("HACK-001");
  });

  test("reports a malformed manifest shape and an invalid source", () => {
    const malformed = writeTempFile(
      "init-malformed.md",
      [
        "```yaml",
        "rules:",
        "  ARCH-001:",
        "    source: user",
        "extra: true",
        "```",
        "",
        "## ARCH-001",
        "",
        "severity: error",
        "",
        "### Rule",
        "",
        "A rule.",
        "",
        "### Violation",
        "",
        "A breach.",
        "",
      ].join("\n"),
    );
    const config = writeTempFile("init-malformed.yaml", VALID_CONFIG);
    const malformedResult = runInitValidator([malformed, config]);

    expect(malformedResult.status).toBe(1);
    expect(JSON.parse(malformedResult.stdout)).toMatchObject({
      codes: expect.arrayContaining(["PROVENANCE_MALFORMED"]),
    });

    const invalidSource = writeTempFile(
      "init-source.md",
      [
        "```yaml",
        "rules:",
        "  ARCH-001:",
        "    source: guessed",
        "```",
        "",
        "## ARCH-001",
        "",
        "severity: error",
        "",
        "### Rule",
        "",
        "A rule.",
        "",
        "### Violation",
        "",
        "A breach.",
        "",
      ].join("\n"),
    );
    const sourceResult = runInitValidator([invalidSource, config]);

    expect(sourceResult.status).toBe(1);
    expect(JSON.parse(sourceResult.stdout)).toMatchObject({
      codes: expect.arrayContaining(["PROVENANCE_INVALID_SOURCE"]),
    });
  });

  test("reports an invalid gate threshold as CONFIG_INVALID", () => {
    const rules = writeTempFile("init-bad-gate-rules.md", INIT_VALID_RULES);
    const config = writeTempFile(
      "init-bad-gate.yaml",
      [
        "version: 1",
        "thresholds:",
        "  error:",
        "    warn: 0.80",
        "    fail: 0.70",
        "  warning:",
        "    warn: 0.60",
        "",
      ].join("\n"),
    );
    const result = runInitValidator([rules, config]);

    expect(result.status).toBe(1);

    const report = JSON.parse(result.stdout) as { readonly codes: readonly string[] };

    expect(report.codes).toEqual(["CONFIG_INVALID"]);
  });

  test("reports a malformed remediation section as REMEDIATION_INVALID", () => {
    const rules = writeTempFile("init-bad-remediation-rules.md", INIT_VALID_RULES);
    const config = writeTempFile(
      "init-bad-remediation.yaml",
      [
        "version: 1",
        "thresholds:",
        "  error:",
        "    warn: 0.40",
        "    fail: 0.70",
        "  warning:",
        "    warn: 0.60",
        "",
        "remediation:",
        "  model: not-a-provider-model",
        "",
      ].join("\n"),
    );
    const result = runInitValidator([rules, config]);

    expect(result.status).toBe(1);

    const report = JSON.parse(result.stdout) as { readonly codes: readonly string[] };

    expect(report.codes).toEqual(["REMEDIATION_INVALID"]);
  });

  test("reports unsafe config YAML as CONFIG_PARSE_INVALID without echoing it", () => {
    const rules = writeTempFile("init-bad-yaml-rules.md", INIT_VALID_RULES);
    const config = writeTempFile(
      "init-bad-yaml.yaml",
      `version: 1\nthresholds: &anchor { error: { warn: 0.4 } }\n`,
    );
    const result = runInitValidator([rules, config]);

    expect(result.status).toBe(1);

    const report = JSON.parse(result.stdout) as { readonly codes: readonly string[] };

    expect(report.codes).toEqual(["CONFIG_PARSE_INVALID"]);
    expect(result.stdout).not.toContain("anchor");
  });

  test("fails safely for the wrong argument count", () => {
    expect(JSON.parse(runInitValidator([]).stdout)).toEqual({
      status: "error",
      errorCode: "EXPECTED_TWO_PATH_ARGUMENTS",
    });
    expect(runInitValidator([]).status).toBe(2);

    const one = runInitValidator([writeTempFile("init-one.md", INIT_VALID_RULES)]);

    expect(one.status).toBe(2);
    expect(JSON.parse(one.stdout)).toEqual({
      status: "error",
      errorCode: "EXPECTED_TWO_PATH_ARGUMENTS",
    });

    const three = runInitValidator([
      writeTempFile("init-three-rules.md", INIT_VALID_RULES),
      writeTempFile("init-three-config.yaml", VALID_CONFIG),
      writeTempFile("init-three-extra.txt", "extra"),
    ]);

    expect(three.status).toBe(2);
    expect(JSON.parse(three.stdout)).toEqual({
      status: "error",
      errorCode: "EXPECTED_TWO_PATH_ARGUMENTS",
    });
  });

  test("fails safely on a missing or non-file path", () => {
    const config = writeTempFile("init-missing-config.yaml", VALID_CONFIG);
    const missing = runInitValidator([join(tempDir(), "no-rules.md"), config]);

    expect(missing.status).toBe(2);
    expect(JSON.parse(missing.stdout)).toEqual({ status: "error", errorCode: "NOT_A_FILE" });

    const directory = runInitValidator([tempDir(), config]);

    expect(directory.status).toBe(2);
    expect(JSON.parse(directory.stdout)).toEqual({ status: "error", errorCode: "NOT_A_FILE" });
  });

  test.skipIf(!CAN_CREATE_SYMLINK)("rejects a symlinked candidate before reading it", () => {
    const target = writeTempFile("init-symlink-target.md", INIT_VALID_RULES);
    const config = writeTempFile("init-symlink-config.yaml", VALID_CONFIG);
    const link = join(tempDir(), "init-symlink-rules.md");

    rmSync(link, { force: true });
    symlinkSync(target, link);

    const result = runInitValidator([link, config]);

    expect(result.status).toBe(2);
    expect(JSON.parse(result.stdout)).toEqual({ status: "error", errorCode: "SYMLINK_PATH" });
  });
});

describe("jevguard-rules config hook", () => {
  const directory = resolve("skills", "jevguard-rules");

  test("adds a new skills.paths entry when skills is absent", () => {
    const config: Record<string, unknown> = {};

    appendSkillPath(config, directory);

    expect(skillPaths(config)).toEqual([directory]);
  });

  test("appends without duplicating and preserves existing paths and keys", () => {
    const config: Record<string, unknown> = {
      skills: { paths: ["/existing/skill"], urls: ["https://example.com/skills"] },
      model: "openai/gpt-5.6-terra",
    };

    appendSkillPath(config, directory);
    appendSkillPath(config, directory);

    expect(skillPaths(config)).toEqual(["/existing/skill", directory]);
    expect(Reflect.get(Reflect.get(config, "skills") as object, "urls")).toEqual([
      "https://example.com/skills",
    ]);
    expect(Reflect.get(config, "model")).toBe("openai/gpt-5.6-terra");
  });

  test("leaves an unexpected skills shape untouched", () => {
    const config: Record<string, unknown> = { skills: "not-an-object" };

    appendSkillPath(config, directory);

    expect(Reflect.get(config, "skills")).toBe("not-an-object");
  });

  test("leaves an unexpected paths shape untouched", () => {
    const config: Record<string, unknown> = { skills: { paths: "not-an-array" } };

    appendSkillPath(config, directory);

    expect(Reflect.get(Reflect.get(config, "skills") as object, "paths")).toBe("not-an-array");
  });

  test("ignores a non-object config without throwing", () => {
    expect(() => appendSkillPath(null, directory)).not.toThrow();
    expect(() => appendSkillPath("config", directory)).not.toThrow();
  });

  test("does nothing when no installed skill directory is known", async () => {
    const config: Record<string, unknown> = {};

    await createConfigHook({ skillDirectories: [] })(config);

    expect(skillPaths(config)).toEqual([]);
  });

  test("registers every provided skill directory in order", async () => {
    const config: Record<string, unknown> = {};
    const first = resolve("skills", "jevguard-rules");
    const second = resolve("skills", "jev-init");

    await createConfigHook({ skillDirectories: [first, second] })(config);

    expect(skillPaths(config)).toEqual([first, second]);
  });
});

describe("bundled skill directories", () => {
  test("defines the bundled skills in registration order", () => {
    expect(BUNDLED_SKILL_NAMES).toEqual(["jevguard-rules", "jev-init"]);
  });

  test("prefers an existing candidate and skips one without SKILL.md", () => {
    const moduleUrl = pathToFileURL(join(PACKAGE_DIR, "src", "plugin.ts")).href;
    const seen: string[] = [];
    const expected = join(PACKAGE_DIR, "skills", "jevguard-rules");

    const resolved = resolveSkillDirectory(moduleUrl, "jevguard-rules", (path) => {
      seen.push(path);

      return path === join(expected, "SKILL.md");
    });

    expect(resolved).toBe(expected);
    expect(seen).toContain(join(PACKAGE_DIR, "src", "skills", "jevguard-rules", "SKILL.md"));
  });

  test("returns null when no candidate contains SKILL.md", () => {
    const moduleUrl = pathToFileURL(join(PACKAGE_DIR, "index.js")).href;

    expect(resolveSkillDirectory(moduleUrl, "jevguard-rules", () => false)).toBeNull();
  });

  test("resolves both installed skills from the source layout", () => {
    const moduleUrl = pathToFileURL(join(PACKAGE_DIR, "src", "plugin.ts")).href;
    const expected = [
      join(PACKAGE_DIR, "skills", "jevguard-rules"),
      join(PACKAGE_DIR, "skills", "jev-init"),
    ];

    expect(resolveInstalledSkillDirectories(moduleUrl)).toEqual(expected);
  });
});

describe("JevGuardPlugin skill registration", () => {
  test("adds every installed skill directory to the live config", async () => {
    const plugin = JevGuardPlugin;
    const hooks = await plugin({
      client: {},
      worktree: process.cwd(),
    } as unknown as PluginInput);
    const config: object = {};

    expect(typeof hooks.config).toBe("function");

    await hooks.config?.(config);

    const expected = [
      resolve(PACKAGE_DIR, "skills", "jevguard-rules"),
      resolve(PACKAGE_DIR, "skills", "jev-init"),
    ];

    expect(skillPaths(config).map((path) => path.replaceAll("\\", "/"))).toEqual(
      expected.map((path) => path.replaceAll("\\", "/")),
    );
  });
});

describe("jevguard-rules SKILL.md contract", () => {
  const text = readFileSync(SKILL_MD, "utf8");
  const flat = text.replace(/\s+/g, " ");

  test("uses the required name and a concrete trigger description", () => {
    const frontmatter = parseFrontmatter(text);
    const directoryName = dirname(SKILL_MD).replaceAll("\\", "/").split("/").pop();

    expect(frontmatter.name).toBe("jevguard-rules");
    expect(frontmatter.name).toBe(directoryName);
    expect(frontmatter.description.length).toBeGreaterThan(0);
    expect(frontmatter.description.length).toBeLessThanOrEqual(1024);
    expect(frontmatter.description).toMatch(/\.jev\/rules\.md/);
  });

  test("documents the validation, confirmation, and cleanup workflow", () => {
    expect(text).toContain("validate-rules.js");
    expect(text).toContain(".jev/rules.md");
    expect(text).toMatch(/confirmation/i);
    expect(flat).toMatch(/write the confirmed candidate/i);
  });

  test("preserves the jev-init provenance preamble", () => {
    expect(flat).toMatch(/preserve an existing `jev-init` provenance preamble/i);
    expect(flat).toMatch(/source: user/);
    expect(flat).toMatch(/never introduce `source: inferred`/i);
    expect(flat).toMatch(/do not invent one/i);
  });

  test("ties the observed target version to replacement with a conditional primitive", () => {
    expect(flat).toMatch(
      /obtain a primitive that atomically ties the observed target version to the replacement/i,
    );
    expect(flat).toMatch(
      /compare-and-swap that replaces `\.jev\/rules\.md` only while it still matches the exact version observed in step 1/i,
    );
    expect(flat).toMatch(
      /exclusive lock on the target that you hold from the byte-for-byte re-read/i,
    );
    expect(flat).toMatch(/Do not release the lock or discard the compare-and-swap token/i);
    expect(flat).toMatch(/re-read `\.jev\/rules\.md` and compare it byte-for-byte/i);
    expect(flat).toMatch(/This comparison is the race control/i);
    expect(flat).toMatch(/If the bytes differ, abort before replacement/i);
    expect(flat).toMatch(/restart from step 1/i);
    expect(flat).toMatch(/never overwrite the concurrent edit/i);
    expect(flat).toMatch(/final re-read is verification of the written result, not race control/i);
  });

  test("rejects an ordinary rename and a plain-write fallback", () => {
    expect(flat).toMatch(/An ordinary atomic rename is not sufficient by itself/i);
    expect(flat).toMatch(
      /if it can overwrite the destination without checking the observed version, it can still clobber a concurrent edit/i,
    );
    expect(flat).toMatch(
      /Only use a rename when it has no-replace or version-conditional semantics/i,
    );
    expect(flat).toMatch(/hold the exclusive lock from compare through replace/i);
    expect(flat).toMatch(
      /If the host tools cannot provide a conditional compare-and-swap or an exclusive lock/i,
    );
    expect(flat).toMatch(/do not write `\.jev\/rules\.md`/i);
    expect(flat).toMatch(/Never fall back to a plain write after the byte-for-byte check/i);
    expect(flat).toMatch(/tell the user the validated draft is ready/i);
    expect(flat).toMatch(
      /ask for a supported conditional write mechanism or a user-assisted replacement/i,
    );
    expect(flat).toMatch(/Do not claim the policy was modified/i);
    expect(flat).not.toMatch(/If no such primitive exists, write/i);
    expect(flat).not.toMatch(/write `\.jev\/rules\.md` only after step 6 confirmed/i);
  });

  test("stages the candidate in a unique, exclusive, execution-owned temp file", () => {
    expect(text).not.toMatch(/jevguard-tmp/i);
    expect(flat).toMatch(/fresh random identifier generated now/i);
    expect(flat).toMatch(/\.jev\/rules\.md\.jevguard-<random-id>\.tmp/);
    expect(flat).toMatch(/Do not reuse a fixed temp filename/i);
    expect(flat).toMatch(/Create the temp file exclusively: it must not already exist/i);
    expect(flat).toMatch(/refuses to create, or is a symlink/i);
    expect(flat).toMatch(/do not open, follow, or overwrite it/i);
    expect(flat).toMatch(/never write through a symlink/i);
    expect(flat).toMatch(/Record the exact absolute temp path as owned by this execution/i);
    expect(flat).toMatch(/applying only to that recorded path/i);
    expect(flat).toMatch(/remove only your own recorded temp file/i);
  });

  test("forbids credentials, the public CLI, config.yaml edits, and inference", () => {
    expect(text).not.toContain("TYPESAFE_API_KEY");
    expect(text).not.toMatch(/jevguard\s+login/);
    expect(text).toMatch(/Never edit `\.jev\/config\.yaml`/);
    expect(text).toMatch(/never call Jev\/TypeSafe inference/i);
  });
});

describe("jev-init SKILL.md contract", () => {
  const text = readFileSync(INIT_SKILL_MD, "utf8");
  const flat = text.replace(/\s+/g, " ");

  test("uses the required name and a concrete trigger description", () => {
    const frontmatter = parseFrontmatter(text);
    const directoryName = dirname(INIT_SKILL_MD).replaceAll("\\", "/").split("/").pop();

    expect(frontmatter.name).toBe("jev-init");
    expect(frontmatter.name).toBe(directoryName);
    expect(frontmatter.description.length).toBeGreaterThan(0);
    expect(frontmatter.description.length).toBeLessThanOrEqual(1024);
    expect(frontmatter.description).toMatch(/\.jev\/rules\.md/);
    expect(frontmatter.description).toMatch(/\.jev\/config\.yaml/);
  });

  test("stops when either policy file already exists", () => {
    expect(flat).toMatch(/check `\.jev\/rules\.md` and `\.jev\/config\.yaml`/i);
    expect(flat).toMatch(/if either exists, stop, change nothing/i);
    expect(flat).toMatch(/direct the user to the `jevguard-rules` skill/i);
  });

  test("asks one focused question and accepts an explicit none", () => {
    expect(flat).toMatch(/ask exactly one focused question/i);
    expect(flat).toMatch(/an explicit `none` is a valid answer/i);
  });

  test("bounds the inventory and forbids secrets", () => {
    expect(flat).toMatch(/bounded inventory/i);
    expect(flat).toMatch(/`AGENTS\.md` and `CONTRIBUTING\.md`/);
    expect(flat).toMatch(/never read, print, or copy a secret value/i);
    expect(flat).toMatch(/`.env`/);
    expect(flat).toMatch(/`.git\/config`/);
    expect(text).not.toContain("TYPESAFE_API_KEY");
    expect(text).not.toMatch(/jevguard\s+login/);
  });

  test("documents provenance, corroboration, and speculative exclusion", () => {
    expect(flat).toMatch(/provenance preamble/i);
    expect(flat).toMatch(/source: user/);
    expect(flat).toMatch(/source: inferred/);
    expect(flat).toMatch(/strong corroboration/i);
    expect(flat).toMatch(/must be `severity: warning`/i);
    expect(flat).toMatch(/at least two\*\* safe evidence paths/i);
    expect(flat).toMatch(/exclude speculative rules/i);
  });

  test("writes the canonical default configuration", () => {
    expect(text).toContain("opencode/gpt-5.6-luna");
    expect(text).toContain("auto_propose");
    expect(text).toContain("propose_on");
    expect(text).toContain("warn: 0.40");
    expect(text).toContain("fail: 0.70");
    expect(text).toContain("warn: 0.60");
  });

  test("validates staged candidates and requires a two-file confirmation", () => {
    expect(text).toContain("validate-init.js");
    expect(flat).toMatch(/names \*\*both\*\* exact files/i);
    expect(text).toContain(".jev/config.yaml");
    expect(flat).toMatch(/only when the exact staged candidates validated as `valid`/i);
    expect(flat).toMatch(/if there are no acceptable rules, write nothing/i);
    expect(flat).toMatch(/never write a speculative rule/i);
    expect(flat).toMatch(/never call Jev\/TypeSafe inference/i);
  });

  test("commits both files through an exclusive-create script", () => {
    expect(flat).toMatch(/exclusive-create flag/i);
    expect(flat).toMatch(/`wx`, or `O_CREAT \| O_EXCL`/i);
    expect(flat).toMatch(
      /re-check that neither `\.jev\/rules\.md` nor `\.jev\/config\.yaml` exists/i,
    );
    expect(flat).toMatch(/deletes only the target file\(s\) this run created/i);
    expect(flat).toMatch(/never overwrites, truncates, or deletes a preexisting file/i);
    expect(flat).toMatch(/removes only its own staging files and the temporary script/i);
    expect(flat).toMatch(/must not open any other repository file/i);
    expect(flat).toMatch(/if the host cannot run a script with an exclusive-create primitive/i);
    expect(flat).not.toMatch(/agent's normal file tool/i);
  });

  test("does not describe a compare-and-swap or clobber workflow", () => {
    expect(flat).not.toMatch(/compare-and-swap/i);
    expect(flat).not.toMatch(/exclusive lock/i);
  });
});

test("the shipped skill directories exist on disk", () => {
  expect(existsSync(SKILL_MD)).toBe(true);
  expect(existsSync(VALIDATOR)).toBe(true);
  expect(existsSync(INIT_SKILL_MD)).toBe(true);
  expect(existsSync(INIT_VALIDATOR)).toBe(true);
});
