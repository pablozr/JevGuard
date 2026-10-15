import { join } from "node:path";
import { describe, expect, test } from "vitest";
import { resolveProjectRoot } from "../src/cli/project-root";

const ROOT = join(process.cwd(), "workspace");
const NESTED = join(ROOT, "packages", "app");

describe("resolveProjectRoot", () => {
  test("finds the first ancestor holding a .git entry", () => {
    const root = resolveProjectRoot(NESTED, (directory) => directory === ROOT);

    expect(root).toBe(ROOT);
  });

  test("prefers the nearest ancestor", () => {
    const nearest = join(ROOT, "packages");

    const root = resolveProjectRoot(
      NESTED,
      (directory) => directory === nearest || directory === ROOT,
    );

    expect(root).toBe(nearest);
  });

  test("matches the working directory itself", () => {
    expect(resolveProjectRoot(NESTED, (directory) => directory === NESTED)).toBe(NESTED);
  });

  test("falls back to the working directory without any .git", () => {
    expect(resolveProjectRoot(NESTED, () => false)).toBe(NESTED);
  });
});
