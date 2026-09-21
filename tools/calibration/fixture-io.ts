import { createHash } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import type { SyntheticCalibrationFixture } from "./types";

export const DEFAULT_FIXTURES_PATH = "artifacts/calibration/fixtures.jsonl";
export const CALIBRATION_RUNS_DIRECTORY = "artifacts/calibration/runs";

export function resolveFromCwd(path: string): string {
  return resolve(process.cwd(), path);
}

export async function readTextFile(path: string): Promise<string> {
  return readFile(resolveFromCwd(path), "utf8");
}

export async function writeTextFile(path: string, content: string): Promise<void> {
  const target = resolveFromCwd(path);

  await mkdir(dirname(target), { recursive: true });
  await writeFile(target, content, "utf8");
}

export function serializeFixtures(fixtures: readonly SyntheticCalibrationFixture[]): string {
  return `${fixtures.map((fixture) => JSON.stringify(fixture)).join("\n")}\n`;
}

/** Short stable content hash used to identify a corpus without embedding its content. */
export function stableHash(content: string): string {
  return createHash("sha256").update(content).digest("hex").slice(0, 16);
}

export function hashFixtures(fixtures: readonly SyntheticCalibrationFixture[]): string {
  return stableHash(serializeFixtures(fixtures));
}

export function runDirectory(runId: string): string {
  return `${CALIBRATION_RUNS_DIRECTORY}/${runId}`;
}
