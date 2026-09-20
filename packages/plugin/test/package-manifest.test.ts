import { readFileSync } from "node:fs";
import { describe, expect, test } from "vitest";

interface PackageManifest {
  readonly private?: boolean;
  readonly files?: readonly string[];
  readonly engines?: { readonly bun?: string };
  readonly description?: string;
  readonly license?: string;
  readonly exports?: Readonly<Record<string, string>>;
}

function readManifest(): PackageManifest {
  return JSON.parse(
    readFileSync(new URL("../package.json", import.meta.url), "utf8"),
  ) as PackageManifest;
}

/**
 * The development manifest is never packed. The installable artifact manifest is
 * generated into `dist` and asserted by `artifact.test.ts`, which owns the packed
 * file allowlist and the absence of workspace dependencies.
 */
describe("plugin development manifest", () => {
  test("blocks an accidental registry publish", () => {
    expect(readManifest().private).toBe(true);
  });

  test("documents the Bun runtime requirement", () => {
    expect(readManifest().engines?.bun).toBeDefined();
  });

  test("keeps TypeScript entrypoints for workspace development", () => {
    expect(readManifest().exports?.["."]).toBe("./src/index.ts");
  });

  test("does not present the source tree as packaged output", () => {
    expect(readManifest().files).toBeUndefined();
  });
});
