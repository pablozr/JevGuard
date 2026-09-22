import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { afterAll, describe, expect, test } from "vitest";
import type { PluginInput } from "@opencode-ai/plugin";
import { JevGuardPlugin } from "../src/index";
import { appendSkillPath, createConfigHook } from "../src/skills/config-hook";
import { summarizeRules } from "../src/skills/jevguard-rules/rules-summary";
import { resolveSkillDirectory } from "../src/skills/skill-directory";

const TEST_DIR = dirname(fileURLToPath(import.meta.url));
const PACKAGE_DIR = resolve(TEST_DIR, "..");
const SKILL_MD = join(PACKAGE_DIR, "skills", "jevguard-rules", "SKILL.md");
const VALIDATOR = join(PACKAGE_DIR, "src", "skills", "jevguard-rules", "validate-rules.ts");

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

interface Frontmatter {
  readonly name: string;
  readonly description: string;
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
  const result = spawnSync("bun", [VALIDATOR, ...args], {
    cwd: PACKAGE_DIR,
    encoding: "utf8",
  });

  return { status: result.status ?? -1, stdout: result.stdout ?? "", stderr: result.stderr ?? "" };
}

function writeRulesFile(name: string, text: string): string {
  const path = join(tempDir(), name);

  writeFileSync(path, text, "utf8");

  return path;
}

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
    const path = writeRulesFile("valid.md", VALID_DOCUMENT);
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
    const path = writeRulesFile("invalid.md", INVALID_DOCUMENT);
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

  test("does nothing when the installed skill directory is unknown", async () => {
    const config: Record<string, unknown> = {};

    await createConfigHook({ skillDirectory: null })(config);

    expect(skillPaths(config)).toEqual([]);
  });
});

describe("jevguard-rules skill directory", () => {
  test("prefers an existing candidate and skips one without SKILL.md", () => {
    const moduleUrl = pathToFileURL(join(PACKAGE_DIR, "src", "plugin.ts")).href;
    const seen: string[] = [];
    const expected = join(PACKAGE_DIR, "skills", "jevguard-rules");

    const resolved = resolveSkillDirectory(moduleUrl, (path) => {
      seen.push(path);

      return path === join(expected, "SKILL.md");
    });

    expect(resolved).toBe(expected);
    expect(seen).toContain(join(PACKAGE_DIR, "src", "skills", "jevguard-rules", "SKILL.md"));
  });

  test("returns null when no candidate contains SKILL.md", () => {
    const moduleUrl = pathToFileURL(join(PACKAGE_DIR, "index.js")).href;

    expect(resolveSkillDirectory(moduleUrl, () => false)).toBeNull();
  });
});

describe("JevGuardPlugin skill registration", () => {
  test("adds the installed skill directory to the live config", async () => {
    const plugin = JevGuardPlugin;
    const hooks = await plugin({
      client: {},
      worktree: process.cwd(),
    } as unknown as PluginInput);
    const config: object = {};

    expect(typeof hooks.config).toBe("function");

    await hooks.config?.(config);

    const expected = resolve(PACKAGE_DIR, "skills", "jevguard-rules");

    expect(skillPaths(config).map((path) => path.replaceAll("\\", "/"))).toEqual([
      expected.replaceAll("\\", "/"),
    ]);
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

test("the shipped skill directory exists on disk", () => {
  expect(existsSync(SKILL_MD)).toBe(true);
  expect(existsSync(VALIDATOR)).toBe(true);
});
