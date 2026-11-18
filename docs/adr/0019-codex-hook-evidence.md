# ADR 0019: Codex hook evidence follows the Claude Code turn profile

Status: accepted — 2026-11-16 (issue #71); extended 2026-11-17 with F1, the hook's unit
lifecycle. Accepted: the F0 payload contract (the host encodings typeset in
`src/hook-payload.ts` and enforced by `test/hook-contract.test.ts`) and F1 (the lifecycle
described below, implemented in `src/hook/`). F1 was started on the owner's delegation of
2026-11-17 — "pode mergear oq der e decidir as proximas tasks baseado no que temos
anotado de plano" — which handed the choice of the next slice to the plan recorded for it
rather than to a new review of F0. F2–F4 stay as proposed: the decision below
applies
[ADR 0014](0014-claude-code-tool-attributed-turn-profile.md), the MCP fence of
[ADR 0017](0017-mcp-calls-fenced-by-git-snapshot.md) and the project root of
[ADR 0018](0018-project-root-from-the-edited-repository.md) to a second host, and each
slice starts when the owner says so.

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

## F1: the hook's unit lifecycle

The first implemented slice keeps the unit and says whether its lifecycle is complete. It
acquires nothing, calls nothing and reviews nothing: there is no Git fence, no Jev and no
verdict, so a turn cannot be judged at all until F2 and F3 arrive. What it does fix, so
the later slices cannot start from a looser contract:

- **The unit is the turn.** It is keyed by `session_id` + `turn_id` and opens at
  `UserPromptSubmit`. A tool call or a `Stop` whose opening the hook never saw opens the
  unit too, marked `HOOK_NOT_TRUSTED`: the host can start running hooks mid-turn (right
  after someone trusts them), and a marked unit is more honest than a lost turn.
- **The reading is closed.** Only the six events the F0 capture proved are understood, and
  each must carry the ids the unit needs. Any other event, or a payload without them,
  marks the session (`UNSUPPORTED_EVENT`, `PAYLOAD_UNREADABLE`) and every unit of it can
  then only end `UNAVAILABLE`. This is also the runtime half of the version guard: a host
  that changes its payload falls out here instead of being read as if nothing happened.
  The other half — pinning a minimum `codex-cli` and failing `doctor` outside it — needs
  the install, and lands with F4.
- **Broken pairing marks the unit.** A `PostToolUse` with no `PreToolUse`, a `PreToolUse`
  that never gets its `PostToolUse` (the refused calls of the captured session), or the
  same half twice. A half with no counterpart is `TOOL_CALL_UNPAIRED`; a half of a call
  already seen is `TOOL_CALL_DUPLICATED`, whichever half it is. `Stop` closes the unit; a
  turn replaced before its `Stop` keeps its predecessor marked `TURN_NOT_CLOSED` and
  closed.
- **The state is local and bounded.** Under the `PLUGIN_DATA` directory the host gives the
  plugin hook: one append-only lifecycle file per session, keyed by a digest of the
  session id, plus a heartbeat. Lines hold ids, timestamps and closed codes — never a
  task, a path, a tool input or a diff. Every rule is decided by replaying the file, so
  concurrent hooks only ever append, and a session idle for a day is swept. The file is
  only bounded away from an open unit, when the replayed state has none: the bound is the
  single read-modify-write of the file, and an append another hook makes beside it would
  be lost with the replacement. The rewrite and every append of the session share a short
  write lock (a `lifecycle.lock` created exclusively, retried for about 50 ms, and broken
  when it is older than five seconds), so no append can fall between the rewrite's re-read
  and its rename. A hook that cannot take the lock never waits for long: the rewrite leaves
  the file over its bound until the next safe point, which costs a larger read and nothing
  else, and an append goes on exactly as it did before the lock existed. The rewrite also
  re-reads the file just before replacing it and gives up on any sign that a writer that
  bypassed the lock changed it.
- **An unreadable line marks the unit it fell in.** A line that is not exactly one this
  slice wrote puts `STATE_DAMAGED` on the unit open at that point, or on the next unit to
  open when there was none, and that unit can only end `UNAVAILABLE`. The mark is
  re-derived from the same line on every read: it is logged once per unit it reaches and
  never leaks into the units that follow it.
- **The log is a closed code set.** The hook writes `{ code, event, at }` and nothing else;
  `prompt`, `last_assistant_message`, `transcript_path`, `cwd`, `tool_input` and
  `tool_response` never leave the decoder.

### Gaps F1 leaves to F2

Two cases leave no trace at all. Neither weakens a unit its own events marked — a unit can
only be closed by the `Stop` that carries its ids — but both are recorded here so the next
slice does not start from a stronger promise than the hook keeps:

- **A call whose payload has no `session_id`.** The hook writes `PARSE_FAILED:MISSING_SESSION_ID`
  to its log and keeps no state, because there is no session to mark. A unit open at that
  moment can still close `TURN_CLOSED`, and the call it never saw is invisible. F2 has to
  decide between a marker in the data directory that taints every open unit and leaving
  the case uncovered on purpose.
- **The same `PreToolUse` seen twice while it runs.** Two hooks of the same call can read
  the same state before either appends, so both record a `CALL` and the duplication is not
  charged to the unit. The host would have to repeat a `tool_use_id` in parallel for this
  to happen; the lifecycle keeps the best pairing the file shows and does not guess.

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
  and an `UNAVAILABLE` reason (`HOOK_NOT_TRUSTED`) instead of a silent skip. F1 has the
  reason for a turn whose opening was missed; the check itself needs an install to point
  at and comes with F4.
- `SessionEnd` is best-effort and was missing from one captured run: `Stop` is the only
  closing event the adapter may rely on.
- The write lock costs one exclusive create and one removal per hook, and the two writers
  never overlap: the hook's own writes stay synchronous and it never blocks the host for
  more than the retry window.
- Hosted tools (`WebSearch`) never reach the hook path. Any such tool that one day writes
  a file would be invisible, which is why the tool classification stays closed and the
  unknown case is `UNAVAILABLE`.
- The host surface is young. The adapter pins a minimum `codex-cli` version and degrades
  to `UNAVAILABLE` outside it, as the Claude Code adapter does.
