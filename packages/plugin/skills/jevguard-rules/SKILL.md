---
name: jevguard-rules
description: Use when the user wants to create, add, edit, remove, weaken, or repair a JevGuard policy rule in `.jev/rules.md`, or asks what JevGuard checks. Interviews only for missing rule facts, validates the full candidate with the bundled parser, and requires explicit final confirmation before replacing the file. Do not use for `.jev/config.yaml`, credentials, or running a review.
license: MIT
compatibility: opencode >=1.18.32 <2
---

# JevGuard rules

Author and repair the repository policy that JevGuard reads from `.jev/rules.md`.
The user decides the policy; this skill interviews for the missing facts, drafts a
complete rule document, and validates it with the same parser JevGuard uses before
anything is written.

## Non-negotiables

- Never read, print, or copy a secret value or a secret file. Do not open `.env`,
  credential, key, or token files as rule material.
- Never edit `.jev/config.yaml`. This skill only reads and writes `.jev/rules.md`.
- Never run the public `jevguard` CLI and never call Jev/TypeSafe inference. The only
  tool you invoke is the bundled validator next to this `SKILL.md`.
- Preserve every valid existing rule block unless the user explicitly asks to replace,
  remove, or weaken it. Refuse to silently drop a policy.
- Never write `.jev/rules.md` without a valid parser result and an explicit final
  confirmation from the user.

## Workflow

### 1. Inspect the real policy

Read the actual `.jev/rules.md` in the repository. Then validate exactly that file with
the bundled helper from this skill's base directory:

```sh
bun "<skill-base-dir>/validate-rules.js" .jev/rules.md
```

If Bun is unavailable, run the same file with `node`. The helper prints only a JSON
summary: `status`, rule counts, rule IDs, and parser error codes. It never prints rule
text or file contents. If the file does not exist, treat the policy as empty and say so.

Report the summary to the user: which IDs are valid, which blocks are invalid, and
which error codes apply.

### 2. Interview only for missing facts

Ask, one focused question at a time, only for the facts the user has not already given.
Do not re-ask what an existing valid block already states. The complete rule needs:

1. **Protected boundary** — what must stay true in the codebase.
2. **Concrete violation** — the specific change that breaches that boundary.
3. **Allowed exception** — what is explicitly permitted, or `none`.
4. **Severity** — `error` or `warning`.
5. **Scope** — an optional repo-relative POSIX glob such as `src/**`, or no scope.
6. **Rule ID** — matching `[A-Za-z0-9][A-Za-z0-9._-]*`, unique in the document.

### 3. Complete the candidate

Draft the full `.jev/rules.md`, keeping every existing valid block. New and changed
blocks follow the document grammar:

```md
## ARCH-001

severity: error
scope: src/**

### Rule

<non-empty normative policy>

### Violation

<non-empty breaching condition>

### Allowed

<non-empty exception, or omit the section>
```

Before writing, explicitly call out any change that weakens, removes, or repairs
policy: deleted rules, new exceptions, lowered severity, narrowed scope, or a changed
violation. State exactly what is lost. Never soften a rule without saying so.

### 4. Require exact final confirmation

Show the complete candidate document and the intended file path. Ask for explicit
confirmation of that exact content. A vague "ok" does not count; require confirmation
that names the final document. If the user changes any fact, go back to step 3.

### 5. Stage the candidate in a unique temp sibling

Create one sibling temp file for this execution and write the confirmed candidate to
it. The name must include a fresh random identifier generated now, so two runs can
never collide, for example:

```text
.jev/rules.md.jevguard-<random-id>.tmp
```

where `<random-id>` is a random identifier you generate for this execution (for
example eight hex characters). Do not reuse a fixed temp filename.

Create the temp file exclusively: it must not already exist. If the path exists,
refuses to create, or is a symlink, do not open, follow, or overwrite it; pick a new
random identifier and try again, and never write through a symlink. Record the exact
absolute temp path as owned by this execution and treat every later validation and
deletion as applying only to that recorded path.

Validate the exact temp file with the bundled helper:

```sh
bun "<skill-base-dir>/validate-rules.js" .jev/rules.md.jevguard-<random-id>.tmp
```

If the helper reports `invalid` or `error`, report the safe error codes, remove only
your own recorded temp file, and leave `.jev/rules.md` untouched.

### 6. Hold a version-tied conditional primitive across compare and replace

Before replacing, obtain a primitive that atomically ties the observed target version
to the replacement. Use either:

- a compare-and-swap that replaces `.jev/rules.md` only while it still matches the
  exact version observed in step 1; or
- an exclusive lock on the target that you hold from the byte-for-byte re-read below
  through the replacement, so no other writer can interleave.

While that primitive is held, re-read `.jev/rules.md` and compare it byte-for-byte
with the exact version you observed in step 1. This comparison is the race control. If
the bytes differ, abort before replacement, remove only your own recorded temp file,
and restart from step 1; never overwrite the concurrent edit. Do not release the lock
or discard the compare-and-swap token between this comparison and the replacement.

### 7. Replace conditionally, or stop without writing

With the primitive from step 6 still held, replace `.jev/rules.md` through it, then
release the lock. Read the file back, validate it once more with the helper, and
delete only your own recorded temp file. This final re-read is verification of the
written result, not race control. If it does not match the confirmed candidate, stop
and report; do not claim success.

An ordinary atomic rename is not sufficient by itself: if it can overwrite the
destination without checking the observed version, it can still clobber a concurrent
edit. Only use a rename when it has no-replace or version-conditional semantics, or
when it runs while you hold the exclusive lock from compare through replace.

If the host tools cannot provide a conditional compare-and-swap or an exclusive lock
held from compare through replace, do not write `.jev/rules.md`. Never fall back to a
plain write after the byte-for-byte check. Stop, remove only your own recorded temp
file, tell the user the validated draft is ready, and ask for a supported conditional
write mechanism or a user-assisted replacement. Do not claim the policy was modified.

## Reporting

Report the file path, the final rule IDs and severities, the helper's safe summary, and
any weakening or removal the user approved. Never echo secret values, credentials, or
the contents of non-policy files.
