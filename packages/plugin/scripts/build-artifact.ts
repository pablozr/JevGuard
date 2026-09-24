import { cp, mkdir, rm } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const SCRIPT_DIR = dirname(fileURLToPath(import.meta.url));
const PACKAGE_DIR = resolve(SCRIPT_DIR, "..");
const REPO_ROOT = resolve(PACKAGE_DIR, "..", "..");
const SOURCE_DIR = join(PACKAGE_DIR, "src");
const DIST_DIR = join(PACKAGE_DIR, "dist");

interface BundledSkill {
  readonly name: string;
  readonly validator: string;
}

/**
 * Bundled OpenCode skills, in registration order. Each ships its `SKILL.md` and the
 * private validator it invokes next to it under `skills/<name>/`.
 */
const BUNDLED_SKILLS: readonly BundledSkill[] = [
  { name: "jevguard-rules", validator: "validate-rules" },
  { name: "jev-init", validator: "validate-init" },
];

function skillDistPrefix(skill: BundledSkill): string {
  return `skills/${skill.name}`;
}

/**
 * The packed allowlist is explicit so the artifact never ships sources, maps, or
 * tests. The bundled validators under `skills/` are the private helpers the shipped
 * skills invoke.
 */
const ARTIFACT_FILES: readonly string[] = [
  "index.js",
  "cli/main.js",
  "README.md",
  "LICENSE",
  ...BUNDLED_SKILLS.flatMap((skill) => [
    `${skillDistPrefix(skill)}/SKILL.md`,
    `${skillDistPrefix(skill)}/${skill.validator}.js`,
  ]),
];

/**
 * Runtime dependencies stay external so the consumer installs public packages.
 * Internal workspace packages are bundled, so no `workspace:` specifier survives.
 */
const RUNTIME_DEPENDENCIES: Readonly<Record<string, string>> = {
  "@inquirer/password": "^5.2.2",
  "@napi-rs/keyring": "2.1.0",
  "@typesafe-ai/sdk": "0.6.0",
  yaml: "2.9.1",
};

interface SourceRepository {
  readonly type: string;
  readonly url: string;
  readonly directory: string;
}

interface SourceManifest {
  readonly name: string;
  readonly version: string;
  readonly description: string;
  readonly license: string;
  readonly repository: SourceRepository;
  readonly homepage: string;
  readonly bugs: { readonly url: string };
  readonly engines: Readonly<Record<string, string>>;
  readonly keywords: readonly string[];
}

async function readSourceManifest(): Promise<SourceManifest> {
  const text = await Bun.file(join(PACKAGE_DIR, "package.json")).text();

  return JSON.parse(text) as SourceManifest;
}

async function bundleEntries(): Promise<void> {
  const result = await Bun.build({
    entrypoints: [
      join(SOURCE_DIR, "index.ts"),
      join(SOURCE_DIR, "cli/main.ts"),
      ...BUNDLED_SKILLS.map((skill) =>
        join(SOURCE_DIR, "skills", skill.name, `${skill.validator}.ts`),
      ),
    ],
    outdir: DIST_DIR,
    root: SOURCE_DIR,
    target: "bun",
    format: "esm",
    splitting: false,
    sourcemap: "none",
    minify: false,
    env: "disable",
    external: Object.keys(RUNTIME_DEPENDENCIES),
    naming: "[dir]/[name].js",
  });

  if (!result.success) {
    for (const log of result.logs) {
      console.error(log);
    }

    throw new Error("artifact bundle failed");
  }
}

async function writeArtifactManifest(source: SourceManifest): Promise<void> {
  const manifest = {
    name: source.name,
    version: source.version,
    description: source.description,
    license: source.license,
    type: "module",
    main: "./index.js",
    exports: { ".": "./index.js" },
    bin: { jevguard: "cli/main.js" },
    files: [...ARTIFACT_FILES],
    engines: source.engines,
    repository: source.repository,
    homepage: source.homepage,
    bugs: source.bugs,
    keywords: source.keywords,
    publishConfig: { access: "public", registry: "https://registry.npmjs.org" },
    dependencies: RUNTIME_DEPENDENCIES,
  };

  await Bun.write(join(DIST_DIR, "package.json"), `${JSON.stringify(manifest, null, 2)}\n`);
}

async function copyDocs(): Promise<void> {
  await cp(join(REPO_ROOT, "README.md"), join(DIST_DIR, "README.md"));
  await cp(join(REPO_ROOT, "LICENSE"), join(DIST_DIR, "LICENSE"));
}

async function copySkills(): Promise<void> {
  for (const skill of BUNDLED_SKILLS) {
    const source = join(PACKAGE_DIR, "skills", skill.name, "SKILL.md");
    const destination = join(DIST_DIR, "skills", skill.name, "SKILL.md");

    await mkdir(join(DIST_DIR, "skills", skill.name), { recursive: true });
    await cp(source, destination);
  }
}

async function main(): Promise<void> {
  await rm(DIST_DIR, { recursive: true, force: true });
  await mkdir(DIST_DIR, { recursive: true });

  const source = await readSourceManifest();

  await bundleEntries();
  await writeArtifactManifest(source);
  await copyDocs();
  await copySkills();

  console.log(`artifact built at ${DIST_DIR}`);
}

await main();
