import { existsSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const SKILL_ENTRY_FILE = "SKILL.md";
const SKILL_DIRECTORY_CANDIDATES = ["./skills/jevguard-rules", "../skills/jevguard-rules"];

/**
 * Resolves the installed `jevguard-rules` skill directory from the plugin
 * entrypoint module URL. The bundled artifact keeps it at
 * `./skills/jevguard-rules`; the source layout keeps it at
 * `../skills/jevguard-rules`. A candidate counts only when it contains the skill
 * `SKILL.md`; the first match wins and a missing directory returns null so the
 * config hook stays inert.
 */
export function resolveSkillDirectory(
  moduleUrl: string,
  exists: (path: string) => boolean,
): string | null {
  for (const candidate of SKILL_DIRECTORY_CANDIDATES) {
    const directory = fileURLToPath(new URL(candidate, moduleUrl));

    if (exists(join(directory, SKILL_ENTRY_FILE))) {
      return directory;
    }
  }

  return null;
}

export function resolveInstalledSkillDirectory(moduleUrl: string): string | null {
  return resolveSkillDirectory(moduleUrl, existsSync);
}
