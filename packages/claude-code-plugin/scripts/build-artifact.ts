import { cp, mkdir, rm } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const SCRIPT_DIR = dirname(fileURLToPath(import.meta.url));
const PACKAGE_DIR = resolve(SCRIPT_DIR, "..");
const REPO_ROOT = resolve(PACKAGE_DIR, "..", "..");
const ADAPTER_SOURCE = join(REPO_ROOT, "packages", "claude-code-adapter", "src");
const TEMPLATE_DIR = join(PACKAGE_DIR, "artifact");
const DIST_DIR = join(PACKAGE_DIR, "dist");

/**
 * The only runtime dependency left external: the native keyring. The hook never
 * references it; only the worker loads it, lazily, so a missing binary degrades the
 * review to `JEV_FAILURE` instead of breaking anything.
 */
const EXTERNAL_DEPENDENCIES = ["@napi-rs/keyring"];

const ENTRYPOINTS = [
  { name: "hook", source: join(ADAPTER_SOURCE, "hook", "main.ts") },
  { name: "worker", source: join(ADAPTER_SOURCE, "worker", "main.ts") },
];

const TEMPLATE_FILES: readonly (readonly [string, string])[] = [
  ["plugin.json", ".claude-plugin/plugin.json"],
  ["hooks.json", "hooks/hooks.json"],
  ["package.json", "package.json"],
  ["package-lock.json", "package-lock.json"],
];

async function bundleEntries(): Promise<void> {
  for (const entry of ENTRYPOINTS) {
    const result = await Bun.build({
      entrypoints: [entry.source],
      outdir: DIST_DIR,
      target: "node",
      format: "esm",
      splitting: false,
      sourcemap: "none",
      minify: false,
      env: "disable",
      external: EXTERNAL_DEPENDENCIES,
      naming: `${entry.name}.js`,
    });

    if (!result.success) {
      for (const log of result.logs) {
        console.error(log);
      }

      throw new Error(`${entry.name} bundle failed`);
    }
  }
}

async function copyTemplates(): Promise<void> {
  for (const [source, destination] of TEMPLATE_FILES) {
    const target = join(DIST_DIR, destination);

    await mkdir(dirname(target), { recursive: true });
    await cp(join(TEMPLATE_DIR, source), target);
  }

  await cp(join(REPO_ROOT, "LICENSE"), join(DIST_DIR, "LICENSE"));
}

async function main(): Promise<void> {
  await rm(DIST_DIR, { recursive: true, force: true });
  await mkdir(DIST_DIR, { recursive: true });
  await bundleEntries();
  await copyTemplates();

  console.log(`claude code artifact built at ${DIST_DIR}`);
}

await main();
