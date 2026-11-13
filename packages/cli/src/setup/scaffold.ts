import { dirname } from "node:path";
import { policyFilePaths, type TextFileSystem } from "@jevguard/node-infra";

export const STARTER_RULES = `## QUALITY-001

severity: warning

### Rule

Behavior changes must arrive with tests.

### Violation

A change alters behavior and no test is added or updated for it.

### Allowed

Documentation, formatting, and refactors that keep behavior and are covered by existing tests.
`;

export async function rulesExist(files: TextFileSystem, projectRoot: string): Promise<boolean> {
  return files.exists(policyFilePaths(projectRoot).rules);
}

/** Writes the starter `.jev/rules.md`; it never replaces an existing file. */
export async function scaffoldRules(
  files: TextFileSystem,
  projectRoot: string,
): Promise<"CREATED" | "EXISTS" | "WRITE_FAILED"> {
  const path = policyFilePaths(projectRoot).rules;

  try {
    if (await files.exists(path)) return "EXISTS";

    await files.makeDirectory(dirname(path));
    await files.writeTextAtomic(path, STARTER_RULES);

    return "CREATED";
  } catch {
    return "WRITE_FAILED";
  }
}
