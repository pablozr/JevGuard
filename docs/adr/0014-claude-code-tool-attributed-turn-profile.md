# ADR 0014: Claude Code tool-attributed turn profile

Status: accepted — 2026-10-05, explicit owner decision. Applies only to the Claude
Code host. OpenCode V1, the OpenCode V2 episode direction (§7.10, ADR 0011–0013)
and their branches are unaffected; this work lives on `claude/claude-code-adapter`.

## Context

The Claude Code investigation (local record)
found no public Claude Code capability that delivers a complete historical
changeset bound to a durable closure. Checkpoints omit shell and most subagent
writes; `bashEditDiff` is beta and best-effort; `/diff` reads the current tree;
transcripts are not a stable contract. Waiting for the V2-grade native capability
would leave Claude Code without any semantic review.

The roadmap (§9, V1) requires each adapter to establish reliable task-to-change
attribution and to report `UNAVAILABLE` rather than substitute an unattributed
repository diff. The question is which subset of Claude Code turns can meet that
bar with evidence we can prove.

## Decision

Claude Code review uses a **quiescent work unit**, not the V2 episode: it opens at
the first user prompt after the previous unit closed and closes at the first main
`Stop` whose `background_tasks` is empty, so delegated and background subagents
finish inside the unit. A `Stop` with active background tasks does not close the
unit; a `Stop` without a readable `background_tasks` closes it as `UNAVAILABLE`.
A unit may contain several prompts, all part of its intention. Interrupted work
without a closing `Stop` stays open and is never reviewed. (Revised 2026-10-05 by
owner decision after the spike: the original main-turn unit made every
orchestrated, subagent-driven session unreviewable.)

The patch is built by a bounded, tool-scoped capture owned by the Claude Code
adapter:

1. **Universe.** Only files named by `Write`, `Edit`, `MultiEdit` and
   `NotebookEdit` calls of the main agent **or any of its subagents** in the unit,
   plus files a shell call changed according to its Git status diff (rule 4).
   Subagents are spawned by the agent, so their changes are agent-attributed.
2. **No-read first.** `checkFilePath` classifies every path before any byte is
   read. A blocked path makes the turn `UNAVAILABLE`; its content is never read,
   stored or exported.
3. **Pre-image.** At the first `PreToolUse` touching a file in the turn, the
   adapter stores its content (or absence). At each `PostToolUse` it records the
   content hash.
4. **Shell (Bash and PowerShell).** Every foreground shell call is bracketed by an
   adapter-owned **Git status diff** (owner decision 2026-10-05, superseding the
   earlier `bashEditDiff` gate for Bash). It runs on Pre and on Post (including
   `PostToolUseFailure`): read-only `git status --porcelain -z
   --untracked-files=all` plus `git hash-object` without `-w` for allowed paths;
   `checkFilePath` runs before any hash and blocked paths are compared by `stat`
   metadata only. Nothing is written to the repository. Each changed file is
   classified by its state at Pre: **clean** (not listed at Pre) enters the
   universe with its pre-image taken from the index (or absence for a new file);
   **dirty and already in the universe** keeps its stored pre-image; **dirty and
   outside the universe** makes the unit `UNAVAILABLE` (no trustworthy pre-image);
   **blocked** makes it `UNAVAILABLE`. (Superseded 2026-10-17 for the pre-image source and the
   dirty-outside-universe case: see "Decision update 2026-10-17: content-attributed
   shell diff".) A missing or failed Git diff (not a
   repository, Git error, missing Pre) makes the unit `UNAVAILABLE`. Background
   shell runs stay `UNAVAILABLE`. Owner decision (2026-10-05): **Git-ignored files
   are outside the evidence** for shell writes; the receipt states this exclusion
   explicitly. A failed shell or edit call is not by itself a reason: the Git diff
   or the continuity check still covers what it wrote. `bashEditDiff` (beta,
   enabled by `bashEditDiffEnabled`; shape `{changedFiles, files, moreFiles}`,
   absent when nothing Git-visible changed) is recorded only as a cross-check code
   and never affects acquisition (spike 2026-10-05: 118/118 agreement).
5. **Continuity.** At `Stop`, the adapter re-reads only universe files. Any hash
   differing from the last attributed post-image (edit tool or shell Git diff)
   means an unattributed writer and the unit is `UNAVAILABLE`.
6. **Patch.** The evaluated patch is pre-image → final image per universe file:
   a net delta, not a concatenation of tool operations. No other file and no
   repository or global diff is ever consulted.

The unit is `UNAVAILABLE` (typed acquisition reason) when it contains, from any
agent: a shell call without a valid Git status diff, run in background, or whose
changed file's pre-call content could not be kept (see the 2026-10-17 update); unknown tools that may write (MCP calls are fenced like the shell since
[ADR 0017](0017-mcp-calls-fenced-by-git-snapshot.md));
prompts with content not represented as text; missing hook events or broken
Pre/Post pairing; a blocked path; an unreadable background-task state at the
closing `Stop`. Coordination tools that do not write files (`SendMessage`,
`Skill`, `SubagentHandback`, task/todo tracking and similar, enumerated
explicitly) do not affect the unit.

A unit with no universe file and no write-capable tool is `SKIPPED`
(`NO_ATTRIBUTED_PATCH`) without calling Jev. Acquisition reasons are adapter-level
and map onto core's existing `UNAVAILABLE` reasons (`MISSING_ATTRIBUTED_DIFF`,
`BLOCKED_EVIDENCE`); core stays host-independent and unchanged by this profile. A
shell Git diff that exceeds one of its limits is the adapter reason
`SHELL_DIFF_LIMIT_EXCEEDED`, which maps to `MISSING_ATTRIBUTED_DIFF`.

Review stays background and observe-only: hooks exit 0 with no stdout and never
use `async`, `asyncRewake`, exit 2, `additionalContext`, `systemMessage` or
`decision` fields. Jev, credentials and network run only in a detached worker
after acquisition, never inside a hook callback. Presentation is user-only (mod
UI and the local review history / `jevguard report`). Remediation is opt-in and
strategy-only; see "Decision update 2026-10-14: opt-in remediation on Claude Code".

The Claude Code adapter never imports `opencode-adapter`. Shared Node
infrastructure (credential provider, Jev transport) and the review use case are
extracted inward before reuse.

## Scope relative to ADR 0013

ADR 0013 rejects owned capture for the OpenCode V2 episode. This ADR is a
host-specific exception for Claude Code only: per-file, tool-named capture plus a
read-only Git status diff bounded to each shell call's duration, with continuity
verification. It writes no Git objects, keeps no persistent snapshot store, and is
not a filesystem scanner, watcher or incremental framework. It does not reopen
owned capture for OpenCode.

## Alternatives

- **Wait for a native historical changeset from Claude Code.** Most complete;
  no public capability exists and the timeline is unknown. Kept as the upgrade
  path, not a prerequisite.
- **Edit-only (all Bash `UNAVAILABLE`).** Strictest; likely excludes most turns,
  since agents run tests and checks through Bash.
- **Transcript parsing + `git diff` at `Stop`.** Rejected: unstable format,
  operations are not net delta, current tree includes other writers.
- **Controlled runner/sandbox.** Separate product surface; not needed to start.

## Consequences and gates

- Known limitation: an unknown writer that modifies a universe file and restores
  the exact attributed bytes before `Stop` is undetectable. Writers outside the
  universe are out of the evidence by construction, which is acceptable because
  they are not the agent's attributed change.
- Shell coverage (owner decisions, 2026-10-05): **Bash and PowerShell** use the
  adapter-owned Git status diff, on by default, with the kill switch
  `JEVGUARD_CLAUDE_SHELL_GIT_DIFF=0` (then every shell call is `UNAVAILABLE`). No
  settings probe is needed; `bashEditDiffEnabled` is optional and only feeds the
  cross-check log code.
  The diff is unavailable when HEAD or the index differ between Pre and Post
  (superseded 2026-10-17: a HEAD or index move alone is no longer a failure), when a
  change lies outside the project root, or when another write-capable call of the
  session overlaps the window (any Pre or Post of a different call after this call's
  Pre, or a call still pending at it): the call cannot be told apart from it. A
  writer of another session in the same repository during the window is attributed
  to the call; this limitation is accepted. A clean file's pre-image is read with
  `git cat-file --filters :<path>`, which matches the worktree's line endings under
  `core.autocrlf`.
- Shell diff limits (implemented and ratified by owner decision 2026-10-13): per hook
  process the diff is bounded by 2000 dirty entries, 16 MiB hashed or read content
  (checked by `stat` before reading), 40 index reads, 16 MiB of Git output, 2 s per Git
  call and 3 s in total. A shell command that changes more than 20 previously clean
  files therefore makes the unit unavailable; this is accepted. Exceeding any of them makes the unit
  `UNAVAILABLE` with the new acquisition reason `SHELL_DIFF_LIMIT_EXCEEDED` (core still
  sees `MISSING_ATTRIBUTED_DIFF`) and logs only `SHELL_DIFF_LIMIT:<limit>`; evidence is
  never partial. A Pre that exceeds a limit leaves a marker, so the Post takes no
  snapshot. A Git timeout or full output buffer is never read as an absent file or an
  unborn HEAD. The values are injectable internally for tests and the benchmark, not
  configurable by users.
- Measured cost (opt-in benchmark `JEVGUARD_SHELL_DIFF_BENCH=1
  JEVGUARD_SHELL_DIFF_BENCH_SCALE=full pnpm exec vitest run
  packages/claude-code-adapter/test/shell-diff-cost.bench.test.ts`; 2026-10-13, Windows
  11, git 2.55.0.windows.5, Node 24.19.0, 12 CPUs, synthetic repositories, median of 5;
  Windows numbers do not carry over to macOS or Linux). Post ms per hook: 10k tracked
  and clean 387; 50k tracked and clean 438; 1000 dirty files of 1 KiB 740; 1000 dirty of
  256 KiB 1476 (524 MB hashed, over the byte limit); 20k untracked files 7119 (over the
  entry limit); 5000 dirty 2007; a formatter rewriting 500 clean files 48886 (about 47 ms
  per `cat-file` call, so 400 reads alone exceed the 5 s total). The ratified
  values (`maxStatusEntries` 2000, `maxContentBytes` 16 MiB, `maxIndexReads` 40,
  `maxGitOutputBytes` 16 MiB, `gitCallTimeoutMs` 2000, `timeMs` 3000) replaced the first
  provisional ones (5000, 64 MiB, 400, 64 MiB, 4 s, 5 s). The goal is a median of about 1 s per hook on
  a typical repository (up to 10k tracked, up to 100 dirty files).
- Capture limits (owner decisions, 2026-10-05): a captured file is at most 1 MiB of
  UTF-8 text without NUL (`CONTENT_TOO_LARGE`, `CONTENT_NOT_TEXT` otherwise);
  unit state and unconsumed handoffs older than 24 hours are removed; the hook log is
  bounded to 256 KiB; `SessionEnd` deletes the session's state, so an open unit is
  lost on resume. A `Stop` of another plugin that continues the turn leaves the
  continued work in a unit without a prompt, which ends `UNAVAILABLE/MISSING_PROMPT`.
- A shell write to a Git-ignored file (for example an ignored `.env` or build
  output) is invisible to review by design of this profile.
- A repository-wide rewrite by a shell command (formatter, codegen) puts every
  changed file in the patch; large units are expected to end as
  `SLICE_LIMIT_EXCEEDED`, which is the honest outcome.
- Long term: request upstream PowerShell/Bash historical diff parity (publication
  needs separate authorization).
- Before any production adapter, a passive classification spike measures the share
  of real turns that would be reviewable and the distribution of acquisition
  reasons. It reads no file content, calls no Jev and stores no paths in clear.
- Pre-image retention is bounded to the in-flight turn and deleted after review.
- Distribution (owner decision, 2026-10-05): the Claude Code plugin is distributed
  through a marketplace and relies on Claude Code's automatic `npm install`
  (`--ignore-scripts`) of the artifact's `package.json` + lockfile for the native
  `@napi-rs/keyring` binaries; no vendored `node_modules`. Local `--plugin-dir`
  testing needs one `npm ci --omit=dev` in the artifact. Node >= 22.13 on `PATH` is a
  documented requirement; without it the hook does not run and the session is
  unaffected. Smoke 2026-10-05 (Windows x64): FAIL, SKIPPED, BLOCKED_EVIDENCE and
  missing-keyring paths verified end to end; other platforms and the marketplace
  install itself are not yet verified.
  Update 2026-10-17: the source is `npm`, package `@pablozrrrr/jevguard-claude-code`
  (marketplace `jevguard`, plugin `jevguard`, install id `jevguard@jevguard`). The artifact
  ships `npm-shrinkwrap.json` (the npm registry excludes `package-lock.json` from published
  packages) and the catalog lives at `.claude-plugin/marketplace.json` on `main`, pinning
  the exact version in `source.version`; the version is declared in `plugin.json` only,
  never in the catalog entry. Release process: (1) bump the same version in `plugin.json`,
  `package.json`, `npm-shrinkwrap.json` and `source.version`; (2) run `pnpm format`,
  `pnpm lint`, `pnpm typecheck`, `pnpm test` and `claude plugin validate .`;
  (3) `pnpm claude-artifact:publish:check`; (4) `npm publish` from
  `packages/claude-code-plugin/dist`; (5) commit and push the catalog, always after the
  npm publish; (6) optionally tag `jevguard--v<version>`.

- Presentation surface (owner decision, 2026-10-14): results are shown to the user by
  a single mod bundled in the plugin's `hooks.json` (`modules`), using `ui.log`
  (a faint transcript line not sent to the model), `ui.status` and `ui.toast`. A
  slash command is rejected because a command result is also read by the model. The
  mod cannot locate `${CLAUDE_PLUGIN_DATA}`, and `$.fs.read` rejects files over
  4 MiB, so the worker writes a small per-session feed under the user data directory
  (allowlist: ids, outcomes, probabilities, typed codes, counts; no paths) at a
  location both sides compute with the same pure function. The feed is presentation
  only; the history stays authoritative. Polling is 2 s for 45 s after each main
  turn, extended up to 150 s per pending review and 15 min in total. Defaults: no
  file paths in the UI, English text, `SKIPPED` only on the status line. Open risk:
  that a plugin with both command hooks and a module keeps running both at runtime.

## Decision update 2026-10-14: opt-in remediation on Claude Code

Owner decisions 1 to 6 replace the earlier "remediation is disabled" statement:

1. Remediation runs from the in-session mod with one `$.model.complete` call that
   carries the core's own system prompt and proposal text (`PROPOSER_AGENT_PROMPT`,
   `buildProposalText`), so Claude Code and OpenCode ask for the same proposal.
2. It is opt-in. The default is off, and only the user can turn it on.
3. The model is the session's by default (`usage.model` of the last main turn, else
   `$.session.model()`); the user may pin a Claude alias or id.
4. The default delivery is a panel only the user sees (`delivery: user`).
5. The request that carries the task and the attributed patch is a private,
   sensitive file.
6. Delivery to the agent (`delivery: agent`) is approved by the owner as an explicit
   exception to observe-only.

Mechanism. After a complete, safe review with a `FAIL`, and only when the user's file
enables it, the worker builds the core's proposal request (`buildProposalRequest`:
complete safe attributed patch, task of at most 16384 characters, at least one `FAIL`,
`auto_propose` true) and writes it to `<data home>/jevguard/claude-code/proposals/
<sessionId>/<epoch>-<ordinal>.json`, `0600` in a `0700` directory, with an expiry of 24
hours. The review's feed line gains `proposal: true` only then. The mod reads the file
once, overwrites it with an empty string (`$.fs` has no delete), validates it strictly,
makes one `$.model.complete` call without retry, and presents the result. The worker
removes blank and expired request files on its next run; the mod refuses an expired one.

Opt-in lives only in the user's file, `<XDG_CONFIG_HOME | USERPROFILE | HOME/.config>/
jevguard/claude-code.yaml`, read by the worker. It is refused (`USER_CONFIG_IN_PROJECT`)
when its real path is inside the project root or its Git working tree (case-insensitive
on every platform; the content is read through the canonical path), because a cloned repository's
`.claude/settings.json` can change `XDG_CONFIG_HOME` through `env`. The plugin's
`userConfig` is not used. In `.jev/config.yaml`, `remediation.auto_propose: false` is a
project veto; a `provider/model` there is ignored (logged as
`REMEDIATION_PROJECT_MODEL_IGNORED`), never translated.

Explicit exception to observe-only (`delivery: agent`). The proposal reaches the agent
through `$.prompt.submit` with a framed text, never `asUser`. The message is visible in
the transcript as sent by the plugin and starts a turn only when the session is idle.
It opens with a fixed marker; the worker finds the marker in the next unit's task and
downgrades that unit's delivery to `user`, so at most one automatic delivery follows a
user-initiated unit. At most 3 deliveries per session (fixed constant); a fourth is
shown in the panel. The count lives in the plugin state per session, so it survives a
reload and a resume. The model text is stripped of control characters, capped at 32768
characters and fenced between delimiter lines after the fixed notice. The resulting turn
is reviewed normally and never triggers another automatic delivery. There is no apply path, retry, forced re-evaluation, or other
injection into the agent's context.

Alternatives rejected: `$.model.fork` (the fork lives in the transcript), a subagent
(its report returns to the parent), `session.append` (hidden from the user), the plugin
`userConfig` (uncertain tier, and not user-only), and `prompt.fill` (the most
conservative option, kept as a possible future `delivery`).

Known limits: the anti-loop depends on the plugin's `$.prompt.submit` passing through
the classic `UserPromptSubmit` hook, which the API documents and the smoke must
confirm; without it the next unit is `UNAVAILABLE/MISSING_PROMPT` and no proposal is
made. An unasked panel is placed only from 144 columns, so the proposal is also written
to `ui.log` in blocks of at most 1900 characters. A request file not consumed is
removed only when the worker next runs, so it can outlive 24 hours on disk while the
mod refuses it by `expiresAt`. The worker never writes a request inside the project
or its Git working tree. Reading and blanking a request is not atomic between two
instances of the mod, because the API has no rename or delete.

## Decision update 2026-10-17: content-attributed shell diff

Status: accepted — 2026-10-17, explicit owner decision. It replaces, for shell calls, the
clean/dirty pre-image rule of rule 4 and the HEAD/index drift rule of "Consequences and
gates". Everything else in this ADR is unchanged.

Context. Ordinary Git work made units `UNAVAILABLE` without saying anything about the
agent's change: `commit`, `switch`, `merge`, `reset`, `add` and `stash` moved HEAD or the
index (`SHELL_GIT_DIFF_UNAVAILABLE`), and `git checkout --` or a formatter on a file
already modified before the unit had no trustworthy pre-image
(`SHELL_CHANGED_OUTSIDE_UNIVERSE`). Both were limits of using the index as the pre-image.

Decision.

1. Pre. Besides the top level and the index links, the Pre records the HEAD commit id and
   keeps the content of every readable dirty file (at most 1 MiB each, inside the
   existing per-hook limits of 16 MiB of read content and 3 s) in a private per-call
   record of the unit state. Blocked paths are still compared by `stat` metadata only and
   are never hashed, read or stored.
2. Post. The call's attributed change is the difference in working-tree content between
   Pre and Post. Candidates are the paths dirty at Pre, the paths dirty at Post, and the
   paths that differ between the HEAD recorded at Pre and the HEAD at Post
   (`git diff-tree -r --name-only`, or `git ls-tree -r --name-only` when one side is
   unborn). A candidate whose content is identical at both moments is not a change.
3. Pre-image. A file dirty at Pre uses its Pre content. A file clean at Pre uses its blob
   in the HEAD recorded at Pre (`git cat-file --filters <head>:<path>`), never the current
   index or HEAD; it is absent when that HEAD was unborn or did not contain the path.
4. A HEAD or index move is no longer a failure by itself. A `commit`, `push` or `add` that
   changes no file content yields an empty change set, and a unit with nothing else is
   `SKIPPED` (`NO_ATTRIBUTED_PATCH`). `switch`, `checkout`, `reset --hard`, `merge`,
   `rebase`, `pull` and `stash` yield the patch of the content they change, attributed to
   the agent.
5. `SHELL_CHANGED_OUTSIDE_UNIVERSE` is no longer produced: a dirty file the call changed
   enters the universe with its Pre content as pre-image. The code stays in the closed
   set only so that handoffs and history written by earlier versions still parse. A dirty
   file whose content the Pre could not keep is `UNAVAILABLE` with a limit reason:
   `CONTENT_TOO_LARGE` over 1 MiB, `CONTENT_NOT_TEXT` when not a regular text file, and
   `SHELL_DIFF_LIMIT_EXCEEDED` when the Pre exceeded a limit (the existing Pre marker).
6. Dirty files are fingerprinted in process by sha256 of their raw bytes, the adapter's
   single digest domain, instead of `git hash-object`; a change of line endings alone is
   a content change.
7. Unchanged: no-read-first; a change outside the project root, an overlapping
   write-capable call, a missing Pre or a Git failure is `SHELL_GIT_DIFF_UNAVAILABLE`;
   Git-ignored files stay outside the evidence; background shells stay unavailable;
   continuity at `Stop`; the kill switch `JEVGUARD_CLAUDE_SHELL_GIT_DIFF=0`; hooks never
   use the network, Jev or credentials and never write to stdout or stderr; Git is only
   read; no repository or global diff; evidence is never partial.

Alternatives rejected.

- A list of ignored Git commands (treat `commit`, `push` and similar as harmless). It
  needs parsing of open-ended shell text (aliases, scripts, `&&` chains, PowerShell), and
  every gap is an attribution hole: a listed command that also changes content would pass
  unattributed, and an unlisted one keeps failing.
- A usage rule ("run Git outside the agent", "commit in another session"). It asks
  something of every user, cannot be enforced, and silently loses review when it is not
  followed.
- Keeping the index as the pre-image and only tolerating HEAD moves. It still fails on
  `checkout --` and formatters over dirty files, and an index changed inside the call
  (`git add`) would give a wrong pre-image.

Consequences.

- A call that brings in other commits (`pull`, `merge`, `switch`) puts that content in the
  agent's patch, and it is reviewed as the agent's change. Large ones end as
  `SHELL_DIFF_LIMIT_EXCEEDED` (more than 20 files clean at Pre, at two object reads each,
  or any other limit) or `SLICE_LIMIT_EXCEEDED`.
- The unit's patch is still pre-image to final image, so switching away and back across
  calls nets out and the unit can be `SKIPPED`.
- The limit values ratified on 2026-10-13 are unchanged. `STATUS_ENTRIES` also bounds the
  paths a HEAD move lists; `INDEX_READS` now counts the object reads of the HEAD recorded
  at Pre (the identifier is kept for log compatibility). The 2026-10-13 cost measurements
  predate this change; re-measure before changing any limit.
- The Pre writes up to 16 MiB of allowed dirty-file content per shell call to the unit's
  private state (`0600` in `0700`), deleted when the Post consumes it, or with the unit
  (closure, `SessionEnd`, 24-hour sweep). It is a transient per-call record, not a
  persistent snapshot store; the scope relative to ADR 0013 is unchanged.
- Known limitations: a file Git-ignored at Pre that the call makes visible (for example
  `git add -f`, or an edited `.gitignore`) reads as created by the call; the pre-image of a
  clean file is rendered with the attributes and configuration in effect at Post.
- Shell records and state lines from earlier versions do not decode: a call in flight
  across an upgrade is `SHELL_GIT_DIFF_UNAVAILABLE`, and a unit with lines in the old
  format ends once as `UNAVAILABLE/CAPTURE_FAILED`.

## Decision update 2026-11-12: single agent delivery

[ADR 0015](0015-single-agent-delivery.md) replaces the bounded `mode: remediate` chain
with one delivery per unit (findings plus strategy). The `delivery: agent` bounds above
(3 per session, never as the user, no turn caused by a delivery delivers again) stand.
