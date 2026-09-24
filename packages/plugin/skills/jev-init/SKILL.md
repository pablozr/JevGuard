---
name: jev-init
description: Use when a repository has no JevGuard policy yet and the user wants to bootstrap `.jev/rules.md` and `.jev/config.yaml` from explicit constraints and strong local evidence. Bounded, read-only inventory; stops if either file already exists; previews both files and requires explicit confirmation before writing. Do not use to edit an existing policy, for credentials, or to run a review.
license: MIT
compatibility: opencode >=1.18.32 <2
---

# JevGuard init

Bootstrap the first repository policy that JevGuard reads from `.jev/rules.md` and
`.jev/config.yaml`. The user states the constraints they want enforced; this skill
reads a **bounded** inventory of the repository to ground those constraints and to
infer only strongly evidenced local conventions, drafts both files with explicit
provenance, validates the exact candidates with the same parser JevGuard uses, and
writes nothing until the user confirms both files by name.

Initialization runs exactly once per repository. After it writes a policy, all later
rule authoring belongs to the `jevguard-rules` skill.

## Non-negotiables

- **Never overwrite an existing policy.** Check `.jev/rules.md` and `.jev/config.yaml`
  first. If either exists, stop, change nothing, and direct the user to the
  `jevguard-rules` skill for any rule change. This skill only creates a policy where
  none exists.
- **Never read, print, or copy a secret value, secret file, or secret store.** Do not
  read environment variables, `.env` or `.env.*` files, credential, key, token, or
  keychain/credential-store files, or `.git/config`. Do not run a command that would
  expose them.
- **Never run the public `jevguard` CLI and never call Jev/TypeSafe inference.** This
  skill makes no Jev call. The only program it invokes is the bundled validator next to
  this `SKILL.md`.
- **Never invent architecture.** Record a rule as `inferred` only when local evidence
  strongly corroborates it. When evidence is weak or speculative, omit the rule
  instead of guessing.
- **Never persist conversation text.** A `user` provenance entry records only
  `source: user` and, when useful, repository-relative evidence paths. It never
  contains the user's words, the prompt, or any chat content.
- **Never overwrite an existing policy file.** Create `.jev/rules.md` and
  `.jev/config.yaml` only with an exclusive-create primitive (`wx`/`O_EXCL`) that
  refuses an existing path, and roll back only the file(s) this run created if either
  target cannot be created. If the host cannot provide that primitive, write neither
  file and present the validated drafts instead.
- **Never write either file before an explicit, both-files-by-name confirmation** and a
  valid validator result on the exact staged candidates.

## Workflow

### 1. Confirm this is greenfield

Read whether `.jev/rules.md` and `.jev/config.yaml` exist. If either exists, stop
immediately: report which file is present, state that initialization is complete or
has already started, and tell the user to use the `jevguard-rules` skill to author,
add, edit, or repair rules. Do not read, draft, stage, or write anything in that case.

### 2. Elicit the user's constraints

If the invocation does not already state the constraints the user wants enforced, ask
exactly one focused question: what policies should JevGuard enforce in this
repository? An explicit `none` is a valid answer: then there are no acceptable rules,
and step 9 writes nothing.

Record every constraint the user gives as an explicit, `user`-sourced rule. Keep the
user's stated intent; do not translate it into a broader rule than they asked for. Ask
only for facts that are genuinely missing, one question at a time.

### 3. Read a bounded inventory

Read only enough to ground the user's constraints and to corroborate concrete local
conventions. The inventory is bounded to:

- agent and contributor instructions such as `AGENTS.md` and `CONTRIBUTING.md`;
- the README and files under `docs/`;
- the project structure (directory and file names);
- language, build, test, format, and lint configuration (for example `package.json`,
  `tsconfig.json`, a formatter or linter config);
- representative source files **only** when they corroborate one concrete candidate
  rule that the user asked for or that strong instructions already support.

Stop as soon as the constraints are grounded. Do not read the whole repository, do not
read generated or vendor directories, and do not read any path excluded above. When a
file could contain a secret, do not open it.

### 4. Derive rules and provenance

Every rule you keep gets exactly one provenance entry. A rule is kept only when it
passes one of these bars:

- **`source: user`** — the user stated the constraint. This is the only source that may
  use `severity: error`; still prefer `warning` unless the user asked for `error`.
- **`source: inferred`** — a strongly evidenced local convention. Record it only with
  **strong corroboration**: a normative document or instruction (an `AGENTS.md`,
  `CONTRIBUTING.md`, or a policy doc) **plus** independent evidence from source code,
  configuration, or project structure that agrees. An inferred rule must be
  `severity: warning` and cite **at least two** safe evidence paths. The bundled
  validator mechanically enforces the `warning` severity and the two-path minimum, but
  it cannot prove that the corroboration is genuinely normative or independent; that
  semantic bar stays yours.

A single README sentence, an isolated code sample, personal preference, or an
aspiration the repository does not already follow is **not** strong evidence. Exclude
speculative rules and say which candidates you dropped and why.

Each rule block keeps the document grammar; `severity` and `scope` remain the only
accepted metadata. Provenance is **never** written inside a rule block.

### 5. Write the provenance preamble before the rules

Provenance lives in one fenced YAML manifest at the very top of `.jev/rules.md`,
before the first `##` rule heading. The rules parser ignores everything before the
first rule heading, so the manifest never becomes policy.

````md
```yaml
rules:
  ARCH-001:
    source: user
  LANG-002:
    source: inferred
    evidence:
      - AGENTS.md
      - package.json
```

## ARCH-001

severity: error

### Rule

...
````

The manifest shape is exact:

- the top level is one `rules` mapping and nothing else;
- each key is a rule ID that also appears as a valid `##` rule heading;
- every valid rule has exactly one entry and every entry maps to a valid rule;
- `source` is exactly `user` or `inferred`;
- `evidence` is optional for `user` and **required with at least two safe paths for
  `inferred`**; the validator rejects an `inferred` entry with fewer than two safe
  paths, an inferred rule that did not parse as `warning`, and any `.git`, absolute,
  traversal, or denied-secret path;
- each evidence path is a repository-relative POSIX path (no leading `/`, no `\`, no
  `..`, no drive letter, no URL) and is never a secret path.

If a candidate rule is dropped, it appears in neither the rules nor the manifest.

### 6. Generate the default configuration

Write the canonical V0.1 defaults to `.jev/config.yaml`, thresholds first and then the
remediation section, exactly:

```yaml
version: 1

thresholds:
  error:
    warn: 0.40
    fail: 0.70
  warning:
    warn: 0.60

remediation:
  auto_propose: true
  propose_on:
    - FAIL
  model: opencode/gpt-5.6-luna
```

Do not invent thresholds, add keys, or change the model. The default configuration is
valid and uses the documented defaults.

### 7. Preview both files and require explicit confirmation

Show the user the complete candidate `.jev/rules.md` — including the provenance
preamble — and the complete candidate `.jev/config.yaml`, each with its intended exact
path. For every rule, state its `source` and, when inferring, the evidence that
corroborates it. List any candidate you dropped.

Ask for explicit confirmation that names **both** exact files, for example
`.jev/rules.md` and `.jev/config.yaml`. A vague `ok` does not count. If the user
changes any constraint, source, or rule, return to step 4 and draft again.

### 8. Stage the confirmed candidates exclusively, then validate

Only after that confirmation, create the two staging files in `.jev/` with a fresh
random identifier generated now, for example
`.jev/rules.md.jev-init-<random-id>.tmp` and
`.jev/config.yaml.jev-init-<random-id>.tmp`. The host's ordinary file tool cannot
guarantee exclusive create, so stage through a tiny temporary script that:

- creates `.jev` if it does not exist;
- opens each staging path with an exclusive-create flag (`wx`, or `O_CREAT | O_EXCL`)
  so an existing file or symlink makes the open fail instead of being followed or
  overwritten;
- writes the exact confirmed candidate bytes;
- exits non-zero without touching any other path if either open fails.

Do not pass a fixed or reused name. Record the two absolute staging paths as owned by
this execution; all later validation and deletion apply only to those paths. If you
cannot run a script with an exclusive-create primitive, stop before writing anything
and present the drafts to the user instead.

Validate exactly those staged candidates with the bundled helper from this skill's
base directory:

```sh
bun "<skill-base-dir>/validate-init.js" ".jev/rules.md.jev-init-<random-id>.tmp" ".jev/config.yaml.jev-init-<random-id>.tmp"
```

The helper prints only JSON: `status`, the valid rule IDs, and deterministic codes. It
never prints rule text, config values, evidence contents, file contents, or
credentials. If it reports `invalid` or `error`, report the safe codes, remove only
your own recorded staging files, and leave the repository policy untouched.

### 9. Commit both files exclusively, or write nothing

Commit only when the exact staged candidates validated as `valid` and there is at least
one acceptable rule. Immediately before committing, re-check that neither
`.jev/rules.md` nor `.jev/config.yaml` exists. Then run a tiny temporary script that:

- creates `.jev` if it does not exist;
- opens each target with an exclusive-create flag (`wx`, or `O_CREAT | O_EXCL`), so a
  path that appeared since the re-check makes the open fail rather than being
  overwritten or followed through a symlink;
- writes the exact validated staged bytes;
- if either open or write fails, closes what it opened, deletes only the target file(s)
  this run created, and exits non-zero — it never overwrites, truncates, or deletes a
  preexisting file;
- removes only its own staging files and the temporary script.

The script reads only its own staged files; it must not open any other repository file,
environment variable, or secret. If the host cannot run a script with an
exclusive-create primitive, write neither target, remove only your own staging files,
present the validated drafts, and do not claim success.

If there are no acceptable rules, write nothing: create neither target, remove only
your own staging files, and report that no policy was bootstrapped. Never write a
speculative rule, and never write a configuration without the rules it belongs to.

After committing, read both files back and validate them once more with the helper. If
the result is not `valid`, stop and report rather than claiming success.

## Reporting

Report both written paths, every final rule ID with its `source` and severity, the
helper's safe codes, and any candidate rule you excluded as speculative or
weakly evidenced. Never echo secret values, credentials, environment values, or the
contents of non-policy files. Never claim a policy was written when the validator did
not return `valid`, the exclusive commit did not succeed, or the user did not confirm
both files by name.
