import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

export const PACKAGE_DIR = resolve(dirname(fileURLToPath(import.meta.url)), "..");
export const REPO_ROOT = resolve(PACKAGE_DIR, "..", "..");
export const DIST_DIR = join(PACKAGE_DIR, "dist");
export const MOD_ENTRY = join(PACKAGE_DIR, "mod", "register.ts");
export const MOD_TESTS_DIR = join(PACKAGE_DIR, "mod", "tests");
export const MOD_FILENAME = "jevguard-ui.js";
