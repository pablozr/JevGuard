import { readFileSync } from "node:fs";
import { describe, expect, test } from "vitest";

interface PackageManifest {
  readonly name?: string;
  readonly version?: string;
  readonly private?: boolean;
  readonly files?: readonly string[];
  readonly engines?: { readonly bun?: string; readonly opencode?: string };
  readonly description?: string;
  readonly license?: string;
  readonly repository?: Readonly<Record<string, string>>;
  readonly homepage?: string;
  readonly bugs?: Readonly<Record<string, string>>;
  readonly exports?: Readonly<Record<string, string>>;
  readonly dependencies?: Readonly<Record<string, string>>;
  readonly devDependencies?: Readonly<Record<string, string>>;
  readonly scripts?: Readonly<Record<string, string>>;
}

function readManifest(): PackageManifest {
  return JSON.parse(
    readFileSync(new URL("../package.json", import.meta.url), "utf8"),
  ) as PackageManifest;
}

/**
 * The development manifest is never packed. The installable artifact manifest is
 * generated into `dist` from this file's metadata and asserted by
 * `artifact.test.ts`, which owns the packed file allowlist, the public publish
 * fields, and the absence of workspace dependencies.
 */
describe("plugin development manifest", () => {
  test("blocks an accidental registry publish", () => {
    expect(readManifest().private).toBe(true);
  });

  test("keeps the released version and metadata consistent with the artifact", () => {
    const manifest = readManifest();

    expect(manifest.name).toBe("@pablozrrrr/jevguard");
    expect(manifest.version).toBe("0.1.0");
    expect(manifest.license).toBe("MIT");
    expect(manifest.description).toBeDefined();
    expect(manifest.repository?.url).toBe("git+https://github.com/pablozr/JevGuard.git");
    expect(manifest.repository?.directory).toBe("packages/plugin");
    expect(manifest.homepage).toBeDefined();
    expect(manifest.bugs?.url).toBeDefined();
  });

  test("documents the Bun and OpenCode runtime requirements", () => {
    const engines = readManifest().engines;

    expect(engines?.bun).toBe(">=1.1.0");
    expect(engines?.opencode).toBe(">=1.18.31 <2");
  });

  test("keeps TypeScript entrypoints for workspace development", () => {
    expect(readManifest().exports?.["."]).toBe("./src/index.ts");
  });

  test("does not present the source tree as packaged output", () => {
    expect(readManifest().files).toBeUndefined();
  });

  test("keeps the host plugin package type-only in development", () => {
    const manifest = readManifest();

    expect(manifest.dependencies).toEqual({
      "@jevguard/core": "workspace:*",
      "@jevguard/opencode-adapter": "workspace:*",
    });
    expect(manifest.devDependencies).toEqual({ "@opencode-ai/plugin": "1.18.31" });
  });

  test("declares no npm lifecycle scripts", () => {
    const lifecycle = [
      "preinstall",
      "install",
      "postinstall",
      "prepublish",
      "prepublishOnly",
      "prepare",
      "prepack",
      "postpack",
      "publish",
      "postpublish",
    ];
    const scripts = Object.keys(readManifest().scripts ?? {});

    expect(scripts.filter((name) => lifecycle.includes(name))).toEqual([]);
  });
});
