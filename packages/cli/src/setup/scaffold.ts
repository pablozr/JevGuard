import { dirname } from "node:path";
import { policyFilePaths, type TextFileSystem } from "@jevguard/node-infra";

/**
 * The starter policy file. Text before the first `##` heading is documentation for the
 * user: JevGuard reads one rule per `##` block and asks Jev one yes/no question per
 * rule, so each block states what must hold, what violates it, and what is allowed.
 * `jevguard init` creates it once and never replaces it.
 */
export const STARTER_RULES = `# JevGuard rules

Each \`##\` section below is one rule. JevGuard asks Jev one yes/no question per rule
about the change attributed to the current turn and applies your local gate to the
answer. Keep the blocks short: say what must hold, what violates it, and what is
allowed. Edit, rename or delete these examples freely; a rule that does not parse is
reported as invalid, never guessed.

## QUALITY-001

severity: warning

### Rule

Behavior changes must arrive with tests.

### Violation

A change alters behavior and no test is added or updated for it.

### Allowed

Documentation, formatting, and refactors that keep behavior and are covered by existing tests.

## SECRETS-001

severity: error

### Rule

No secret is committed to the repository.

### Violation

The change adds an API key, token, password, private key, or connection string with
credentials in it, in source, configuration, or a test fixture.

### Allowed

Reads of a secret from the environment or the OS credential store, placeholders such as
\`<token>\`, and documented test fixtures with obviously fake values.

## SCOPE-001

severity: warning

### Rule

The change stays within what the current task asked for.

### Violation

The change includes an unrelated refactor, rename, dependency bump, or formatting sweep
that the task did not ask for.

### Allowed

A small cleanup or rename that the task itself required, and mechanical changes to files
the task is about.

## API-001

severity: warning

### Rule

Changes to a public interface are additive or documented.

### Violation

The change removes, renames, or changes the meaning of a public type, function, command,
or configuration key, and neither the docs nor a changelog say so.

### Allowed

Additive options and fields, and a breaking change that ships with its documentation in
the same change.
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
