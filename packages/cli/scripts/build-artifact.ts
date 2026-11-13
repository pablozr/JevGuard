import { cp, mkdir, rm } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const SCRIPT_DIR = dirname(fileURLToPath(import.meta.url));
const PACKAGE_DIR = resolve(SCRIPT_DIR, "..");
const REPO_ROOT = resolve(PACKAGE_DIR, "..", "..");
const SOURCE_DIR = join(PACKAGE_DIR, "src");
const DIST_DIR = join(PACKAGE_DIR, "dist");
const SHEBANG = "#!/usr/bin/env node";

interface SourceManifest {
  readonly name: string;
  readonly version: string;
  readonly description: string;
  readonly license: string;
  readonly repository: { readonly type: string; readonly url: string; readonly directory: string };
  readonly homepage: string;
  readonly bugs: { readonly url: string };
  readonly dependencies: Readonly<Record<string, string>>;
}

async function readSourceManifest(): Promise<SourceManifest> {
  const text = await Bun.file(join(PACKAGE_DIR, "package.json")).text();

  return JSON.parse(text) as SourceManifest;
}

/** Runtime dependencies stay external and pinned like `node-infra`; workspace packages are bundled. */
function runtimeDependenciesOf(source: SourceManifest): Readonly<Record<string, string>> {
  return Object.fromEntries(
    Object.entries(source.dependencies).filter(([, range]) => !range.startsWith("workspace:")),
  );
}

async function bundleEntry(dependencies: Readonly<Record<string, string>>): Promise<void> {
  const result = await Bun.build({
    entrypoints: [join(SOURCE_DIR, "main.ts")],
    outdir: DIST_DIR,
    root: SOURCE_DIR,
    target: "node",
    format: "esm",
    splitting: false,
    sourcemap: "none",
    minify: false,
    env: "disable",
    external: Object.keys(dependencies),
    naming: "[name].js",
  });

  if (!result.success) {
    for (const log of result.logs) {
      console.error(log);
    }

    throw new Error("cli bundle failed");
  }
}

async function ensureSingleShebang(): Promise<void> {
  const path = join(DIST_DIR, "main.js");
  const text = await Bun.file(path).text();
  const body = text.startsWith("#!") ? text.slice(text.indexOf("\n") + 1) : text;

  await Bun.write(path, `${SHEBANG}\n${body}`);
}

async function writeArtifactManifest(
  source: SourceManifest,
  dependencies: Readonly<Record<string, string>>,
): Promise<void> {
  const manifest = {
    name: source.name,
    version: source.version,
    description: source.description,
    license: source.license,
    type: "module",
    bin: { jevguard: "main.js" },
    files: ["main.js", "LICENSE"],
    engines: { node: ">=22.13" },
    repository: source.repository,
    homepage: source.homepage,
    bugs: source.bugs,
    publishConfig: { access: "public", registry: "https://registry.npmjs.org" },
    dependencies,
  };

  await Bun.write(join(DIST_DIR, "package.json"), `${JSON.stringify(manifest, null, 2)}\n`);
}

async function main(): Promise<void> {
  await rm(DIST_DIR, { recursive: true, force: true });
  await mkdir(DIST_DIR, { recursive: true });

  const source = await readSourceManifest();

  const dependencies = runtimeDependenciesOf(source);

  await bundleEntry(dependencies);
  await ensureSingleShebang();
  await writeArtifactManifest(source, dependencies);
  await cp(join(REPO_ROOT, "LICENSE"), join(DIST_DIR, "LICENSE"));

  console.log(`artifact built at ${DIST_DIR}`);
}

await main();
