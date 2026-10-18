# Security Model

JevGuard sends code-change evidence to Jev, and — only in the configurable remediation
path, and only when a review has a `FAIL` with complete safe evidence — to the hidden
proposer subagent. Evidence safety is therefore a product boundary, not a best-effort
feature.

## What is sent

For an applicable rule, JevGuard sends:

- the direct parent user task;
- the rule ID, policy, violation definition, and optional allowed exception;
- the full attributed textual diff for changed files within the rule scope;
- the relevant file paths.

For the built-in batch (`SCOPE-CREEP` and `COMPLEXITY`), JevGuard sends the same task,
both checks' own definitions, the complete attributed textual diff for every changed
file with a nonempty patch, and those paths. It sends no rule-scoped subset. The batch
is a single request with two independent answers; the same complete evidence feeds both.

It does not send repository-wide diffs as a fallback.

`jevguard rules check` sends the same per-rule evidence under the same policy, but from a
diff you provide: the task from `--task` (or a fixed default task), the rule policy, the
diff of the files within each rule's scope, and their paths. The evidence policy still
applies, so a denylisted path makes the rule `UNAVAILABLE` (`BLOCKED_EVIDENCE`) before
anything is sent. The diff parser is strict so that policy cannot be bypassed through
the input: it accepts only `git diff` output (or a plain `---`/`+++` diff) with `a/`
and `b/` prefixes, and it refuses the whole input (exit `2`, nothing sent) for a rename
or copy with content (otherwise `.env` content could travel under an allowed path),
combined or merge diffs, `git log -p` or format-patch output, truncated hunks, content
outside a file section, unsupported prefixes, quoted paths, binary patches and invalid
UTF-8. It sends no built-in batch, starts no remediation and records no
history. Its output never contains the task or the diff. `--task` is visible in the
process list, so keep secrets out of it.

## What the remediation path sends to the coding model

Safe auto-propose remediation is separate from Jev evaluation and is delivered by the
server plugin. After presenting a review that contains any `FAIL`, and only when
`remediation.auto_propose` is enabled, the plugin sends one aggregate proposal request
to a hidden `jevguard-proposer` subagent in an isolated child session parented to the
source session. The request carries every `FAIL` finding (local `error` rules and the
`SCOPE-CREEP` built-in), the turn's task, and the turn's complete, safe, full
attributed patch; it is never built from a repository or global diff.

The full attributed patch must pass the same safety policy as the review. If any
attributed file is blocked or the patch is oversized, no proposal is sent at all — even
when a rule-scoped `FAIL` exists — because there is no complete safe evidence. The
proposer subagent has wildcard-disabled tools and wildcard-deny permissions, so it
cannot call a tool, edit a file, or produce a patch; it returns a strategy and one
manual apply instruction only. The proposal prompt instructs the model to treat the
task, paths, diff, rules, and findings as untrusted data and to require a separate
explicit user confirmation before proposing changes to tests, configuration, or
dependencies. The generic readiness toast carries no rule, task, diff, finding, or
credential. No secret is carried, and no payload, task, diff, or secret is logged. A
contained proposal failure shows a generic failure toast and writes one structured
`error` log entry whose `extra` carries only a typed reason code
(`MODEL_SPECIFIER_INVALID`, `CHILD_SESSION_FAILED`, or `PROPOSAL_PROMPT_FAILED`); the
failure log never carries task, diff, findings, paths, or credentials. Nothing is
applied automatically: the user copies the manual apply instruction into their normal
coding agent, and that ordinary turn is reviewed normally.

## Evidence must be complete

JevGuard never truncates a relevant diff. The scoped diff for a rule's applicable
files is capped at `100000` characters per rendered slice. A scoped diff at or below
the cap is one whole slice; a larger diff is split, in attributed file order, into
per-file slices, and an individually oversized file is split into its ordered
unified-diff hunks with the file preamble repeated in each slice. Every slice passes
the same allowlist and sensitive-path denylist as the whole diff, and slice content is
drawn only from files that already passed the safety preflight, so blocked content
never appears in any slice. Nothing is truncated or summarized.

It also does not evaluate a rule from a subset of its relevant files. If any
applicable file is rejected by the safety policy, the whole rule is `UNAVAILABLE` with
reason `BLOCKED_EVIDENCE` and no slice is sent.

A rule may produce at most 16 slices, and slicing may add at most 32 repository-rule
Jev calls per turn beyond one per applicable rule, reserved in policy source order. A
rule that does not fit is `UNAVAILABLE/SLICE_LIMIT_EXCEEDED` with no Jev call, and
later rules still use the remaining budget. An unparseable oversized file or an
indivisible oversized hunk makes the whole rule `UNAVAILABLE/OVERSIZED_DIFF`.

The same cap and rejection apply to each built-in over the whole attributed patch.
Built-ins never slice, so an oversized or blocked file makes the built-in `UNAVAILABLE`
rather than evaluating it on partial evidence.

Rejections are scoped to the rules they affect. Evidence is selected per rule from
that rule's applicable files, so an oversized or blocked file makes only the rules
whose scope matches it `UNAVAILABLE`; rules with disjoint, safe applicable files
still run.

## File safety policy

The evidence policy is fixed in core (not configurable). Only common code and text
extensions may be sent; a file without an allowlisted extension is rejected rather
than assumed textual.

The allowlist is split into two extension classes:

- a **code/data** class covering common source, config, shell, and data text formats,
  for example `.ts`, `.tsx`, `.json`, `.yaml`, `.toml`, `.css`, `.html`, `.py`,
  `.rb`, `.go`, `.rs`, `.java`, `.cs`, `.php`, `.c`, `.cpp`, `.swift`, `.sh`,
  `.ps1`, `.sql`, `.graphql`, `.tf`, `.csv`, and `.patch`;
- a **prose-docs** class covering `.md`, `.mdx`, and `.txt`.

A rule's `evidence:` key selects which class it evaluates: `code` (the default),
`docs`, or `any`. The default `code` means prose documentation does not enter a code
rule's evidence, so plan and ticket files cannot sway a code judgment. A rule that
genuinely inspects documentation declares `evidence: docs` or `evidence: any`.

Class filtering removes a file only when its extension belongs to the other class. A
denied sensitive path and a file whose extension is in neither class are always
retained, so the blocked-evidence check still rejects them instead of silently
omitting them. The `SCOPE-CREEP` and `COMPLEXITY` built-ins are turn-level and use
both classes together.

Sensitive paths are always rejected, including:

- exact file names such as `.env`, `.envrc`, `.netrc`, `_netrc`, `.npmrc`,
  `.pypirc`, `.pgpass`, `.git-credentials`, `.htpasswd`, `.dockercfg`, `id_rsa`,
  `id_dsa`, `id_ecdsa`, `id_ed25519`, `credentials`, `credentials.json`,
  `credentials.yaml`, `credentials.yml`, `secrets`, `secrets.json`,
  `secrets.yaml`, `secrets.yml`, `shadow`, and `master.key`;
- extensions such as `.pem`, `.key`, `.p12`, `.pfx`, `.jks`, `.keystore`, and
  `.ppk`;
- directory segments such as `.ssh`, `.aws`, `.gnupg`, `.azure`, `.kube`, and
  `.docker`.

Matching is case-insensitive and treats both `/` and `\` as separators. A
dot-prefixed denied name also matches its dotted variants, so `.env` rejects
`.env.local`; entries without a leading dot such as `credentials` and `secrets`
match exactly. The invariant is that rejected content never leaves the machine.

Structured logs may record a rejected path and reason. They must never record the
rejected file contents, and a rejected file is never replaced by the repository
diff or by another file's patch.

## Local review history

The server plugin also appends every review to a local, bounded JSON Lines history so
operators can aggregate outcomes without parsing the host's log file. Each record is
exactly the structured-log projection allowlist plus an ISO 8601 timestamp: the
aggregate counts, each result's rule or check ID, its outcome, its severity, its
scoped paths, its raw probability or typed reason, and its slice metadata. It stores
no task, diff, prompt, model output, credential, API key, or environment value.

The file lives at `<XDG_DATA_HOME>/jevguard/reviews.jsonl` when `XDG_DATA_HOME` is set
to a non-empty absolute path, and otherwise at `~/.local/share/jevguard/reviews.jsonl`
on every platform, including Windows. A relative `XDG_DATA_HOME` is ignored. It is
local-only, never uploaded, and bounded: once it passes 5 MB it is rewritten atomically
(a temporary file renamed in place) keeping only the newest records. You can delete it
at any time; the next review recreates it.

A write failure is contained and never affects a review, presentation, or a later
turn. `jevguard report` reads and aggregates this file and prints aggregated counts,
rule IDs, check IDs, and reason codes only — never a file path, task, diff, or
credential.

## Local rule feedback

`jevguard feedback` stores your right/wrong decisions about rule `FAIL`s in two local
files under the same data directory as the review history:

```text
<XDG_DATA_HOME or ~/.local/share>/jevguard/feedback.jsonl
<XDG_DATA_HOME or ~/.local/share>/jevguard/feedback-selection.json
```

`feedback.jsonl` has one line per answer with exactly four fields: `turnId`, `ruleId`,
`decision` (`RIGHT` or `WRONG`), and `timestamp`. `feedback-selection.json` holds the
identifiers shown by the last listing (`turnId`, `ruleId`) and `listedAt`. Neither
file stores a task, diff, finding, file path, file content, or credential.

Both files are created owner-only (mode 0600 inside a 0700 directory; on Windows the
profile's ACL applies). `feedback.jsonl` is bounded to 1 MiB: past that it is compacted
atomically to one line per answered FAIL with its latest decision, keeping at most the
5000 most recently answered FAILs; nothing else changes. The data is local-only, never uploaded, and
safe to delete at any time. It does not change policy, thresholds, outcomes, or any Jev
call; it only feeds the calibration printed by `jevguard report`.

## Rule authoring skill

The package ships two OpenCode skills with private validators: `jevguard-rules` to
author rules and `jev-init` to bootstrap a policy where none exists. On startup the
plugin's `config` hook appends the installed skill directories to the host's
`skills.paths` and leaves every other config key untouched; it reads no credential and
performs no evaluation.

`jevguard-rules` authors `.jev/rules.md` only. It reads the current policy, interviews
for missing rule facts, writes a candidate to a temp sibling, validates that exact
candidate with the same parser JevGuard uses, and replaces the real file only after the
candidate is valid and the user explicitly confirms the final content. It never edits
`.jev/config.yaml`, never runs the public `jevguard` CLI, and never calls Jev/TypeSafe
inference.

`jev-init` runs only when neither `.jev/rules.md` nor `.jev/config.yaml` exists. It
reads a bounded inventory — agent instructions, README and docs, project structure,
language/build/test/format/lint configuration, and representative source only to
corroborate a concrete candidate — and records provenance in a preamble before the
rules. It never reads environment variables, `.env` or credential files, the credential
store, or `.git/config`, and it never reproduces a secret value. It validates the exact
staged candidates with the production rule parser and the production gate and
remediation config resolvers, and writes both files only after the user confirms both
exact paths. It never calls Jev/TypeSafe inference.

The `jev-init` validator's guarantees are mechanical: it rejects a symlinked candidate
path before reading it, requires every `inferred` rule to have parsed as `warning` with
at least two safe evidence paths, rejects `.git` and denied-secret evidence references,
and validates the default gate and remediation configuration. The agent workflow carries
the guarantees a validator cannot check: that an inferred rule has genuinely normative,
independent corroboration, and that both files are created with an exclusive-create
primitive (`wx`/`O_EXCL`) that rolls back only the file(s) that run created and never
overwrites or deletes a preexisting file.

Each validator is a private helper, not a public CLI. It prints only a content-free
JSON summary: status, rule IDs, and deterministic error codes. It never prints rule
text, config values, evidence contents, document contents, file contents, or
credentials, and it rejects a missing path, a directory, a symlink, an oversized
document, and a read failure with a typed error code. Like the rest of JevGuard, the
skills must never read or reproduce secret values or secret files.

## Plugin registration

`jevguard install` (and `jevguard install --project`) registers the plugin by editing
only the `plugin` array of the target `opencode.json` — the global config under
`~/.config/opencode/` or the project config at `./opencode.json`. It requires an
explicit interactive `y/N` confirmation before any write and refuses when stdin is not
a TTY. It never creates or edits a `.jsonc` file, never falls back to a different
document, and never reads the credential store or `auth.json`. It only edits a
`plugin` array of plain strings; OpenCode's `[["pkg", { "options": {} }]]` tuple form
is a known limitation, so the installer leaves the file unchanged and prints the
manual snippet instead.

## Credentials

For normal local use, run the login command with the published package:

```sh
bunx --package @pablozrrrr/jevguard jevguard login
```

Or install it globally so `jevguard` is on `PATH`:

```sh
bun install --global @pablozrrrr/jevguard
jevguard login
```

Adding the plugin to `opencode.json` does not put `jevguard` on `PATH`. Install the
package globally — or run it through `bunx` — to run `jevguard login`.

The CLI reads the key using a masked terminal prompt and stores it in the native
operating-system credential store:

- macOS: Keychain;
- Windows: Credential Manager;
- Linux: Secret Service/keyring.

JevGuard reads the credential each time it evaluates a turn. The API key never
belongs in `.jev/`, `opencode.json`, agent messages, logs, toasts, test fixtures,
or a committed file.

For CI and controlled automation, set `TYPESAFE_API_KEY` in the job's secret
environment. This environment value overrides the credential store for that
process. Do not print it, pass it as a CLI argument, or use a shell command that
persists it in history.

If neither source provides a key, the plugin stays loaded and the evaluation is
`UNAVAILABLE`, with a safe instruction to run `jevguard login`.

`jevguard doctor` reports where the key comes from (the OS credential store or the
`TYPESAFE_API_KEY` override) without printing the key or any part of it. It makes no
network call and creates no Jev transport.

> [!IMPORTANT]
> A secret passed through the environment of the OpenCode process can be inherited
> by subprocesses. The credential store is the preferred path for local use because
> it avoids placing the key in the agent process environment. Treat environment
> credentials as an automation/CI integration surface, not a local secret vault.

## Operational outcomes

`UNAVAILABLE` is intentional when JevGuard cannot obtain complete safe evidence,
validate policy, access Jev, or retrieve the attributed diff. It is not a policy
pass, a warning, or a failure, and the review does not block work. Remediation is a
separate, configurable proposal delivered by the server plugin that runs only when a
review contains a `FAIL` with complete safe evidence and is bounded as described above.

A policy-load or config failure does not suppress the built-in batch: when the turn is
attributed, both built-ins still evaluate the complete safe patch with their fixed
thresholds. `SCOPE-CREEP` can fail; `COMPLEXITY` is advisory and can only pass or
warn. One malformed answer fails only its own check.

## Claude Code plugin

The Claude Code plugin keeps the same boundaries as the OpenCode plugin: review is
background and observe-only, and hooks exit 0 with no stdout or stderr and never use
`async`, `asyncRewake`, `additionalContext`, `systemMessage`, or `decision`.
Remediation is off by default. Only the user can turn it on, in their own
`claude-code.yaml` (never in the repository); it is strategy-only and works as described
in "Proposal requests" and "Agent delivery" below.

- **Supply chain.** The marketplace catalog pins one exact version of the npm package
  `@pablozrrrr/jevguard-claude-code`; Claude Code downloads that version, and the native
  keyring comes from the package's `npm-shrinkwrap.json`, which pins every tarball by
  version, https registry URL and sha512 integrity. Dependencies are installed with
  `--ignore-scripts`, so no install script runs. The hook never uses the network, the
  keyring or Jev. No credential appears in the catalog, the plugin manifest or the
  package.
- **Where Jev and credentials run.** Never inside a hook. A hook only records evidence
  and leaves a handoff; a detached worker process reads the credential (`jevguard login`
  and the OS credential store; `TYPESAFE_API_KEY` only as a CI override), calls Jev, and
  exits. The hook bundle does not contain the keyring, the Jev client, or any network
  code.
- **Sensitive handoffs.** A handoff holds the unit's prompt and patch, so it is local
  only, created at mode `0600` in a `0700` directory under `${CLAUDE_PLUGIN_DATA}`,
  deleted after its review is recorded, and removed after 24 hours if never consumed.
  A handoff whose deletion fails is retried and logged as a code, never silently kept.
- **No-read first.** Every path is checked against the file safety policy before any
  byte is read. A blocked path, a link, or non-text content makes the unit
  `UNAVAILABLE`; the content is never read, stored, or exported.
- **Evidence limits.** Files ignored by Git are outside shell-write evidence. A
  process that rewrites an attributed file and restores the exact attributed bytes
  before the unit closes is undetectable. Writers outside the attributed files are not
  part of the evidence.
- **Shell diff limits.** The Git diff around a shell call is bounded in dirty entries,
  hashed or read bytes, index reads, Git output and time. File sizes are checked with
  `stat` before anything is hashed or read, blocked paths are still never hashed or
  read, nothing is written to the repository, and a Git timeout or full output buffer
  is never treated as an absent file. An exceeded limit makes the unit `UNAVAILABLE`;
  the hook log keeps only the closed code `SHELL_DIFF_LIMIT:<limit>`.
- **Logs.** The hook and worker logs hold only closed codes (for example
  `REVIEW_RECORDED:PASS`), never prompts, patches, paths, findings, session ids, or
  credentials.
- **History.** Claude Code reviews are appended to the same local
  `reviews.jsonl` as OpenCode ones, identified by a `claude-code:` turn id. The history
  is owner-only: the file is created with mode `0600` and its directory with `0700` on
  POSIX, and the user-profile ACL applies on Windows. A `reviews.jsonl` created by an
  earlier version keeps its old mode until it is rotated or deleted; delete it or
  `chmod 600` it to tighten it now.
- **In-session presentation.** The bundled UI module (`hooks/jevguard-ui.js`) uses
  only `$.session.id`, `$.session.model`, `$.env.get`, `$.fs.read`, `$.fs.write`,
  `$.clock.now`, `$.clock.every`, `$.clock.after`, `$.state.get`, `$.state.set`,
  `$.ui.log`, `$.ui.status`, `$.ui.toast`, `$.ui.open`, `$.ui.close`, `$.ui.copy`,
  `$.ui.resolve`, `$.model.complete` and `$.prompt.submit`. It never appends to the
  session, runs a command or tool, calls the network or a process, or writes the
  environment, and it contains no Jev client or credential. `$.fs.write` only blanks a
  consumed proposal request, `$.model.complete` runs only for a request the worker wrote
  after the user's opt-in, and `$.prompt.submit` runs only for `delivery: agent`. It
  reads only the feed and the proposal requests below.
- **Feed.** The worker writes one feed file per session under the user data
  directory. It holds ids, outcomes, violation probabilities, typed reason and cause
  codes, counts and slice counts; no task, patch, path, finding or credential. The
  file name is the session id. Under `claude -p` or the SDK, the lines reach the host
  as `ui_log` messages.
- **Proposal requests (sensitive).** When the user enabled remediation and a review
  has a `FAIL` with complete safe evidence, the worker writes the core's proposal request
  (task, attributed patch and findings, the same text the OpenCode proposer receives) to
  `proposals/<sessionId>/` under the user data directory, mode `0600` in a `0700`
  directory, with a 24 hour expiry. The mod reads it once, overwrites it with an empty
  string because `$.fs` cannot delete, validates it strictly (exact keys, bounded
  sizes, Claude model alias or id, this unit only, not created in the future and not
  valid for longer than 24 hours) and makes one `$.model.complete` call without retry,
  using the session's model unless the user pinned one. If the file cannot be blanked,
  the module fails with `REQUEST_UNREADABLE` and does not call the model. Residual risk:
  reading and blanking are two steps, not one atomic rename, because `$.fs` has no
  rename or delete, so two instances of the module reading the same request at the same
  instant could both consume it. The worker never writes a request inside the project
  root or its Git working tree (the write fails with
  `PROPOSAL_REQUEST_WRITE_FAILED`), and removes the request if the feed line that
  announces it could not be written. The worker
  removes blank files and files older than 24 hours each time it runs, which is at every
  session start and every closed unit; if Claude Code stays closed for days, an
  unconsumed file can remain on disk past 24 hours, and the mod refuses it by its
  expiry. Logs and toasts carry one typed code (for example `MODEL_API_ERROR`), never
  the task, patch, findings, paths or credentials. The model call is the user's own
  Claude Code session and sends this evidence to that session's provider.
- **Where opt-in lives.** Only in the user's file
  `<XDG_CONFIG_HOME | USERPROFILE | HOME/.config>/jevguard/claude-code.yaml`, read by the
  worker. The file is refused when its real path is inside the project root or inside
  the Git working tree that contains it (the nearest ancestor with a `.git` entry), on
  every platform and without regard to letter case, because a cloned repository's
  `.claude/settings.json` can change `XDG_CONFIG_HOME` through `env`. The content is
  read through that same canonical path. A project inside a Git repository that also
  contains the user's config directory (for example a dotfiles repository at the home
  directory) is refused as well; that is the safe side.
  Residual risk: a project setting that points `HOME` or `XDG_CONFIG_HOME` to a
  directory outside the repository that the attacker also controls is not detected.
  `.jev/config.yaml` can only veto (`remediation.auto_propose: false`); its `model` is
  ignored on Claude Code.
- **Agent delivery (opt-in exception).** With `delivery: agent` the mod submits the
  proposal to the agent with `$.prompt.submit`, never as the user. The agent receives a
  framed message that says it was sent by the plugin and was not typed by the user,
  followed by the strategy-only proposal text (no tools, no code, no diff). The message is
  visible in the transcript. It opens with a fixed marker: the worker detects the marker
  in the next unit's task and downgrades that unit to the user panel, so at most one
  automatic delivery follows a unit the user started, and at most 3 happen per session
  (a fixed limit). The count is kept per session in the plugin state, so it survives a
  reload of the module and a `/resume`; only the last 32 sessions are remembered. The
  model's text is stripped of control characters (tabs and newlines stay), capped at
  32768 characters, and placed between `--- proposal start ---` and
  `--- proposal end ---` lines after the fixed notice, with any such line inside it
  removed, so it cannot pass for the notice or for the user. The resulting turn is
  reviewed normally. There is no apply path,
  retry or forced re-evaluation.
- **Native dependency.** The only external runtime dependency is `@napi-rs/keyring`,
  pinned and installed with `--ignore-scripts`; its per-platform binaries are optional
  dependencies with no install script. If it is missing, reviews degrade to
  `UNAVAILABLE` and nothing else is affected.
