import { cp, mkdir, rm } from "node:fs/promises";
import { dirname, join } from "node:path";
import { DIST_DIR, MOD_ENTRY, MOD_FILENAME, PACKAGE_DIR, REPO_ROOT } from "./paths";

const ADAPTER_SOURCE = join(REPO_ROOT, "packages", "claude-code-adapter", "src");
const TEMPLATE_DIR = join(PACKAGE_DIR, "artifact");

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
  ["npm-shrinkwrap.json", "npm-shrinkwrap.json"],
  ["types/index.d.ts", "types/index.d.ts"],
];

const MOD_FORBIDDEN = /\bimport\(|\brequire\(|\bnode:/;

interface BundleSpec {
  readonly label: string;
  readonly entry: string;
  readonly outdir: string;
  readonly target: "node" | "browser";
  readonly external: string[];
  readonly naming: string;
}

async function bundleOrThrow(spec: BundleSpec): Promise<void> {
  const result = await Bun.build({
    entrypoints: [spec.entry],
    outdir: spec.outdir,
    target: spec.target,
    format: "esm",
    splitting: false,
    sourcemap: "none",
    minify: false,
    env: "disable",
    external: spec.external,
    naming: spec.naming,
  });

  if (!result.success) {
    for (const log of result.logs) {
      console.error(log);
    }

    throw new Error(`${spec.label} bundle failed`);
  }
}

async function bundleEntries(): Promise<void> {
  for (const entry of ENTRYPOINTS) {
    await bundleOrThrow({
      label: entry.name,
      entry: entry.source,
      outdir: DIST_DIR,
      target: "node",
      external: EXTERNAL_DEPENDENCIES,
      naming: `${entry.name}.js`,
    });
  }
}

async function bundleMod(): Promise<void> {
  await bundleOrThrow({
    label: "mod",
    entry: MOD_ENTRY,
    outdir: join(DIST_DIR, "hooks"),
    target: "browser",
    external: ["claude-code"],
    naming: MOD_FILENAME,
  });

  const text = await Bun.file(join(DIST_DIR, "hooks", MOD_FILENAME)).text();

  if (MOD_FORBIDDEN.test(text)) {
    throw new Error("mod bundle contains a construct the mod loader refuses");
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
  await bundleMod();
  await copyTemplates();

  console.log(`claude code artifact built at ${DIST_DIR}`);
}

await main();
