import { spawnSync } from "node:child_process";
import { cp, mkdir, mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { FEED_ENVIRONMENT_VARIABLES } from "@jevguard/claude-code-adapter/presentation";
import { DIST_DIR, MOD_ENTRY, MOD_FILENAME, MOD_TESTS_DIR, PACKAGE_DIR } from "./paths";
const TYPES_VARIABLE = "CLAUDE_CODE_TYPES";
const MATCHER_SUFFIX = /\{[^}]*\}/g;
const LAID_TYPES = join(".claude-plugin", "types");
const STATE_CONTRACT = join(PACKAGE_DIR, "artifact", "types", "index.d.ts");
const USE_SHELL = process.platform === "win32";

const EXPECTED_HOOKS = ["session.start", "turn.complete", "ui.render"];
const ALLOWED_CALLS = new Set([
  "$.clock.after",
  "$.clock.every",
  "$.clock.now",
  "$.env.get",
  "$.fs.read",
  "$.fs.write",
  "$.model.complete",
  "$.prompt.submit",
  "$.session.id",
  "$.session.model",
  "$.state.get",
  "$.state.set",
  "$.ui.close",
  "$.ui.copy",
  "$.ui.log",
  "$.ui.open",
  "$.ui.resolve",
  "$.ui.status",
  "$.ui.toast",
]);
const ALLOWED_ENV_READS = new Set<string>(Object.values(FEED_ENVIRONMENT_VARIABLES));
const USER_ORIGIN_IN_BUNDLE = /\basUser\b|\borigin\s*:/;

interface ValidationEntry {
  readonly errors?: readonly unknown[];
  readonly notes?: readonly string[];
  readonly gatingHooks?: readonly unknown[];
}

interface ValidationReport {
  readonly success?: boolean;
  readonly manifest?: ValidationEntry;
  readonly contents?: readonly ValidationEntry[];
}

function quoted(path: string): string {
  return `"${path}"`;
}

function run(command: string, cwd: string): { status: number | null; output: string } {
  const result = spawnSync(command, { cwd, shell: USE_SHELL, encoding: "utf8" });

  return { status: result.status, output: `${result.stdout ?? ""}${result.stderr ?? ""}` };
}

function noteValue(notes: readonly string[], label: string): string | undefined {
  const note = notes.find((entry) => entry.includes(` ${label}: `));

  return note?.slice(note.indexOf(` ${label}: `) + label.length + 3);
}

function sameSet(actual: readonly string[], expected: readonly string[]): boolean {
  return actual.length === expected.length && expected.every((item) => actual.includes(item));
}

function problemsOf(report: ValidationReport): string[] {
  const problems: string[] = [];
  const entries = [report.manifest, ...(report.contents ?? [])].filter(
    (entry) => entry !== undefined,
  );
  const notes = entries.flatMap((entry) => entry.notes ?? []);

  if (report.success !== true) problems.push("validate did not succeed");

  if (entries.some((entry) => (entry.errors ?? []).length > 0)) problems.push("validate errors");

  if (entries.some((entry) => (entry.gatingHooks ?? []).length > 0)) {
    problems.push("a gating hook is registered");
  }

  const hookNote = noteValue(notes, "hooks") ?? "";

  if (hookNote.includes("=?")) problems.push("a hook matcher is not a literal");

  const hooks = hookNote
    .replace(MATCHER_SUFFIX, "")
    .split(", ")
    .filter((name) => name !== "");

  if (!sameSet(hooks, EXPECTED_HOOKS)) problems.push(`unexpected hooks: ${hooks.join(", ")}`);

  const calls = [...(noteValue(notes, "calls") ?? "").matchAll(/\$\.[A-Za-z.]+/g)].map(
    (match) => match[0],
  );

  for (const call of calls) {
    if (!ALLOWED_CALLS.has(call)) problems.push(`call outside the allowlist: ${call}`);
  }

  if (noteValue(notes, "env writes") !== "nothing") problems.push("the mod writes the environment");

  const reads = (noteValue(notes, "env reads") ?? "").split(", ").filter((name) => name !== "");

  for (const name of reads) {
    if (!ALLOWED_ENV_READS.has(name)) problems.push(`env read outside the allowlist: ${name}`);
  }

  return problems;
}

async function bundleProblems(plugin: string): Promise<string[]> {
  const bundle = await readFile(join(plugin, "hooks", MOD_FILENAME), "utf8");

  return USER_ORIGIN_IN_BUNDLE.test(bundle) ? ["the mod bundle names asUser or an origin"] : [];
}

async function stage(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "jevguard-check-mod-"));
  const plugin = join(root, "plugin");

  await cp(DIST_DIR, plugin, {
    recursive: true,
    filter: (source) => !source.includes("node_modules") && !source.includes(LAID_TYPES),
  });
  await mkdir(join(plugin, "tests"), { recursive: true });

  for (const name of await readdir(MOD_TESTS_DIR)) {
    if (name.endsWith(".test.ts")) await cp(join(MOD_TESTS_DIR, name), join(plugin, "tests", name));
  }

  return root;
}

async function typecheck(root: string): Promise<boolean> {
  const declarations = process.env[TYPES_VARIABLE];

  if (declarations === undefined || declarations === "") {
    console.log(`tsc skipped (${TYPES_VARIABLE} not set)`);

    return true;
  }

  const config = join(root, "tsconfig.mod.json");
  const testFiles = (await readdir(join(root, "plugin", "tests")))
    .filter((name) => name.endsWith(".test.ts"))
    .map((name) => join(root, "plugin", "tests", name));
  const body = {
    compilerOptions: {
      target: "es2023",
      lib: ["es2023"],
      types: [],
      module: "esnext",
      moduleResolution: "bundler",
      strict: true,
      noUncheckedIndexedAccess: true,
      noEmit: true,
      skipLibCheck: true,
    },
    files: [declarations, STATE_CONTRACT, MOD_ENTRY, ...testFiles],
  };

  await writeFile(config, JSON.stringify(body));

  const result = run(`pnpm exec tsc -p ${quoted(config)}`, PACKAGE_DIR);

  console.log(result.output);

  return result.status === 0;
}

async function main(): Promise<boolean> {
  const root = await stage();

  try {
    const plugin = join(root, "plugin");
    const validate = run(`claude plugin validate ${quoted(plugin)} --json`, PACKAGE_DIR);
    const report = JSON.parse(validate.output) as ValidationReport;
    const problems = [...problemsOf(report), ...(await bundleProblems(plugin))];

    for (const problem of problems) console.error(problem);

    const test = run(`claude plugin test ${quoted(plugin)}`, PACKAGE_DIR);

    console.log(test.output);

    const checked = await typecheck(root);

    return problems.length === 0 && test.status === 0 && checked;
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

process.exit((await main()) ? 0 : 1);
