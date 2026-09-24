const SKILLS_KEY = "skills";
const PATHS_KEY = "paths";

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isMutableArray(value: unknown): value is unknown[] {
  return Array.isArray(value);
}

/**
 * Appends one skill directory to `skills.paths` on the host's live config object
 * without replacing unknown keys. The OpenCode SDK does not type the `skills`
 * field, so the runtime shape is read defensively:
 *
 * - a missing `skills` object gains `{ paths: [directory] }`;
 * - a present `paths` array is appended only when the exact directory is absent;
 * - an unexpected `skills` or `paths` shape is left untouched.
 */
export function appendSkillPath(config: unknown, skillDirectory: string): void {
  if (!isRecord(config)) {
    return;
  }

  const skills = config[SKILLS_KEY];

  if (skills === undefined) {
    config[SKILLS_KEY] = { [PATHS_KEY]: [skillDirectory] };
    return;
  }

  if (!isRecord(skills)) {
    return;
  }

  const paths = skills[PATHS_KEY];

  if (paths === undefined) {
    skills[PATHS_KEY] = [skillDirectory];
    return;
  }

  if (!isMutableArray(paths)) {
    return;
  }

  if (paths.some((entry) => entry === skillDirectory)) {
    return;
  }

  paths.push(skillDirectory);
}

export interface ConfigHookOptions {
  readonly skillDirectories: readonly string[];
}

/**
 * Builds the OpenCode `config` hook that registers every bundled skill directory.
 * It mutates the host's live config in place and never throws into host startup:
 * a missing installed directory leaves the config untouched.
 */
export function createConfigHook(options: ConfigHookOptions): (input: unknown) => Promise<void> {
  return async (input) => {
    try {
      for (const skillDirectory of options.skillDirectories) {
        appendSkillPath(input, skillDirectory);
      }
    } catch {
      return;
    }
  };
}
