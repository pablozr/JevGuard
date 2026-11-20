import { join } from "node:path";
import { describe, expect, test } from "vitest";
import {
  cacheDirNameOf,
  JEVGUARD_PLUGIN_ENTRY,
  type PluginCacheFileSystem,
  resolveCachedPlugin,
} from "../src/index";

const CACHE_ROOT = join("C:", "home", ".cache", "opencode", "npm");
const SPEC = `${JEVGUARD_PLUGIN_ENTRY}@0.4.1`;

class FakeCache implements PluginCacheFileSystem {
  readonly directories = new Map<string, readonly string[]>();
  readonly files = new Map<string, string>();
  readError: Error | null = null;

  async readDirectory(path: string): Promise<readonly string[] | null> {
    if (this.readError !== null) {
      throw this.readError;
    }

    return this.directories.get(path) ?? null;
  }

  async readFile(path: string): Promise<string | null> {
    if (this.readError !== null) {
      throw this.readError;
    }

    return this.files.get(path) ?? null;
  }
}

function install(
  cache: FakeCache,
  spec: string,
  timestamp: string,
  manifest: { readonly name?: string; readonly version?: string } | null,
): void {
  const directory = join(CACHE_ROOT, cacheDirNameOf(spec));

  cache.directories.set(directory, [...(cache.directories.get(directory) ?? []), timestamp]);

  if (manifest !== null) {
    cache.files.set(
      join(directory, timestamp, "node_modules", JEVGUARD_PLUGIN_ENTRY, "package.json"),
      JSON.stringify({ name: manifest.name ?? JEVGUARD_PLUGIN_ENTRY, version: manifest.version }),
    );
  }
}

function resolve(cache: FakeCache, spec = SPEC) {
  return resolveCachedPlugin({ cacheRoot: CACHE_ROOT, spec, fileSystem: cache });
}

describe("resolveCachedPlugin", () => {
  test("proves the package and version the host installed", async () => {
    const cache = new FakeCache();
    install(cache, SPEC, "1795150043554", { version: "0.4.1" });

    expect(await resolve(cache)).toEqual({
      status: "RESOLVED",
      package: JEVGUARD_PLUGIN_ENTRY,
      version: "0.4.1",
    });
  });

  test("reads the newest install when the cache holds more than one", async () => {
    const cache = new FakeCache();
    install(cache, SPEC, "1795000000000", { version: "0.2.0" });
    install(cache, SPEC, "1795150043554", { version: "0.4.1" });

    expect(await resolve(cache)).toMatchObject({ status: "RESOLVED", version: "0.4.1" });
  });

  test("an entry that was never loaded is NOT_CACHED, never a success", async () => {
    expect(await resolve(new FakeCache())).toEqual({
      status: "NOT_CACHED",
      package: JEVGUARD_PLUGIN_ENTRY,
    });
  });

  test("ignores a staging directory left by an interrupted install", async () => {
    const cache = new FakeCache();
    cache.directories.set(join(CACHE_ROOT, cacheDirNameOf(SPEC)), [".staging-1795150043554-x"]);

    expect(await resolve(cache)).toMatchObject({ status: "NOT_CACHED" });
  });

  test("an install without the package manifest cannot be proven", async () => {
    const cache = new FakeCache();
    install(cache, SPEC, "1795150043554", null);

    expect(await resolve(cache)).toEqual({
      status: "UNREADABLE",
      package: JEVGUARD_PLUGIN_ENTRY,
      reason: "INCOMPLETE_INSTALL",
    });
  });

  test("a manifest of another package cannot be proven", async () => {
    const cache = new FakeCache();
    install(cache, SPEC, "1795150043554", { name: "other-plugin", version: "0.4.1" });

    expect(await resolve(cache)).toMatchObject({
      status: "UNREADABLE",
      reason: "PACKAGE_MISMATCH",
    });
  });

  test("an unreadable manifest or directory cannot be proven", async () => {
    const throwing = new FakeCache();
    throwing.readError = new Error("EACCES");

    const invalid = new FakeCache();
    install(invalid, SPEC, "1795150043554", null);
    invalid.files.set(
      join(
        CACHE_ROOT,
        cacheDirNameOf(SPEC),
        "1795150043554",
        "node_modules",
        JEVGUARD_PLUGIN_ENTRY,
        "package.json",
      ),
      "{ not json",
    );

    expect(await resolve(throwing)).toMatchObject({ status: "UNREADABLE", reason: "READ_FAILURE" });
    expect(await resolve(invalid)).toMatchObject({ status: "UNREADABLE", reason: "READ_FAILURE" });
  });

  test("a cache that holds another version is a mismatch with the pin", async () => {
    const cache = new FakeCache();
    install(cache, SPEC, "1795150043554", { version: "0.3.0" });

    expect(await resolve(cache)).toEqual({
      status: "VERSION_MISMATCH",
      package: JEVGUARD_PLUGIN_ENTRY,
      version: "0.3.0",
      pin: "0.4.1",
    });
  });

  test("an unpinned entry reads the @latest install and reports its version", async () => {
    const cache = new FakeCache();
    install(cache, JEVGUARD_PLUGIN_ENTRY, "1795150043554", { version: "0.4.1" });

    expect(await resolve(cache, JEVGUARD_PLUGIN_ENTRY)).toEqual({
      status: "RESOLVED",
      package: JEVGUARD_PLUGIN_ENTRY,
      version: "0.4.1",
    });
  });

  test("a spec that is not from the registry cannot be proven", async () => {
    expect(await resolve(new FakeCache(), "file:/tmp/jevguard")).toEqual({
      status: "UNSUPPORTED",
      package: "file:/tmp/jevguard",
    });
  });

  test("names the cache directory the host uses", () => {
    expect(cacheDirNameOf(JEVGUARD_PLUGIN_ENTRY)).toBe(`${JEVGUARD_PLUGIN_ENTRY}@latest`);
    expect(cacheDirNameOf(SPEC)).toBe(SPEC);
  });
});
