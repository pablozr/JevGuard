# ADR 0017: MCP calls are fenced by the same Git snapshot as the shell

Status: accepted — 2026-11-14, owner-approved direction (issue #63). Narrows
[ADR 0014](0014-claude-code-tool-attributed-turn-profile.md): MCP tools no longer make a
unit `UNAVAILABLE` by themselves. Amended 2026-11-16 (issue #73): MCP calls that overlap
in time share one fence, as a batch — see the addendum at the end.

## Context

ADR 0014 made any `mcp__*` call an unprovable writer: the unit became `UNAVAILABLE`
with `MCP_TOOL`, because an MCP server can write files and the hook sees only the tool
name. Every session of an agent platform that exposes its own tools over MCP (every
`agentes.chat` session uses `mcp__agentes__*`) therefore produced no verdict. In the
owner's real logs of 2026-11-13, 53 reviews had 43 `UNAVAILABLE` units, 41 of them with
`MCP_TOOL`, and none with a verdict.

The shell had the same problem and was solved without trusting the command: the hook
takes a read-only Git snapshot right before and right after the call and attributes the
difference to it (ADR 0014, shell diff).

## Decision

An MCP call is treated exactly like a shell call:

- On `PreToolUse` the hook takes the Git snapshot; on `PostToolUse` or
  `PostToolUseFailure` it takes the second one and attributes the changed files to the
  unit, with the pre-call content as the "before" image.
- A call that changes no file adds nothing to the unit. A unit whose only tools are MCP
  calls with no change is `SKIPPED` (`NO_ATTRIBUTED_PATCH`), like any unit without a
  patch.
- Everything that makes a shell call unprovable makes an MCP call unprovable, with the
  same reasons: a failed or missing snapshot (`SHELL_GIT_DIFF_UNAVAILABLE`), a limit
  exceeded (`SHELL_DIFF_LIMIT_EXCEEDED`), a concurrent write-capable call in the window
  (another MCP call in it is the addendum's batch, not a reason), a blocked or unreadable
  path, a Pre without its Post (`PAIRING_BROKEN`). Only a shell
  call can run in the background (`SHELL_BACKGROUND`): `run_in_background` is read for
  shell tools only and the hook decoder rejects it on any other tool, so an MCP call is
  never a background call and has no such reason.
- `JEVGUARD_CLAUDE_SHELL_GIT_DIFF=0` turns the capture off for both; MCP and shell calls
  are then `UNAVAILABLE`.
- `MCP_TOOL` is no longer produced. It stays a valid reason only so handoffs written
  before this change still parse.

## Alternatives considered

- **An allowlist of MCP tool names that are "safe".** Rejected: the name says nothing
  about what a server does, a server can change its tools at any time, and a wrong entry
  produces a verdict over incomplete evidence, which ADR 0004 forbids.
- **Keep every MCP call `UNAVAILABLE`.** Rejected: it disables the product on every host
  that talks to the agent over MCP.
- **Trust the tool's own report of written files.** Rejected: MCP has no such contract.

## Consequences

- MCP-heavy sessions are reviewed. The Git snapshot has fixed limits (see
  `docs/configuration.md`), so a very large or heavily dirty repository can still
  produce `UNAVAILABLE`, as for the shell.
- Writes that Git cannot see (ignored files, outside the repository) are outside the
  evidence by design, the same as for the shell. An MCP server that writes there is not
  reviewed.
- Each MCP call costs two Git snapshots, like each shell call. A run of calls that
  overlap in time costs two for the whole run instead (see the addendum below).

## Addendum: concurrent MCP calls share one fence (2026-11-16, issue #73)

The decision above assumed one MCP call at a time. A host that exposes its own tools over
MCP fires several of them in one turn (an `agentes.chat` turn routinely starts two to
four `mcp__agentes__*` calls together), and the per-call fence made every such unit
`UNAVAILABLE`: each call's window overlapped another's, and an overlap has no per-call
proof.

**Decision: a run of overlapping MCP calls is fenced once, as one batch.** The snapshot
is taken before the first call of the run and the second one after the last; the
difference between them is attributed to the unit as the batch's change. The unit is the
reviewed thing, not the call: every call of the batch belongs to the same turn, so the
union of what they changed is exactly what the unit changed, and no change of one call is
attributed to another.

What keeps a verdict honest:

- **The batch is closed by its last call.** A call that ends while a sibling is still
  running records no evidence of its own; only the last one diffs, so the closing snapshot
  is taken after every member has finished. Two calls can never both carry a diff.
- **One diff, and only one, is attributable.** A batch whose closing call has no diff, or
  a member that carries one of its own, is `UNAVAILABLE` — never a verdict.
- **A window shared with another kind of writer is not attributable.** If a shell call or
  an edit is open inside the batch's window, the batch becomes `UNAVAILABLE`: an edit has
  its own pre/post images, a shell has its own fence and its own cross-check against the
  host report, and one snapshot cannot separate them. The same holds for a member whose
  `PostToolUse` never arrives (`PAIRING_BROKEN`).
- **A member that arrives before the base snapshot is on disk leaves no proof.** The hook
  processes do not share a lock, so a second call can start while the first call's
  snapshot is still being taken. Its server could write in that gap, and the write would
  already be inside the base picture. A call therefore only joins the batch when the base
  snapshot record is already written; otherwise the batch is marked and the unit is
  `UNAVAILABLE`. Waiting for the snapshot instead was rejected: a hook cannot hold the
  host's tool call open while it waits. The first call of the run is the exception on the
  other side: it never joins its own batch, even when a member's line landed before its
  state read, because its snapshot is the fence the batch depends on (#89).
- **The batch's pre-images are the ones before its first call**, so a file written and
  rewritten across the batch is reviewed as one net change from the state before the run.
- **The cost is one fence per run**: two snapshots for a batch of any size, instead of two
  per call.

The alternative — one fence per call and `UNAVAILABLE` whenever two overlap — was
rejected: it is the state this addendum fixes, and it disabled the product on the host
where the problem was found. Fencing several calls under one snapshot does not turn
incomplete evidence into a verdict: the closing snapshot is taken after the last member
finished, and any writer outside the batch keeps the unit `UNAVAILABLE`.
