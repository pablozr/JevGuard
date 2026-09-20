import { readFileSync } from "node:fs";
import { describe, expect, test } from "vitest";

interface PackageManifest {
  readonly private?: boolean;
  readonly files?: readonly string[];
  readonly engines?: { readonly bun?: string };
  readonly description?: string;
  readonly license?: string;
}

function readManifest(): PackageManifest {
  return JSON.parse(
    readFileSync(new URL("../package.json", import.meta.url), "utf8"),
  ) as PackageManifest;
}

/**
 * Publication contents are a Task 11 acceptance boundary: the packed artifact must
 * ship the runtime source without tests, tsconfig, or planning records.
 */
describe("package publication manifest", () => {
  test("blocks an accidental registry publish", () => {
    expect(readManifest().private).toBe(true);
  });

  test("whitelists runtime source and excludes test and tooling files", () => {
    const files = readManifest().files ?? [];

    expect(files).toContain("src");

    for (const entry of files) {
      expect(entry).not.toMatch(/^(test|tsconfig)/);
    }
  });

  test("documents the Bun runtime requirement", () => {
    expect(readManifest().engines?.bun).toBeDefined();
  });
});
