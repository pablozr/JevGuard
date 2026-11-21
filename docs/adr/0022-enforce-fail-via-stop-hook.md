# ADR 0022: Opt-in enforce returns a FAIL to the Claude Code agent

Status: proposed — 2026-11-20 (issue #106). This record is a design proposal. No
enforce code ships until the owner decides; observe remains the only implemented mode
([ADR 0006](0006-start-in-observe-mode.md)).

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

## Decision (proposed)

1. **Mode and opt-in.** Add an `enforce` block to the user's `claude-code.yaml`, off by
   default. The repository's `.jev/config.yaml` cannot enable it — it may only veto, as
   with remediation. `enforce.rules` is an allowlist of rule IDs (empty means none),
   `enforce.max_blocks` defaults to 1 (allowed 1–2), and `enforce.budget_ms` defaults to
   8000 (allowed 2000–15000).
2. **Which rules may block.** Only `error` rules. A `warning` rule cannot reach `FAIL` in
   the gate, so listing one can never block; it is a configuration warning. Built-in
   checks do not block in this first design.
3. **What is reviewed.** The same unit observe reviews: the change attributed to the
   closing `Stop`, with no active background task. Never the worktree, never history. An
   active background task means the hook returns no decision and the turn ends — fail-open
   — and the check is deterministic: the `Stop` input carries `background_tasks`, so the
   hook reads it and never infers it.
4. **When it may block.** Only when an allowlisted `error` rule returns `FAIL` on
   complete, safe evidence. `UNAVAILABLE` (missing attributed diff, blocked path,
   oversized or partial evidence, multiple repositories, acquisition limit, Jev failure)
   and `SKIPPED` never block. If the review does not settle within `budget_ms`, or the
   worker fails, the hook returns no decision and the turn ends; the review still lands
   in history.
5. **What it returns.** `decision: "block"` with a `reason` built only from closed data:
   the blocking rule IDs and each rule's own `Rule` text, a count of other failing rules
   not listed, and one instruction to fix the change or explain why the rule does not
   apply. No diff, task, path, finding, probability or credential. The reason is capped
   (2000 characters) and the hook log keeps closed codes only, as today.
6. **What it never does.** It never edits, stages, reverts, applies or reverts code; it
   never runs a command; it never asks a model for remediation; it never changes
   configuration. The agent decides how to fix, and its next turn is a new unit reviewed
   normally.
7. **Loop control.** At most `max_blocks` blocks per unit (default 1). The count is
   stored per session and unit, and `stop_hook_active: true` on the continued `Stop` is a
   second guard. After the cap the stop is allowed and a closed code
   (`ENFORCE_CAP_REACHED`) is recorded. The host's eight-continuation cap (itself
   configurable through `CLAUDE_CODE_STOP_HOOK_BLOCK_CAP`) is a backstop, not the design.
8. **Latency.** The wait is bounded by `budget_ms` and stays inside the existing 30 s
   `Stop` timeout. The published measurement had a full review at p50 354–377 ms and a
   per-rule review at p50 170–183 ms, on one machine and one network
   ([public benchmark](../benchmarks/README.md)). The 8 s default is about twenty times
   that p50, for cold start and network variance; it is a ceiling, not a promise. A
   timeout is a no-block.
9. **Interaction with remediation.** For a unit, enforce and `delivery: agent` do not
   both run: an enforce block ends the turn before a proposal would be delivered. The
   user-only feed still records the review either way.

## How the contract holds

- **Only the turn's change.** The unit and its evidence rules are the observe ones; the
  block is a verdict on that patch, never on leftover worktree state.
- **No verdict from incomplete evidence.** Any acquisition failure is `UNAVAILABLE`, and
  `UNAVAILABLE` never blocks. A partial patch is never reviewed and never blocks.
- **UNAVAILABLE never blocks.** A timeout, a worker failure, a missing credential, a
  blocked path and an oversized patch all end in "the turn stops", not in a block.
- **Never edits the user's code.** The block is a message; the next action is the
  agent's, under the user's normal permissions.
- **Never logs the task, diff, finding or a credential.** The reason carries rule IDs and
  the user's own rule text; the log carries closed codes, as today.

## Risks

- **False positives block work.** A `FAIL` is a probability above the gate, not proof.
  Mitigation: opt-in, `error` only, a pilot with two rules — one of them measured only by
  the pilot itself (see the recommendation) — and the corpus rates checked before any
  default.
- **Unwanted turns cost tokens.** A block starts a turn the user did not ask for; the
  default cap of one bounds it.
- **A rule may be unfixable in the turn** (the task itself requires the violation). The
  agent can explain, but the block still forces one more turn; the cap bounds the cost.
- **Enforcement is not a security boundary.** The user can disable the plugin or the
  hook. It is a workflow gate, not a sandbox.
- **Headless runs.** `claude -p` also runs `Stop` hooks; a block adds a turn a
  non-interactive caller may not expect. The first release should be interactive-only
  unless the owner decides otherwise.
- **The user waits at Stop.** The review moves into the turn's critical path; opt-in and
  the budget are the mitigation.
- **Host change.** If the `Stop` decision contract changes, the mode breaks; when
  implemented, a test must pin the documented shape.

## Alternatives considered

- **`hookSpecificOutput.additionalContext` only.** Softer (guidance, no hook error), but
  it is not a `FAIL` and does not fit "return the verdict to the agent".
- **`delivery: agent` proposal (already implemented).** A visible message with findings,
  not a gate; it can coexist in observe, but it does not make the agent continue.
- **`PreToolUse` blocking.** It can stop a call before it runs, which is a different
  policy point and cannot judge the turn's complete change.
- **Exit 2 with stderr.** Same effect as a block, noisier and easier to confuse with a
  crash; the JSON decision is explicit.
- **Enforce on OpenCode.** No turn-end veto in the plugin API; would need a host feature.
- **Always-on enforce.** Rejected: observe is the default and the product's promise.

## Recommendation

Ship V0.7 as an opt-in, Claude Code-only enforce mode: `error` rules only, one block per
unit, an 8 s budget, default off, piloted with `SECRETS-001` and `DESTRUCTIVE-001`.

The two rules do not enter the pilot on equal footing. The [rule pack](../rule-packs.md)
has two layers: `SECRETS-001` is in the starter pack and measured by the public corpus;
`DESTRUCTIVE-001` is a proposed addition that `init` does not scaffold and the corpus does
not measure. The pilot's second rule therefore enters unmeasured, and the false-positive
mitigation above ("the corpus rates checked") does not cover it yet. The plan is explicit,
one of two ways:

- its corpus cases land with a live run before the pilot starts (#118); or
- the pilot's own sessions are where its false positives are first measured — in which
  case "before any default" means the pilot's observed block rate, not a corpus number,
  and the rule stays opt-in until a corpus run exists.

Keep OpenCode observe-only and say so. Do not make enforce the default and do not extend
it to `warning` rules.

## Open questions for the owner

1. Which rules are enforceable first: `SECRETS-001` and `DESTRUCTIVE-001` only?
2. One block per unit, or allow a second correction attempt?
3. Should the reason quote the rule text, or only name the rule ID?
4. Interactive only, or also `claude -p` and CI?
5. User configuration only, or may a repository opt in?
6. When the user disagrees with a `FAIL`, can they acknowledge it for the unit, or only
   disable the rule?
7. Is 8 s the right budget, or lower (5 s) to protect the interactive loop?
8. Does enforce replace `delivery: agent` proposals, or coexist with them?
9. May a built-in (`SCOPE-CREEP`) ever block, or only user rules?
