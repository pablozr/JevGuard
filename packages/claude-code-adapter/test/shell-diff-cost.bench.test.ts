import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { cpus, tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterAll, beforeAll, describe, test, vi } from "vitest";
import { createBudget } from "../src/capture/budget";
import { createRepoPathResolver } from "../src/capture/file-image";
import { takeGitSnapshot } from "../src/capture/git-shell";
import { diffGitSnapshots } from "../src/capture/git-shell-diff";
import { createNodeFileReader, runGit } from "../src/capture/node-ports";
import { createShellDiffMeter, DEFAULT_SHELL_DIFF_LIMITS } from "../src/capture/shell-diff-limits";
import type {
  GitRunner,
  GitShellContext,
  ShellDiffLimits,
  ShellDiffMeter,
  SnapshotResult,
} from "../src/capture/types";

/**
 * Opt-in cost benchmark of the shell Git diff on synthetic repositories.
 * JEVGUARD_SHELL_DIFF_BENCH=1 enables it; JEVGUARD_SHELL_DIFF_BENCH_SCALE=small|full picks
 * the size (default small); JEVGUARD_SHELL_DIFF_BENCH_OUT writes the rows as JSON. It only
 * writes inside its own temporary directory and uses no network.
 */
vi.setConfig({ testTimeout: 1_800_000, hookTimeout: 1_800_000 });

const ENABLED = process.env.JEVGUARD_SHELL_DIFF_BENCH === "1";
const FULL = process.env.JEVGUARD_SHELL_DIFF_BENCH_SCALE === "full";
const OUT = process.env.JEVGUARD_SHELL_DIFF_BENCH_OUT;
const ITERATIONS = 5;
const FILES_PER_DIRECTORY = 500;
const REWRITTEN_FILES = 500;
const TRACKED_SCALE = FULL ? 1 : 0.2;

const MEASUREMENT_LIMITS: ShellDiffLimits = {
  maxStatusEntries: Number.MAX_SAFE_INTEGER,
  maxContentBytes: Number.MAX_SAFE_INTEGER,
  maxIndexReads: Number.MAX_SAFE_INTEGER,
  maxGitOutputBytes: 1024 * 1024 * 1024,
  gitCallTimeoutMs: 120_000,
  timeMs: 600_000,
};

type Action = "one-clean" | "one-dirty" | "rewrite";

interface Spec {
  readonly id: string;
  readonly name: string;
  readonly tracked: number;
  readonly modified: number;
  readonly modifiedBytes: number;
  readonly untracked: number;
  readonly action: Action;
}

interface Row {
  readonly id: string;
  readonly name: string;
  readonly tracked: number;
  readonly dirtyAtPre: number;
  readonly changed: number;
  readonly bytes: number;
  readonly indexReads: number;
  readonly preMs: readonly number[];
  readonly postMs: readonly number[];
  readonly stepMedianMs: Readonly<Record<string, number>>;
  readonly outcome: string;
  readonly outcomeMs: number;
}

function scaled(tracked: number): number {
  return Math.round(tracked * TRACKED_SCALE);
}

const MAX_STATUS = DEFAULT_SHELL_DIFF_LIMITS.maxStatusEntries;

function specs(): readonly Spec[] {
  const base = { modified: 0, modifiedBytes: 0, untracked: 0, action: "one-clean" } as const;
  const list: Spec[] = [
    { ...base, id: "S1", name: "base", tracked: scaled(10_000) },
    { ...base, id: "S2", name: "large and clean", tracked: scaled(50_000) },
    {
      ...base,
      id: "S3",
      name: "dirty, small",
      tracked: scaled(10_000),
      modified: 1000,
      modifiedBytes: 1024,
    },
    {
      ...base,
      id: "S4",
      name: "dirty, heavy",
      tracked: scaled(10_000),
      modified: 1000,
      modifiedBytes: 256 * 1024,
    },
    { ...base, id: "S5", name: "untracked flood", tracked: scaled(10_000), untracked: 20_000 },
    { ...base, id: "S6", name: "formatter", tracked: scaled(10_000), action: "rewrite" },
    {
      ...base,
      id: "S7a",
      name: "boundary",
      tracked: scaled(10_000),
      untracked: MAX_STATUS,
      action: "one-dirty",
    },
    {
      ...base,
      id: "S7b",
      name: "boundary + 1",
      tracked: scaled(10_000),
      untracked: MAX_STATUS + 1,
      action: "one-dirty",
    },
  ];

  return FULL ? list : list.filter((spec) => spec.id !== "S2");
}

function git(cwd: string, args: readonly string[], input?: string): void {
  execFileSync("git", [...args], {
    cwd,
    input,
    stdio: ["pipe", "ignore", "ignore"],
    maxBuffer: 1024 * 1024 * 1024,
  });
}

function trackedPath(index: number): string {
  return `src/d${String(Math.floor(index / FILES_PER_DIRECTORY)).padStart(3, "0")}/f${index}.ts`;
}

function originalContent(index: number): string {
  return `export const value${index} = ${index};\n`;
}

function writeFile(root: string, path: string, content: string): void {
  const absolute = join(root, path);

  mkdirSync(dirname(absolute), { recursive: true });
  writeFileSync(absolute, content);
}

function createRepository(base: string, tracked: number): string {
  const root = mkdtempSync(join(base, "repo-"));

  git(root, ["init", "-q"]);
  git(root, ["config", "user.email", "bench@example.com"]);
  git(root, ["config", "user.name", "Bench"]);
  git(root, ["config", "core.autocrlf", "true"]);

  for (let index = 0; index < tracked; index += 1) {
    writeFile(root, trackedPath(index), originalContent(index));
  }

  git(root, ["add", "-A"]);
  git(root, ["commit", "-q", "-m", "synthetic"]);

  return root;
}

function resetRepository(root: string): void {
  git(root, ["checkout", "--", "."]);
  rmSync(join(root, "untracked"), { recursive: true, force: true });
}

function untrackedPath(index: number): string {
  return `untracked/d${Math.floor(index / FILES_PER_DIRECTORY)}/u${index}.ts`;
}

function applyDirtyState(root: string, spec: Spec): void {
  const filler = `// ${"x".repeat(Math.max(0, spec.modifiedBytes - 4))}\n`;

  for (let index = 0; index < spec.modified; index += 1) {
    writeFile(root, trackedPath(index), filler);
  }

  for (let index = 0; index < spec.untracked; index += 1) {
    writeFile(root, untrackedPath(index), `export const u${index} = 1;\n`);
  }
}

function changedPaths(spec: Spec): readonly string[] {
  if (spec.action === "one-clean") return [trackedPath(spec.tracked - 1)];

  if (spec.action === "one-dirty") {
    return [spec.modified > 0 ? trackedPath(0) : untrackedPath(0)];
  }

  return Array.from({ length: REWRITTEN_FILES }, (_, offset) =>
    trackedPath(spec.tracked - 1 - offset),
  );
}

function performAction(root: string, spec: Spec, iteration: number): void {
  for (const path of changedPaths(spec)) {
    writeFile(root, path, `export const changed = ${iteration + 1_000_000};\n`);
  }
}

function restoreAction(root: string, spec: Spec): void {
  if (spec.action === "one-dirty") return;

  git(root, ["checkout", "--pathspec-from-file=-"], `${changedPaths(spec).join("\n")}\n`);
}

function yieldToRunner(): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, 250));
}

function median(values: readonly number[]): number {
  const sorted = [...values].sort((left, right) => left - right);

  return sorted[Math.floor(sorted.length / 2)] ?? 0;
}

function stepOf(args: readonly string[]): string {
  const command = args.find((arg) => !arg.startsWith("--")) ?? "";

  return command === "rev-parse" && !args.includes("--show-toplevel") ? "rev-parse-head" : command;
}

function timedGit(timings: Map<string, number>): GitRunner {
  return (args, cwd, options) => {
    const start = performance.now();
    const result = runGit(args, cwd, options);
    const step = stepOf(args);

    timings.set(step, (timings.get(step) ?? 0) + performance.now() - start);

    return result;
  };
}

function countingMeter(limits: ShellDiffLimits): ShellDiffMeter & {
  readonly totals: { bytes: number; reads: number };
} {
  const inner = createShellDiffMeter(limits);
  const totals = { bytes: 0, reads: 0 };

  return {
    totals,
    chargeContent(bytes) {
      totals.bytes += bytes;

      return inner.chargeContent(bytes);
    },
    chargeIndexRead() {
      totals.reads += 1;

      return inner.chargeIndexRead();
    },
  };
}

function contextFor(
  root: string,
  limits: ShellDiffLimits,
  git: GitRunner,
  meter: ShellDiffMeter,
): GitShellContext {
  return {
    git,
    files: createNodeFileReader(),
    projectRoot: root,
    resolveRepoPath: createRepoPathResolver(root),
    budget: createBudget(() => performance.now(), limits.timeMs),
    limits,
    meter,
  };
}

interface Measurement {
  readonly preMs: number;
  readonly postMs: number;
  readonly dirtyAtPre: number;
  readonly changed: number;
  readonly bytes: number;
  readonly reads: number;
  readonly outcome: string;
  readonly timings: ReadonlyMap<string, number>;
}

function failureOutcome(phase: string, result: SnapshotResult): string {
  if (result.status === "TAKEN") return "TAKEN";

  return result.failure.kind === "LIMIT_EXCEEDED"
    ? `${phase}_LIMIT:${result.failure.limit}`
    : `${phase}_UNPROVEN`;
}

function measure(
  root: string,
  spec: Spec,
  limits: ShellDiffLimits,
  iteration: number,
): Measurement {
  const timings = new Map<string, number>();
  const runner = timedGit(timings);
  const preMeter = countingMeter(limits);
  const postMeter = countingMeter(limits);
  const preStart = performance.now();
  const pre = takeGitSnapshot(contextFor(root, limits, runner, preMeter), root);
  const preMs = performance.now() - preStart;

  performAction(root, spec, iteration);

  const postStart = performance.now();
  const postContext = contextFor(root, limits, runner, postMeter);
  const post = takeGitSnapshot(postContext, root);
  const diff =
    pre.status === "TAKEN" && post.status === "TAKEN"
      ? diffGitSnapshots(postContext, pre, post)
      : null;
  const postMs = performance.now() - postStart;
  const outcome =
    diff === null
      ? pre.status === "FAILED"
        ? failureOutcome("PRE", pre)
        : failureOutcome("POST", post)
      : diff.status === "AVAILABLE"
        ? "AVAILABLE"
        : diff.failure.kind === "LIMIT_EXCEEDED"
          ? `DIFF_LIMIT:${diff.failure.limit}`
          : "DIFF_UNPROVEN";

  return {
    preMs,
    postMs,
    dirtyAtPre: pre.status === "TAKEN" ? pre.snapshot.entries.length : 0,
    changed: diff?.status === "AVAILABLE" ? diff.changes.length : 0,
    bytes: preMeter.totals.bytes + postMeter.totals.bytes,
    reads: postMeter.totals.reads,
    outcome,
    timings,
  };
}

function summarize(spec: Spec, raw: readonly Measurement[], defaults: Measurement): Row {
  const steps = new Set(raw.flatMap((item) => [...item.timings.keys()]));
  const stepMedianMs = Object.fromEntries(
    [...steps].map((step) => [step, median(raw.map((item) => item.timings.get(step) ?? 0))]),
  );
  const first = raw[0];

  return {
    id: spec.id,
    name: spec.name,
    tracked: spec.tracked,
    dirtyAtPre: first?.dirtyAtPre ?? 0,
    changed: first?.changed ?? 0,
    bytes: first?.bytes ?? 0,
    indexReads: first?.reads ?? 0,
    preMs: raw.map((item) => item.preMs),
    postMs: raw.map((item) => item.postMs),
    stepMedianMs,
    outcome: defaults.outcome,
    outcomeMs: defaults.preMs + defaults.postMs,
  };
}

function range(values: readonly number[]): string {
  const sorted = [...values].sort((left, right) => left - right);
  const format = (value: number | undefined) => (value ?? 0).toFixed(0);

  return `${format(sorted[0])} / ${format(median(values))} / ${format(sorted.at(-1))}`;
}

function renderTables(rows: readonly Row[]): string {
  const header = [
    `git: ${execFileSync("git", ["--version"]).toString().trim()}`,
    `platform: ${process.platform}, cpus: ${cpus().length}, node: ${process.version}`,
    `scale: ${FULL ? "full" : "small"}, iterations: ${ITERATIONS}`,
  ].join("\n");
  const main = [
    "| id | scenario | tracked | dirty at Pre | changed | bytes | index reads | Pre ms min/med/max | Post ms min/med/max | outcome (defaults) | ms to outcome |",
    "|---|---|---|---|---|---|---|---|---|---|---|",
    ...rows.map(
      (row) =>
        `| ${row.id} | ${row.name} | ${row.tracked} | ${row.dirtyAtPre} | ${row.changed} | ${row.bytes} | ${row.indexReads} | ${range(row.preMs)} | ${range(row.postMs)} | ${row.outcome} | ${row.outcomeMs.toFixed(0)} |`,
    ),
  ];
  const steps = [
    "| id | median ms per Git subcommand (Pre + Post) |",
    "|---|---|",
    ...rows.map(
      (row) =>
        `| ${row.id} | ${Object.entries(row.stepMedianMs)
          .map(([step, ms]) => `${step} ${ms.toFixed(0)}`)
          .join(", ")} |`,
    ),
  ];

  return `${header}\n\n${main.join("\n")}\n\n${steps.join("\n")}\n`;
}

describe.runIf(ENABLED)("shell diff cost", () => {
  let base: string;
  const repositories = new Map<number, string>();
  const rows: Row[] = [];

  beforeAll(() => {
    base = realpathSync.native(mkdtempSync(join(tmpdir(), "jevguard-shell-bench-")));
  });

  afterAll(() => {
    console.log(renderTables(rows));

    if (OUT !== undefined) {
      writeFileSync(OUT, JSON.stringify({ platform: process.platform, rows }, null, 2));
    }

    rmSync(base, { recursive: true, force: true });
  });

  test.each(specs())("$id $name", async (spec) => {
    await yieldToRunner();

    const existing = repositories.get(spec.tracked);
    const root = existing ?? createRepository(base, spec.tracked);

    repositories.set(spec.tracked, root);
    resetRepository(root);
    applyDirtyState(root, spec);

    const raw: Measurement[] = [];

    for (let iteration = 0; iteration < ITERATIONS; iteration += 1) {
      raw.push(measure(root, spec, MEASUREMENT_LIMITS, iteration));
      restoreAction(root, spec);
      await yieldToRunner();
    }

    const defaults = measure(root, spec, DEFAULT_SHELL_DIFF_LIMITS, ITERATIONS);

    restoreAction(root, spec);
    rows.push(summarize(spec, raw, defaults));
  });
});
