import { existsSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

/** Bundled OpenCode skills registered by the plugin in this order. */
export const BUNDLED_SKILL_NAMES = ["jevguard-rules", "jev-init"] as const;

export type BundledSkillName = (typeof BUNDLED_SKILL_NAMES)[number];

const SKILL_ENTRY_FILE = "SKILL.md";
const SKILL_DIRECTORY_PREFIXES = ["./skills/", "../skills/"];

/**
 * Resolves one installed skill directory from the plugin entrypoint module URL. The
 * bundled artifact keeps each skill at `./skills/<name>`; the source layout keeps it
 * at `../skills/<name>`. A candidate counts only when it contains the skill
 * `SKILL.md`; the first match wins and a missing directory returns null so the config
 * hook stays inert.
 */
export function resolveSkillDirectory(
  moduleUrl: string,
  skillName: string,
  exists: (path: string) => boolean,
): string | null {
  for (const prefix of SKILL_DIRECTORY_PREFIXES) {
    const directory = fileURLToPath(new URL(`${prefix}${skillName}`, moduleUrl));

    if (exists(join(directory, SKILL_ENTRY_FILE))) {
      return directory;
    }
  }

  return null;
}

/**
 * Resolves every bundled skill directory that is present on disk, in
 * `BUNDLED_SKILL_NAMES` order. A skill missing from the installed package is omitted
 * rather than failing startup.
 */
export function resolveInstalledSkillDirectories(moduleUrl: string): readonly string[] {
  const directories: string[] = [];

  for (const skillName of BUNDLED_SKILL_NAMES) {
    const directory = resolveSkillDirectory(moduleUrl, skillName, existsSync);

    if (directory !== null) {
      directories.push(directory);
    }
  }

  return directories;
}
