# Captured Codex hook payloads (F0)

Real payloads that `codex-cli 0.162.1` sent to a command hook on 2026-11-16, on
Windows, kept as the evidence behind `src/hook-payload.ts` and checked by
`test/hook-contract.test.ts`. They are **the host's own encoding**, not JevGuard's
turn model.

Nothing here was edited by hand except the scrubbing described below: absolute paths,
session ids, turn ids and tool-use ids were replaced with stable placeholders so the
pairing between `PreToolUse` and `PostToolUse` survives without publishing a machine's
paths. `transcript_path` was removed from every payload: the host documents the
transcript format as unstable, so it can never be evidence.

## What the two sessions are

| Directory | What happened |
| --- | --- |
| `session-complete/` | One turn that ran three write-capable tool paths — `Bash`, `apply_patch` and one MCP tool — and completed. 9 payloads, in capture order. |
| `session-refused/` | One turn whose `Bash` call the sandbox blocked and whose MCP call was refused for want of an approval (`approval_policy = "never"`), so both calls have a `PreToolUse` and no `PostToolUse`. 6 payloads. `SessionEnd` also arrived here. |

`session-complete` has no `SessionEnd`: on this host `SessionEnd` is best-effort (a
1-second default budget, 3-second ceiling) and it did not arrive in that run. `Stop` is
the event that closes the turn, and the only one a reader should rely on.

## How they were captured

1. A throwaway `CODEX_HOME` was created so the user's own `~/.codex/config.toml` was
   never touched, with:

   ```toml
   approval_policy = "never"
   sandbox_mode = "workspace-write"

   [features]
   hooks = true

   [mcp_servers.f0demo]
   command = "node"
   args = ["<path>/mcp-server.mjs"]
   ```

2. `<CODEX_HOME>/hooks.json` registered one `command` hook per event (`SessionStart`,
   `UserPromptSubmit`, `PreToolUse` with matcher `.*`, `PostToolUse` with matcher `.*`,
   `Stop`, `SessionEnd`). The hook only appends its own stdin to a JSONL file; it
   decides nothing and writes nothing to stdout.

3. The workspace was a throwaway directory with its own Git repository, where the agent
   was told to (1) run `echo hello-f0`, (2) create `notes.txt` with the patch tool,
   (3) call the MCP tool `f0demo.echo`. Two invocations of the same turn were made, and
   the difference between them is what produces the two directories:

   **`session-refused` — the plain invocation.** No approvals and no sandbox bypass, so
   the CODEX_HOME above applied as written: `approval_policy = "never"` and
   `sandbox_mode = "workspace-write"`.

   ```text
   codex exec --json -C <workspace> --skip-git-repo-check \
     --dangerously-bypass-hook-trust "<prompt>"
   ```

   The shell call was blocked by the sandbox and the MCP call was refused because it
   needs an approval that `approval_policy = "never"` can never grant. Neither call
   produced a `PostToolUse`: that run is 6 payloads and is the proof that a refused call
   keeps its `Pre`.

   **`session-complete` — the same turn with the sandbox and approvals bypassed.** Same
   CODEX_HOME, same hook, same prompt, one flag added:

   ```text
   codex exec --json -C <workspace> --skip-git-repo-check \
     --dangerously-bypass-hook-trust --dangerously-bypass-approvals-and-sandbox "<prompt>"
   ```

   With nothing able to refuse the calls, all three tool paths ran to completion: 9
   payloads. Because both runs carry `permission_mode: "bypassPermissions"`, the refused
   payloads show that the field reflects the invocation and says nothing about whether a
   call was allowed — it is not a signal an adapter may read as "this call went through".

   `--dangerously-bypass-hook-trust` was needed in both runs because a non-managed hook
   must be trusted per hash in `/hooks` first; for one-off automation Codex lets you skip
   that review for the invocation. In a real installation the user reviews the hook once,
   and a plugin update that changes the script requires a new review.

The runs were against the user's own Codex login; no hook, script or configuration was
installed in the user's `~/.codex`, and nothing was published.

## What was not observed

- **A refused `apply_patch`.** Only a `Bash` call and an MCP call were refused, so the
  refused-patch shape is unproven: the adapter may assume a refused patch also keeps its
  `Pre` with no `Post`, but no payload here shows it. The same holds for a patch that a
  hook denies rather than the sandbox or the approval policy.
- **A `PostToolUse` for a failed call.** The contract is the absence of one; nothing here
  shows a host that reports a failure through `Post` instead of skipping it.

## What the payloads prove

- **One `tool_use_id` per call, in both halves.** `PreToolUse` and `PostToolUse` carry
  the same id for `Bash`, `apply_patch` and `mcp__<server>__<tool>` alike; the observed
  shape is `exec-<uuid>`, not a shell-only id.
- **One `turn_id` for the whole turn.** It is already present on `UserPromptSubmit`, so
  the unit key exists before the first tool call, and `Stop` repeats it.
- **`apply_patch` sends the complete patch** as `tool_input.command`, beginning with
  `*** Begin Patch` and ending with `*** End Patch`.
- **`tool_input` is identical in both halves**, and `tool_response` differs by kind: a
  string for `Bash` and `apply_patch`, an object with `content[]` for an MCP tool.
- **A refused call still gets its `PreToolUse`.** The `session-refused` payloads show a
  `Pre` with no `Post` for a call that policy blocked — the shape an adapter must treat
  as broken pairing, never as "nothing happened".

## What the payloads also show, and that the adapter must not trust

- `UserPromptSubmit.prompt` is the user's task, and `Stop.last_assistant_message` is
  model output. Both are available to a hook and both are forbidden in the review log
  (and `prompt` is only ever the task, never evidence).
- `transcript_path` exists on most events but the transcript is not a stable interface.
- `permission_mode` is `bypassPermissions` even in `session-refused`, which ran without
  the approvals bypass: it reflects the invocation, not what a call was allowed to do,
  and must never be read as evidence that a call went through.
- Hook processes run with the session `cwd`, and hooks from different sources run
  concurrently: a hook cannot assume it is the only one, nor that it may hold the
  host's call open.
