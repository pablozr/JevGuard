# ADR 0022: Opt-in enforce returns a FAIL to the Claude Code agent

Status: accepted — 2026-11-21 (issue #121). The owner decided the design on
2026-11-21; the nine answers are recorded below. This record is still design only: no
enforce code ships with it, and observe remains the only implemented mode
([ADR 0006](0006-start-in-observe-mode.md)) until the implementation lands.

## Context

JevGuard reviews the change attributed to a turn and reports it. Today the Claude Code
plugin is background and observe-only: its hooks exit 0 with no stdout or stderr, and
the review never alters what the agent sees (`docs/security.md`, "Claude Code plugin").
The review runs in a detached worker after the closing `Stop`; the hook itself only
captures evidence and hands it off.

Two products in this space go further: Semgrep Guardian returns its findings to the
agent to correct, and claude-hooks blocks. The V0.6/V0.7 question is whether JevGuard
should return a `FAIL` to the agent and make it continue, instead of only telling the
user.

The host already exposes the primitive. A Claude Code `Stop` hook may return
`{"decision": "block", "reason": "..."}`; the turn continues and Claude receives the
reason. The same input carries `stop_hook_active` (true when Claude is already
continuing because of a Stop hook) and `background_tasks`; Claude Code caps consecutive
continuations at eight — configurable through `CLAUDE_CODE_STOP_HOOK_BLOCK_CAP` — and
resets the count on a tool call, and a command hook that
reaches its timeout has its output discarded, so a slow enforcer fails open. The
plugin's `Stop` hook currently declares a 30 s timeout
(`packages/claude-code-plugin/artifact/hooks.json`). These are the facts this design
uses (Claude Code hooks reference, read 2026-11-20).

OpenCode is different. The V2 plugin API JevGuard compiles against exposes event
subscription (`event.subscribe`) and tool hooks (`tool.execute.before/after`); it has no
veto at the end of a turn. The nearest enforcement point is a tool hook, before a call
runs, which judges one call, not the turn's attributed change. Enforce at `Stop` is
therefore a Claude Code-only mode; OpenCode stays observe, and the landing must not
promise parity.

## Decision

1. **Mode and opt-in.** Add an `enforce` block to the user's `claude-code.yaml`, off by
   default, and only the user's own configuration can turn it on: the repository's
   `.jev/config.yaml` may veto it but never enable it (the same rule remediation
   already follows). `enforce.rules` is an allowlist of rule IDs; the pilot allowlist
   is `SECRETS-001` and `DESTRUCTIVE-001`. `enforce.budget_ms` defaults to 8000
   (allowed 2000–15000).
2. **Which rules may block.** Only user rules with severity `error` that the user
   listed. A `warning` rule cannot reach `FAIL` in the gate, so listing one can never
   block; it is a configuration warning. Built-in checks never block
   (`SCOPE-CREEP`, `COMPLEXITY`, `TEST-ADEQUACY`), whatever the configuration says;
   listing one is a configuration warning too.
3. **What is reviewed.** The same unit observe reviews: the change attributed to the
   closing `Stop`, with no active background task. Never the worktree, never history. An
   active background task means the hook returns no decision and the turn ends — fail-open
   — and the check is deterministic: the `Stop` input carries `background_tasks`, so the
   hook reads it and never infers it.
4. **When it may block.** Only in an interactive session, and only when an allowlisted
   `error` rule returns `FAIL` on complete, safe evidence. `claude -p`, the SDK and CI
   are out of scope for the first release: the hook blocks only with a positive
   interactive signal from the host, and a run it cannot positively classify is treated
   as non-interactive and never blocks (fail-open, closed code
   `ENFORCE_NON_INTERACTIVE`). `UNAVAILABLE` (missing attributed diff, blocked path,
   oversized or partial evidence, multiple repositories, acquisition limit, Jev failure)
   and `SKIPPED` never block. If the review does not settle within `budget_ms`, or the
   worker fails, the hook returns no decision and the turn ends; the review still lands
   in history.
5. **What it returns.** `decision: "block"` with a `reason` built only from closed data:
   the blocking rule IDs and one instruction to fix the change or explain why the rule
   does not apply. The reason quotes no rule text, no diff, task, path, finding,
   probability or credential, and is capped (2000 characters). The hook log keeps closed
   codes only, as today.
6. **What it never does.** It never edits, stages, reverts, applies or reverts code; it
   never runs a command; it never asks a model for remediation; it never changes
   configuration. The agent decides how to fix, and its next turn is a new unit reviewed
   normally.
7. **Loop control.** One block per unit. `stop_hook_active: true` on the continued
   `Stop` is the second guard, and after the block the stop is allowed with the closed
   code `ENFORCE_CAP_REACHED` recorded. The host's eight-continuation cap (itself
   configurable through `CLAUDE_CODE_STOP_HOOK_BLOCK_CAP`) is a backstop, not the design.
8. **Latency.** The wait is bounded by `budget_ms` (8 s) and stays inside the existing
   30 s `Stop` timeout. The published measurement had a full review at p50 354–377 ms
   and a per-rule review at p50 170–183 ms, on one machine and one network
   ([public benchmark](../benchmarks/README.md)). The 8 s default is about twenty times
   that p50, for cold start and network variance; it is a ceiling, not a promise. A
   timeout is a no-block.
9. **Interaction with remediation.** Enforce and `delivery: agent` coexist and are
   configured independently. For a unit that fails, the block reason goes to the agent
   in the continued turn, and the remediation proposal — when its own settings are on
   and it settles in its own budget — is delivered as it is today. Neither suppresses
   the other, and the closed codes record both. A remediation proposal never lifts a
   block and a block never changes a proposal.
10. **Acknowledging a FAIL.** The user can accept a `FAIL` for one unit, and only the
    user can. `jevguard ack` lists the units the hook blocked, newest first and numbered
    from the local review history, and records the chosen one in a local, bounded,
    content-free acknowledgement ledger next to the review history (unit code, rule IDs,
    timestamp). Before blocking, the hook consults the ledger; an acknowledged unit is
    not blocked again and the hook records `ENFORCE_ACKED`. The command requires an
    interactive terminal and an explicit confirmation: it has no non-interactive form
    and no flag skips the confirmation, so an agent shell cannot acknowledge a unit on
    the user's behalf. An acknowledgement changes nothing in the review, the rule or the
    finding — it only silences the gate for that unit — and `jevguard feedback` remains
    the way to say a `FAIL` was wrong.

## Owner decisions (2026-11-21)

The nine questions this record closed, as the owner answered them:

1. The pilot blocks on `SECRETS-001` and `DESTRUCTIVE-001` only (decision 1).
2. One block per unit, not two (decisions 7 and 10).
3. The block reason names the rule ID only, never the rule text (decision 5).
4. Interactive only; `claude -p` and CI never block (decision 4).
5. Only the user's configuration enables enforce; a repository cannot opt in
   (decision 1).
6. The user can acknowledge a `FAIL` for the unit, through `jevguard ack`
   (decision 10).
7. The hook budget is 8 s (decision 8).
8. Enforce and remediation proposals coexist (decision 9).
9. A built-in never blocks; only user rules can (decision 2).

## How the contract holds

- **Only the turn's change.** The unit and its evidence rules are the observe ones; the
  block is a verdict on that patch, never on leftover worktree state.
- **No verdict from incomplete evidence.** Any acquisition failure is `UNAVAILABLE`, and
  `UNAVAILABLE` never blocks. A partial patch is never reviewed and never blocks.
- **UNAVAILABLE never blocks.** A timeout, a worker failure, a missing credential, a
  blocked path, an oversized patch and a non-interactive session all end in "the turn
  stops", not in a block.
- **Never edits the user's code.** The block is a message; the next action is the
  agent's, under the user's normal permissions.
- **Never logs the task, diff, finding or a credential.** The reason carries rule IDs
  only; the log and the acknowledgement ledger carry closed codes, as today.

## Risks

- **False positives block work.** A `FAIL` is a probability above the gate, not proof.
  Mitigation: opt-in, `error` only, a pilot with two rules — one of them measured only
  by the pilot itself (see the rollout note) — and the corpus rates checked before any
  default.
- **Unwanted turns cost tokens.** A block starts a turn the user did not ask for; the
  single block per unit bounds it.
- **A rule may be unfixable in the turn** (the task itself requires the violation). The
  agent can explain, but the block still forces one more turn; the cap bounds the cost.
- **An acknowledgement can silence a real failure.** The user may accept a `FAIL` the
  rule got right. It is a deliberate, user-only, per-unit override; it leaves the review
  and the history intact, and `jevguard feedback` keeps the calibration honest.
- **Enforcement is not a security boundary.** The user can disable the plugin or the
  hook. It is a workflow gate, not a sandbox.
- **Interactive detection.** The interactive-only decision depends on a signal the host
  makes available to the hook; if no reliable marker exists, the design fails open
  (never blocks) rather than guess. The detector must be pinned with a test against the
  host's real markers when implemented.
- **Host change.** If the `Stop` decision contract changes, the mode breaks; when
  implemented, a test must pin the documented shape.

## Alternatives considered

- **`hookSpecificOutput.additionalContext` only.** Softer (guidance, no hook error), but
  it is not a `FAIL` and does not fit "return the verdict to the agent".
- **`delivery: agent` proposal (already implemented).** A visible message with findings,
  not a gate; it coexists in observe and with enforce, but it does not make the agent
  continue.
- **`PreToolUse` blocking.** It can stop a call before it runs, which is a different
  policy point and cannot judge the turn's complete change.
- **Exit 2 with stderr.** Same effect as a block, noisier and easier to confuse with a
  crash; the JSON decision is explicit.
- **Enforce on OpenCode.** No turn-end veto in the plugin API; would need a host feature.
- **Always-on enforce.** Rejected: observe is the default and the product's promise.

## Rollout

V0.7 ships enforce as an opt-in, Claude Code-only, interactive-only mode: `error` rules
from the user's allowlist, one block per unit, an 8 s budget, default off, piloted with
`SECRETS-001` and `DESTRUCTIVE-001`, coexisting with remediation delivery, with
`jevguard ack` as the user's per-unit override.

The two pilot rules do not enter on equal footing. The [rule pack](../rule-packs.md)
has two layers: `SECRETS-001` is in the starter pack and measured by the public corpus;
`DESTRUCTIVE-001` is a proposed addition that `init` does not scaffold and the corpus
does not measure. The pilot's second rule therefore enters unmeasured, and the
false-positive mitigation above ("the corpus rates checked") does not cover it yet. The
plan is explicit, one of two ways:

- its corpus cases land with a live run before the pilot starts (#118); or
- the pilot's own sessions are where its false positives are first measured — in which
  case "before any default" means the pilot's observed block rate, not a corpus number,
  and the rule stays opt-in until a corpus run exists.

Keep OpenCode observe-only and say so. Do not make enforce the default and do not extend
it to `warning` rules or built-ins.
