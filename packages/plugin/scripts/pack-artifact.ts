import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const SCRIPT_DIR = dirname(fileURLToPath(import.meta.url));
const PACKAGE_DIR = resolve(SCRIPT_DIR, "..");
const REPO_ROOT = resolve(PACKAGE_DIR, "..", "..");
const DIST_DIR = join(PACKAGE_DIR, "dist");
const DEFAULT_DESTINATION = join(REPO_ROOT, "artifacts");

function parseDestination(argv: readonly string[]): string {
  const flagIndex = argv.indexOf("--destination");
  const value = flagIndex === -1 ? undefined : argv[flagIndex + 1];

  if (flagIndex !== -1 && (value === undefined || value.startsWith("--"))) {
    throw new Error("--destination requires a directory argument");
  }

  return value === undefined ? DEFAULT_DESTINATION : resolve(value);
}

function main(argv: readonly string[]): void {
  if (!existsSync(join(DIST_DIR, "package.json"))) {
    console.error(`no artifact found at ${DIST_DIR}; run "pnpm artifact:build" first`);
    process.exit(1);
  }

  const destination = parseDestination(argv);
  mkdirSync(destination, { recursive: true });

  execFileSync(process.execPath, ["pm", "pack", "--ignore-scripts", "--destination", destination], {
    cwd: DIST_DIR,
    stdio: "inherit",
  });

  console.log(`packed artifact into ${destination}`);
}

main(process.argv.slice(2));
