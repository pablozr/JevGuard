# ADR 0019: Codex hook evidence follows the Claude Code turn profile

Status: proposed — 2026-11-16 (issue #71). Accepted now: only the F0 payload contract
(the host encodings typeset in `src/hook-payload.ts` and enforced by
`test/hook-contract.test.ts`). The decision below is the proposed direction for
F1–F4 — it applies
[ADR 0014](0014-claude-code-tool-attributed-turn-profile.md), the MCP fence of
[ADR 0017](0017-mcp-calls-fenced-by-git-snapshot.md) and the project root of
[ADR 0018](0018-project-root-from-the-edited-repository.md) to a second host — and it
waits for the owner's re-evaluation before any of it is implemented.

## Context

The README lists Codex as a planned host. The open question was whether a Codex turn can
be reviewed on the same contract as a Claude Code turn — only the change attributed to
the turn, never a repository diff, and `UNAVAILABLE` instead of a verdict when the
evidence is incomplete — or whether the host would force a weaker profile.

`codex-cli 0.162.1` exposes a lifecycle of command hooks, and a local smoke test captured
what those hooks actually send. The payloads are in
[`packages/codex-adapter/fixtures/`](../../packages/codex-adapter/fixtures/README.md),
checked by `packages/codex-adapter/test/hook-contract.test.ts`. What they show:

- `UserPromptSubmit` opens the turn and already carries `turn_id`; `Stop` closes it with
  the same id. The unit key exists before the first tool call.
- `PreToolUse`/`PostToolUse` share one `tool_use_id` per call, for `Bash`, `apply_patch`
  and `mcp__<server>__<tool>` alike (observed shape `exec-<uuid>`).
- `apply_patch` sends the complete patch in `tool_input.command`, so the host's report and
  the Git fence can be cross-checked for edits. This cross-check is not inherited from
  Claude Code: there `bashEditDiff` is recorded only as a code and never affects
  acquisition (ADR 0014), so deciding on a disagreement is a new rule for Codex, adopted
  in this ADR and not copied from an existing gate.
- A call that policy refuses still gets its `PreToolUse` and no `PostToolUse` — the same
  broken pairing the Claude Code hook already handles.

## Decision

The Codex adapter takes the same turn profile as Claude Code, without a new evidence
model:

- A unit is the turn: `UserPromptSubmit` to `Stop`, keyed by `session_id` + `turn_id`,
  with subagents in the same unit.
- `Bash` and `mcp__*` calls are fenced by the same Git snapshots, with MCP calls that
  overlap in time sharing one fence as a batch.
- `apply_patch` is fenced the same way **and** carries the patch as a second source; when
  the patch and the fence disagree about which files changed, the unit is `UNAVAILABLE`.
  This one is a **new rule**, not a transfer: in the Claude Code profile the host's edit
  report (`bashEditDiff`) is a cross-check code only and never decides acquisition.
- Tool names are a closed classification: known read-only tools are skipped, `Bash`,
  `apply_patch` and `mcp__*` are fenced, and anything else is `UNKNOWN` and makes the
  unit `UNAVAILABLE` when it could write.
- The project root is the toplevel of the first write-capable evidence (ADR 0018), with
  `MULTIPLE_REPOSITORIES` when a unit touches two repositories.
- Nothing a hook carries as task text (`prompt`) or model output
  (`last_assistant_message`) is logged, sent as evidence or written to disk. The host's
  `transcript_path` is never read: the transcript format is documented as unstable.

## Alternatives considered

- **Review the repository diff at `Stop`.** Rejected: it is the worktree, not the turn,
  and ADR 0003 forbids it.
- **Use `codex exec --json` as the production path.** Rejected: it only covers
  non-interactive runs, not the session a user actually works in. It stays useful as a
  second source in tests.
- **Treat `apply_patch` as trusted and skip the Git fence.** Rejected: the host's report
  is a claim about the call, not proof that nothing else wrote in the window.

## Consequences

- The adapter inherits the Claude Code acquisition code paths instead of a third evidence
  model, which keeps one contract for every host.
- Hooks must be trusted by hash before they run (`/hooks`, or
  `--dangerously-bypass-hook-trust` for vetted automation). A plugin installed but not
  trusted produces no event at all, so the adapter needs a `doctor --host codex` check
  and an `UNAVAILABLE` reason (`HOOK_NOT_TRUSTED`) instead of a silent skip.
- `SessionEnd` is best-effort and was missing from one captured run: `Stop` is the only
  closing event the adapter may rely on.
- Hosted tools (`WebSearch`) never reach the hook path. Any such tool that one day writes
  a file would be invisible, which is why the tool classification stays closed and the
  unknown case is `UNAVAILABLE`.
- The host surface is young. The adapter pins a minimum `codex-cli` version and degrades
  to `UNAVAILABLE` outside it, as the Claude Code adapter does.
