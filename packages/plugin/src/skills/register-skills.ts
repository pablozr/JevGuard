import { readFile } from "node:fs/promises";
import { basename, join } from "node:path";
import type { Plugin } from "@opencode/plugin";
import { SKILL_ENTRY_FILE } from "./skill-directory";

type SkillContext = { readonly skill: Pick<Plugin.Context["skill"], "transform"> };
type SkillEditor = Parameters<Parameters<Plugin.Context["skill"]["transform"]>[0]>[0];
type SkillInfo = Parameters<SkillEditor["add"]>[0];

const FRONTMATTER = /^---\r?\n([\s\S]*?)\r?\n---/;

/** One bundled skill read from disk, ready for the host skill editor. */
export interface BundledSkill {
  readonly name: string;
  readonly description: string | undefined;
  readonly path: string;
  readonly content: string;
}

/** Reads the `description` from a `SKILL.md` frontmatter, or `undefined`. */
export function frontmatterDescription(content: string): string | undefined {
  const block = FRONTMATTER.exec(content)?.[1];
  const line = block?.split(/\r?\n/).find((entry) => entry.startsWith("description:"));
  const value = line?.slice("description:".length).trim();

  return value === undefined || value === "" ? undefined : value;
}

/**
 * Reads each installed skill directory's `SKILL.md`. The skill name is the directory
 * name; an unreadable file is omitted rather than failing setup.
 */
export async function readBundledSkills(directories: readonly string[]): Promise<BundledSkill[]> {
  const skills: BundledSkill[] = [];

  for (const directory of directories) {
    const path = join(directory, SKILL_ENTRY_FILE);

    try {
      const content = await readFile(path, "utf8");
      const name = basename(directory);

      skills.push({ name, description: frontmatterDescription(content), path, content });
    } catch {
      // An unreadable SKILL.md is omitted.
    }
  }

  return skills;
}

/**
 * Registers the bundled skills through `ctx.skill.transform`. The host reruns the
 * transform on every reload from a fresh editor; an existing skill of the same id is
 * replaced in place, so a reload never duplicates it.
 */
export function registerSkills(
  context: SkillContext,
  skills: readonly BundledSkill[],
): Promise<{ readonly dispose: () => Promise<void> }> {
  return context.skill.transform((editor) => {
    for (const skill of skills) {
      const info = toSkillInfo(skill);

      if (editor.get(info.id) === undefined) {
        editor.add(info);
        continue;
      }

      editor.update(info.id, (current) => {
        Object.assign(current, info);
      });
    }
  });
}

function toSkillInfo(skill: BundledSkill): SkillInfo {
  return {
    id: skill.name,
    name: skill.name,
    ...(skill.description === undefined ? {} : { description: skill.description }),
    path: skill.path,
    content: skill.content,
  } as SkillInfo;
}
