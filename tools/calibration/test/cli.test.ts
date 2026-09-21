import { readFileSync } from "node:fs";
import { describe, expect, test } from "vitest";
import { MAX_PLANNED_CALLS, parseArguments, type GenerateCommand, type RunCommand } from "../args";
import { CALIBRATION_SEED, DEFAULT_FIXTURE_COUNT } from "../fixture-catalog";
import { DEFAULT_FIXTURES_PATH } from "../fixture-io";

function expectGenerate(argv: readonly string[]): GenerateCommand {
  const result = parseArguments(argv);

  if (result.status !== "OK" || result.command.kind !== "generate") {
    throw new Error(`expected a generate command, got ${result.status}`);
  }

  return result.command;
}

function expectRun(argv: readonly string[]): RunCommand {
  const result = parseArguments(argv);

  if (result.status !== "OK" || result.command.kind !== "run") {
    throw new Error(`expected a run command, got ${result.status}`);
  }

  return result.command;
}

function expectError(argv: readonly string[]): string {
  const result = parseArguments(argv);

  if (result.status !== "ERROR") {
    throw new Error(`expected an error, got ${result.status}`);
  }

  return result.message;
}

interface RootManifest {
  readonly scripts?: Readonly<Record<string, string>>;
}

describe("generate arguments", () => {
  test("uses deterministic defaults", () => {
    const command = expectGenerate(["generate"]);

    expect(command.seed).toBe(CALIBRATION_SEED);
    expect(command.count).toBe(DEFAULT_FIXTURE_COUNT);
    expect(command.output).toBe(DEFAULT_FIXTURES_PATH);
  });

  test("accepts explicit seed, count, and output", () => {
    const command = expectGenerate([
      "generate",
      "--seed",
      "custom-seed",
      "--count",
      "20",
      "--output",
      "artifacts/calibration/other.jsonl",
    ]);

    expect(command.seed).toBe("custom-seed");
    expect(command.count).toBe(20);
    expect(command.output).toBe("artifacts/calibration/other.jsonl");
  });

  test.each(["0", "-1", "501", "abc"])("rejects count %s", (count) => {
    expect(expectError(["generate", "--count", count])).toContain("--count");
  });

  test("rejects an unknown option", () => {
    expect(expectError(["generate", "--unknown"])).toContain("unknown option");
  });
});

describe("run arguments", () => {
  test("requires --limit", () => {
    expect(expectError(["run"])).toContain("--limit is required");
  });

  test("uses safe defaults for concurrency and repeat", () => {
    const command = expectRun(["run", "--limit", "8"]);

    expect(command.concurrency).toBe(2);
    expect(command.repeat).toBe(1);
    expect(command.difficulty).toBeNull();
    expect(command.categories).toEqual([]);
    expect(command.confirmLiveApi).toBeNull();
  });

  test("parses confirmation, difficulty, and repeatable categories", () => {
    const command = expectRun([
      "run",
      "--limit",
      "40",
      "--difficulty",
      "borderline",
      "--category",
      "necessary-test",
      "--category",
      "requested-direct",
      "--repeat",
      "3",
      "--confirm-live-api",
      "120",
    ]);

    expect(command.difficulty).toBe("borderline");
    expect(command.categories).toEqual(["necessary-test", "requested-direct"]);
    expect(command.repeat).toBe(3);
    expect(command.confirmLiveApi).toBe("120");
  });

  test("supports --key=value syntax", () => {
    const command = expectRun(["run", "--limit=5", "--concurrency=4", "--confirm-live-api=5"]);

    expect(command.limit).toBe(5);
    expect(command.concurrency).toBe(4);
    expect(command.confirmLiveApi).toBe("5");
  });

  test.each([
    [["run", "--limit", "0"], "--limit"],
    [["run", "--limit", "201"], "--limit"],
    [["run", "--limit", "5", "--concurrency", "5"], "--concurrency"],
    [["run", "--limit", "5", "--repeat", "6"], "--repeat"],
    [["run", "--limit", "5", "--difficulty", "medium"], "--difficulty"],
    [["run", "--limit", "5", "--category", "nope"], "--category"],
  ] as const)("rejects invalid input %j", (argv, expected) => {
    expect(expectError(argv)).toContain(expected);
  });

  test("caps total planned calls at 500 in the documented contract", () => {
    expect(MAX_PLANNED_CALLS).toBe(500);
  });
});

describe("help", () => {
  test("prints help with no arguments or an explicit flag", () => {
    expect(parseArguments([]).status).toBe("HELP");
    expect(parseArguments(["--help"]).status).toBe("HELP");
  });
});

describe("workspace wiring", () => {
  test("exposes calibration scripts from the root manifest", () => {
    const manifest = JSON.parse(
      readFileSync(new URL("../../../package.json", import.meta.url), "utf8"),
    ) as RootManifest;

    expect(manifest.scripts?.["calibration:generate"]).toBe(
      "bun tools/calibration/main.ts generate",
    );
    expect(manifest.scripts?.["calibration:run"]).toBe("bun tools/calibration/main.ts run");
  });
});
