# ADR 0017: MCP calls are fenced by the same Git snapshot as the shell

Status: accepted — 2026-11-14, owner-approved direction (issue #63). Narrows
[ADR 0014](0014-claude-code-tool-attributed-turn-profile.md): MCP tools no longer make a
unit `UNAVAILABLE` by themselves.

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
  exceeded (`SHELL_DIFF_LIMIT_EXCEEDED`), a concurrent write-capable call in the window,
  a blocked or unreadable path, a Pre without its Post (`PAIRING_BROKEN`) and a call in
  the background (`SHELL_BACKGROUND`).
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
- Each MCP call costs two Git snapshots, like each shell call.
