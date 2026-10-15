# Configuration Reference

JevGuard reads repository policy from `.jev/`:

```text
.jev/
├── rules.md       required to evaluate a turn
└── config.yaml    optional; absent means defaults
```

Both files are read once per attributed turn. A missing `.jev/rules.md` is not a
pass: the review becomes `UNAVAILABLE`.

Editing policy content needs no restart: the next attributed turn reads the current
files. Discovery of the plugin and its bundled `jevguard-rules` and `jev-init` skills,
by contrast, happens at OpenCode startup; restart OpenCode after installing or
updating the package. `jev-init` bootstraps both files only when neither exists;
afterward, `jevguard-rules` authors rules. Each skill's bundled validator reads only
the candidate policy files and reports safe counts, rule IDs, and parser error codes;
`jevguard-rules` never edits `.jev/config.yaml`, and `jev-init` writes it only as part
of a confirmed greenfield bootstrap.

## `rules.md`

Rules are Markdown so they can be authored, reviewed, and versioned alongside the
codebase. One document may declare any number of rules, and every rule block is
evaluated.

```md
## ARCH-001

severity: error
scope: backend/**
scope: !backend/generated/**
evidence: code

### Rule

HTTP controllers must not contain business logic.

### Violation

A controller performs domain decisions, calculations, or state mutations directly.

### Allowed

Validation, HTTP mapping and delegation to services.

## TEST-001

severity: warning

### Rule

Behavior changes must arrive with tests.

### Violation

A behavior change has no corresponding test change.
```

### Document grammar

The parser is line-based and strict:

- The document is split into blocks at each `##` heading, in source order. A `##`
  heading is a rule heading only when followed by whitespace; `###` headings are
  sections. A block runs to the next `##` heading, and content before the first
  heading is ignored. A document with no `##` heading yields a single `MISSING_ID`
  failure.
- Each block is validated independently, so one invalid block does not suppress its
  valid siblings.
- The rule ID is the trimmed heading text and must match
  `[A-Za-z0-9][A-Za-z0-9._-]*`.
- IDs are compared across the whole document. When a valid ID appears more than
  once, every block with that ID is invalid (`DUPLICATE_ID`); blocks with other IDs
  are unaffected.
- Everything between a block's `##` heading and its first `###` heading is
  metadata. Blank lines are ignored. Any non-blank line must match `key: value`,
  and only `severity`, `scope`, and `evidence` are accepted. An unknown key, a
  duplicate of any key other than `scope`, or a line without `:` is invalid.
- `severity` is required and must be exactly `error` or `warning`.
- `scope` is optional and may repeat. Each `scope:` line adds one pattern: a
  leading `!` marks an exclusion, and every other pattern is an inclusion. A
  changed path is in scope when it matches at least one inclusion and no
  exclusion. A block that declares `scope` but has no inclusion — for example only
  `!`-exclusions — is invalid, and an empty `scope:` value is invalid. Each
  pattern is a glob where `*` matches within a path segment, `**` matches across
  segments, and `?` matches one non-separator character. Both `/` and `\`
  separators are normalized before matching. When `scope` is absent, every changed
  file in the turn is in scope. A single `scope: src/**` behaves exactly as before.
- `evidence` is optional and must be exactly `code`, `docs`, or `any`. It selects
  the extension class a rule's applicable files may draw from: `code` (the
  default) sends source, config, and data formats; `docs` sends prose
  documentation only (`.md`, `.mdx`, `.txt`); `any` sends both. Because the
  default is `code`, prose documentation no longer participates in a rule's
  evidence unless the rule opts in with `docs` or `any` — an intentional change so
  a code rule is not pulled into review by a documentation change alone. Config
  and data formats (for example `.json`, `.yaml`, `.yml`, `.toml`, `.xml`, `.csv`,
  `.tsv`) stay in the `code` class, so config rules keep their coverage.
- Section content is everything after a `###` heading until the next `###`
  heading, trimmed. Sections may appear in any order.

### Sections

| Section | Required | Requirement |
| --- | --- | --- |
| `### Rule` | Yes | Non-empty normative policy. |
| `### Violation` | Yes | Non-empty condition that breaches the policy. |
| `### Allowed` | No | Non-empty normative exception; must differ from `Violation`. |

Any other `###` heading is invalid. A repeated section is invalid. An empty
`Rule` or `Violation`, or an `Allowed` that is empty or identical to
`Violation`, is invalid.

A block is invalid when its rule ID is invalid or duplicated, its metadata is
malformed or duplicated, its `severity` is missing or invalid, its `scope` is
malformed (empty, or declared without an inclusion), its `evidence` is unknown, a
section is unknown or duplicated, or a required section is missing or empty. An
invalid block becomes a per-rule `UNAVAILABLE` result with reason `INVALID_RULE`;
Jev is never called for that block, and its valid siblings are still evaluated.

### Provenance preamble

A `.jev/rules.md` bootstrapped by `jev-init` begins with a fenced `yaml` manifest that
records where each rule came from. It sits before the first `##` rule heading, so the
parser ignores it, and it never carries policy:

```yaml
rules:
  ARCH-001:
    source: user
  LANG-002:
    source: inferred
    evidence:
      - AGENTS.md
      - package.json
```

Every valid rule has exactly one entry and every entry maps to a valid rule. `source`
is `user` or `inferred`; an `inferred` rule requires at least two safe
repository-relative POSIX evidence paths and `warning` severity. The bundled validator
enforces those two mechanical conditions and rejects `.git`, absolute, traversal, and
denied-secret evidence references; the skill's semantic bar — a normative document plus
independent agreeing evidence — is not machine-checkable. Provenance is authoring
metadata, not runtime policy: it does not change how any rule is evaluated. When
`jevguard-rules` later replaces the rules, it preserves this preamble and records the
rules the user requested as `source: user`.

### Scope behavior

Scope is evaluated per rule against the same attributed turn. A valid rule is
evaluated only when at least one changed file is both in scope and in the rule's
`evidence` class. A path is in scope when it matches at least one `scope:`
inclusion and no exclusion. When no attributed file qualifies, that rule is
`SKIPPED` with reason `NO_SCOPE_MATCH` and Jev is never called for it.

`Allowed` belongs to the same violation judgment. It is sent in the same Noul
criteria as `Rule` and `Violation`; it never creates a second model call or a
separate advisory exception.

## Built-in checks

Alongside the repository rules, JevGuard runs product-owned built-in checks with
their own fixed policy. They are not declared in `.jev/rules.md` and are not
configured by `.jev/config.yaml`.

`SCOPE-CREEP` and `COMPLEXITY` are the implemented built-ins. Each receives the
turn's complete, safe attributed patch with no scope filtering.

`SCOPE-CREEP` asks whether the attributed change contains material functional,
behavioral, architectural, dependency, configuration, documentation, or refactoring
work the task did not request and that is not reasonably necessary to complete it. It
always uses fixed `error` thresholds — warn at `0.65`, fail at `0.90` — so
`.jev/config.yaml` cannot change its outcome.

`COMPLEXITY` asks whether the attributed change introduces material complexity that is
disproportionate to, or not reasonably necessary for, completing the task: unnecessary
abstractions, layers or indirections without proportional gain, new dependencies
without a clear need, excessive configuration, premature generalization, or structure
materially larger than the problem requires. It always uses a fixed advisory threshold
— warn at `0.50` — and can never fail, so `.jev/config.yaml` cannot change its outcome
or turn it into a failure.

The rule lane and the built-in batch run concurrently. The batch selects the turn's
complete, safe attributed patch once and sends `SCOPE-CREEP` and `COMPLEXITY` as two
independent named answers in **one** Jev request. A single shared FIFO concurrency
limit caps in-flight Jev requests at two across the plugin instance, counting the
batch as one request, so completion timing never changes the result order. Results are
always the rules in source order, then `SCOPE-CREEP`, then `COMPLEXITY`.

Each batch answer is validated on its own. A malformed, missing, or out-of-range
answer makes only that check `UNAVAILABLE`; the valid sibling still gates. A request
that fails at the envelope level makes both checks `UNAVAILABLE` (`JEV_FAILURE`).

A built-in has no rule scope. No attributed patch makes both `SKIPPED`
(`NO_ATTRIBUTED_PATCH`), and blocked or oversized evidence makes both `UNAVAILABLE`
(`BLOCKED_EVIDENCE` or `OVERSIZED_DIFF`). A rule, policy-load, or config failure never
suppresses the batch: when `.jev/rules.md` is missing or `.jev/config.yaml` is
invalid, the rule lane degrades while the batch still runs. One built-in's answer never
suppresses the other. Built-ins are observe-only; their verdicts affect the aggregate
outcome but never block a turn.

## `config.yaml`

Configuration is optional. A missing file uses the defaults below. A present file
is parsed as strict YAML: multiple documents, duplicate keys, anchors, aliases,
and explicit tags are rejected.

```yaml
version: 1

thresholds:
  error:
    warn: 0.40
    fail: 0.70
  warning:
    warn: 0.60

remediation:
  auto_propose: true
  propose_on:
    - FAIL
  # model is optional; when absent the proposer inherits the host model.
  # model: provider/model
```

Validation rules:

- `version` must be exactly `1`.
- `thresholds.error.warn`, `thresholds.error.fail`, and `thresholds.warning.warn`
  must be numbers in `[0, 1]`.
- `thresholds.error.warn` must be strictly less than `thresholds.error.fail`.
- `remediation` is optional. When absent, the defaults shown above apply.
- `remediation.auto_propose` must be a boolean.
- `remediation.propose_on` must be a non-empty list whose only accepted value is
  `FAIL`.
- `remediation.model` is optional. When absent, the proposer inherits the host's
  model. When present it must be exactly one non-empty provider and one non-empty
  model separated by `/` (`provider/model`), with no whitespace and no additional
  `/`.
- Any other key inside `remediation` is invalid.

A present but invalid configuration — including an invalid `remediation` section — is
`INVALID_CONFIG` and makes the review `UNAVAILABLE`. JevGuard never guesses which
thresholds or remediation policy you intended.

### Thresholds

| Severity | PASS | WARN | FAIL |
| --- | ---: | ---: | ---: |
| `error` | below `warn` | `warn` through below `fail` | `fail` and above |
| `warning` | below `warn` | `warn` and above | never |

Defaults: `error` warns at `0.40` and fails at `0.70`; `warning` warns at `0.60`
and never fails.

These thresholds apply to repository rules only. The `SCOPE-CREEP` built-in always
uses its fixed `error` thresholds (`0.65`/`0.90`), and `COMPLEXITY` always uses its
fixed `warning` threshold (`0.50`) and never fails, even when the configuration is
absent or invalid.

## Evidence

The evidence policy is fixed in core, not read from `.jev/`. For each rule it
assembles a diff only from that rule's applicable files, caps every rendered slice at
`100000` characters, sends only common code and text extensions, and rejects sensitive
names, extensions, and directories. A scoped diff at or below the cap is one whole
slice; a larger diff is split, in attributed file order, into one slice per file, and
an individually oversized file is split into its ordered unified-diff hunks with the
file preamble repeated in every slice. A slice exactly at the cap is valid; nothing is
truncated, summarized, or dropped. A blocked applicable path still makes the whole rule
`UNAVAILABLE/BLOCKED_EVIDENCE` with no slice sent, and an unparseable oversized file or
an indivisible oversized hunk makes the whole rule `UNAVAILABLE/OVERSIZED_DIFF`. A
rule may produce at most 16 slices, and slicing may add at most 32 repository-rule Jev
calls per turn beyond one per applicable rule, reserved in policy source order; a rule
that does not fit is `UNAVAILABLE/SLICE_LIMIT_EXCEEDED` with no Jev call, and later
rules still use the remaining budget. Every problem is scoped to the affected matching
rule (never a partial judgment for that rule); rules whose applicable files are all
safe still run.

The extension allowlist is split into a code/data class and a prose-docs class, and
a rule's `evidence:` key selects which class it evaluates; the default `code`
excludes prose documentation. The built-ins use the full allowlist (both classes)
over every attributed file with a nonempty patch, with no scope filtering. An
oversized or blocked file makes a built-in `UNAVAILABLE`, never partially evaluated.
See the [security model](./security.md) for the defaults.

## Outcomes

Outcomes are per result: a repository rule or one of the built-ins.

| Outcome | Meaning |
| --- | --- |
| `PASS` | Applicable result evaluated and stayed below its warning threshold. |
| `WARN` | Applicable result evaluated and reached its warning threshold. |
| `FAIL` | An `error`-severity result evaluated at or above its failure threshold. `COMPLEXITY` is advisory and can never reach this outcome. |
| `SKIPPED` | No attributed patch (`NO_ATTRIBUTED_PATCH`), or no file matched the rule scope (`NO_SCOPE_MATCH`; rules only). |
| `UNAVAILABLE` | That result's evaluation could not safely or completely happen. |

`UNAVAILABLE` reasons: `INVALID_RULE`, `INVALID_CONFIG`, `MISSING_ATTRIBUTED_DIFF`,
`OVERSIZED_DIFF`, `BLOCKED_EVIDENCE`, `SLICE_LIMIT_EXCEEDED`, and `JEV_FAILURE`. A
built-in result can only carry `OVERSIZED_DIFF`, `BLOCKED_EVIDENCE`, or `JEV_FAILURE`.
`SKIPPED` and `UNAVAILABLE` are operational states, never semantic verdicts.

A repository rule evaluated from several slices aggregates deterministically: each
slice is gated on its own, the rule outcome is the highest slice outcome
(`FAIL > WARN > PASS`), and the rule's `violationProbability` is the maximum across its
slices. `PASS` requires every planned slice to pass and is never inferred from missing
work. Any failed, blocked, oversized, over-budget, or out-of-range slice makes the whole
rule `UNAVAILABLE`, and no successfully evaluated sibling probability is presented as a
partial verdict. The result records `evidenceMode` (`WHOLE`/`SLICED`), planned and
evaluated/failed/not-evaluated slice counts, ordered slice summaries, and per-slice
probabilities and gate outcomes for a complete result, without any diff content. The
built-ins never slice.

Not every `UNAVAILABLE` is a policy-rule result. A failure before any rule is
evaluated is reported by the rule lane as one synthetic aggregate entry with
`ruleId: null`, `severity: null`, and empty `scopedPaths`, rather than replicated
once per declared rule. When the attributed diff itself cannot be built
(`MISSING_ATTRIBUTED_DIFF`), that synthetic entry is the whole review. When the turn
is attributed but the policy files are unreadable or invalid
(`INVALID_RULE`/`INVALID_CONFIG`) or `.jev/rules.md` is missing (`INVALID_RULE`),
the synthetic entry covers the rule lane and both built-ins still add their own
results. The aggregate counts include every entry.

## Presentation

Each turn produces exactly one transient TUI toast and one structured log entry for
the whole review. Review runs in the background: the idle event returns as soon as the
serialized attribution step is scheduled, so policy reads, Jev requests, and
presentation are never on the agent's critical path.

- Toast: `JevGuard <OUTCOME>` where `<OUTCOME>` is the aggregate display outcome.
  The display precedence is `FAIL > UNAVAILABLE > WARN > PASS > SKIPPED`: any
  `FAIL` shows `FAIL`, otherwise any `UNAVAILABLE` shows `UNAVAILABLE`, and so on
  down to a review where every rule is `SKIPPED`. The message is a count summary
  such as `pass 1 · warn 1 · fail 1 · skipped 0 · unavailable 0`; when any rule was
  sliced it appends `· sliced <n> rules · slices <m>`. `PASS`/`WARN`/`FAIL` use
  `success`/`warning`/`error` variants; `SKIPPED` uses `info`; `UNAVAILABLE` uses
  `error`. Toasts last 5 seconds.
- Log: one entry with service `jevguard`. Its level follows the same aggregate
  display outcome: `info` for `PASS`/`SKIPPED`, `warn` for `WARN`, and `error` for
  `FAIL`/`UNAVAILABLE`. The entry carries the turn ID, the aggregate summary
  (highest verdict, whether any result was unavailable, and per-outcome counts), and
  the full result list. Each result carries its identity — `ruleId` for a rule or
  `checkId` for a built-in — its severity, scoped paths, and either the raw
  violation probability or the typed reason. A sliced rule result also carries its
  slice metadata: `evidenceMode`, planned and evaluated/failed/not-evaluated counts,
  ordered slice summaries (index, path, `FILE`/`HUNK`, hunk ordinal), and per-slice
  probabilities and gate outcomes for a complete result. The log never carries diff
  content. Results have a fixed order: the rules in source order, then the
  `SCOPE-CREEP` built-in, then the `COMPLEXITY` built-in. A review-level failure
  contributes its single synthetic entry (null rule ID and severity). All of them are
  included in the counts.

The toast is intentionally compact and never includes probabilities or paths. A
generic count summary does not mean every rule was evaluated: an `UNAVAILABLE`
result is a missing judgment, and it does not erase a known `FAIL` elsewhere in the
turn.

By default, OpenCode sees only these transient toasts and logs. The review itself
does not inject messages into the agent context, does not modify the source session,
and does not block a turn. A separate, configurable workflow can turn a review that
contains a `FAIL` into a proposal, as described below.

### Local review history

Every review is also appended to a bounded local history at
`~/.local/share/jevguard/reviews.jsonl`, or at
`<XDG_DATA_HOME>/jevguard/reviews.jsonl` when `XDG_DATA_HOME` is a non-empty absolute
path (a relative `XDG_DATA_HOME` is ignored). It stores only the structured-log
allowlist plus a timestamp, is local-only, rewrites itself once it passes 5 MB keeping
the newest records, and is safe to delete at any time. `jevguard report` and
`jevguard report --json` aggregate it into outcome totals, reason breakdowns,
per-rule counts, and slice coverage; a missing or empty file is a normal empty report.
See the [security model](./security.md) for exactly what it stores.

## CLI diagnostics and on-demand rule checks

Two CLI commands work from the terminal, outside any agent turn. Both resolve the
project root as the first ancestor of the current directory that contains `.git` (a
file or a directory), or the current directory when none does.

### `jevguard doctor [--json]`

A local diagnosis: no network, no Jev transport, no writes. Checks, in order:

| Check | Codes |
| --- | --- |
| `credential` | `CREDENTIAL_STORE`, `CREDENTIAL_ENVIRONMENT`, `MISSING_CREDENTIAL`, `STORE_READ_FAILURE` |
| `rules` | `RULES_VALID`, `RULES_INVALID`, `RULES_MISSING`, `RULES_READ_FAILURE`, `RULES_NOT_CHECKED` |
| `config` | `CONFIG_DEFAULTS`, `CONFIG_VALID`, `CONFIG_PARSE_INVALID`, `CONFIG_INVALID`, `REMEDIATION_INVALID`, `CONFIG_READ_FAILURE`, `CONFIG_NOT_CHECKED` |
| `opencode-plugin` | `REGISTERED`, `NOT_REGISTERED`, `INSPECTION_FAILED` |

A missing credential, missing or invalid rules, and an invalid or unreadable config
are `FAIL`. An unregistered or uninspectable OpenCode plugin is `WARN`, and so is a
check skipped because the other policy file could not be read. The overall status is
the worst check. The OpenCode check inspects the global `opencode.json` and the
`opencode.json` in the current directory, and passes when either registers the plugin.
Claude Code installs are not diagnosed yet.

Exit codes: `0` when no check is `FAIL` (warnings included), `1` when any check is
`FAIL`, and `1` with the usage text for invalid arguments.

`--json` prints `{ "version": 1, "projectRoot", "status", "checks": [...] }`. The
report carries statuses, codes, rule IDs and file paths only. It never carries the API
key or any part of it, rule text, or file contents.

### `jevguard rules check --diff <file|-> [--task <text>] [--rule <id>] [--json]`

Runs the repository rules over a unified diff:

- `--diff <file>` reads a diff file; `--diff -` reads standard input (a terminal is
  refused). Input is limited to 16 MiB and must be valid UTF-8. It must be `git diff`
  output (or a plain `---`/`+++` unified diff) with `a/` and `b/` path prefixes.
- `--task <text>` is the task Jev judges the change against. Without it, the fixed task
  "No task was provided. Judge the change against the rule on its own." is sent. The
  task appears in the process list, so it is not a place for secrets.
- `--rule <id>` evaluates only that rule. The filter applies before Jev and before the
  per-turn slice budget, so only the selected rule counts against the budget.
- `--json` prints `{ "version": 1, ...}` with the same allowlist projection as the
  structured log and the review history.

It uses the normal credential and, once the diff is accepted, applies the same scope
filtering, evidence policy (a denylisted or non-allowlisted scoped file makes the rule
`UNAVAILABLE` with `BLOCKED_EVIDENCE`), sliced evidence for large diffs and no partial
results as a review. A diff with no files, or no file in a rule's scope, is `SKIPPED` without
calling Jev. It runs no built-in checks, starts no remediation and records nothing in
the review history. The output lists each rule's outcome, probability, severity and
scoped paths or its typed reason, never the task or the diff.

The diff parser is strict. Anything it does not fully understand makes the command
refuse the whole diff (exit `2`, nothing sent to Jev) rather than evaluate part of it.
The refused cases, with their typed reason codes, are:

- `UNRECOGNIZED_DIFF`: text that is not git diff output, a preamble before the first
  `diff --git` line (`git log -p`, format-patch headers or a `-- ` signature), trailing
  content after a complete hunk, a malformed hunk header, or `---`/`+++` paths that
  disagree with the `diff --git` header.
- `COMBINED_DIFF`: `diff --cc` or `diff --combined` (merge diffs).
- `RENAMED_PATH`: a rename or copy that carries content changes. A pure rename or
  mode change without content is ignored.
- `UNSUPPORTED_PREFIX`: paths without `a/` and `b/` prefixes, such as `--no-prefix` or
  `diff.mnemonicPrefix` output. Run `git -c diff.mnemonicPrefix=false diff` instead.
- `TRUNCATED_HUNK`: a hunk that ends before its line counts, or a file header without
  hunks.
- `BINARY_PATCH`, `QUOTED_PATH` (git quotes unusual names) and `MISSING_PATH`.
- `DIFF_NOT_UTF8`: the input is not valid UTF-8.

Exit codes: `0` when it completed with no `FAIL` and no `UNAVAILABLE`; `1` when any
rule `FAIL`ed (even alongside `UNAVAILABLE`); `2` when it could not check completely —
invalid arguments, an unreadable or unsupported diff, a `--rule` that matches nothing,
or an `UNAVAILABLE` result with no `FAIL`. Errors are always plain text on standard
error, also with `--json`.

## Safe auto-propose remediation

This section describes the OpenCode behavior. Claude Code has its own opt-in; see
[Remediation proposals](#remediation-proposals) under Claude Code.

The review remains observe-only unless remediation is enabled, and the server plugin
delivers it inside the same plugin entrypoint. Remediation is controlled by
`remediation.auto_propose` (default `true`) and `remediation.propose_on` (default
`FAIL`). After presenting a review that contains any `FAIL`, the plugin sends one
aggregate proposal request to a hidden `jevguard-proposer` subagent and shows a
generic toast. It never edits code and never applies a change.

The request aggregates every `FAIL` finding in the review — local `error`-severity
repository rules and the `SCOPE-CREEP` built-in — together with the turn's task and its
complete, safe, full attributed patch. `COMPLEXITY` is advisory and never fails, and
`warning` rules never fail, so neither triggers a proposal. The patch is the same
complete attributed patch the review uses; there is no repository or global diff
fallback.

The full attributed patch must pass the safety policy. If any attributed file is
blocked or the patch is oversized, the plugin records no proposal at all — even when a
rule-scoped `FAIL` exists — because there is no complete safe evidence to send. The
task is capped at `16384` characters; a longer task records no proposal rather than
truncating evidence.

The plugin `config` hook registers the hidden `jevguard-proposer` subagent with
wildcard-disabled tools and wildcard-deny permissions (`{"*": "deny"}`), so it cannot
call a tool, edit a file, or produce a patch. The proposal is sent in an isolated child
session parented to the source session. When `remediation.model` is present it selects
the proposer model; when it is absent the proposer inherits the host's model. The child
session is excluded from review for the plugin lifetime, so a proposal can never
recurse or trigger a second one. The generic toast carries no rule, task, diff, finding,
or credential.

A contained proposal failure — an invalid model specifier, a child-session creation
failure, or a prompt failure — surfaces a generic error toast and one structured
`error` log entry whose `extra` carries only a typed reason code
(`MODEL_SPECIFIER_INVALID`, `CHILD_SESSION_FAILED`, or `PROPOSAL_PROMPT_FAILED`).
Neither carries any task, diff, rule, finding, path, or credential.

At most one proposal is created per evaluated turn. There is no retry, loop, or
re-evaluation, and no automatic apply. The user reads the proposal, copies its manual
apply instruction into their normal coding agent, and applies it there. That apply is
an ordinary completed assistant turn, so the server plugin reviews it normally on the
next idle, exactly like any other turn. No secret is carried, and no payload, task,
diff, or secret is logged.

## Claude Code

JevGuard also reviews work done in Claude Code through a separate plugin. It is
background and observe-only like the OpenCode plugin: it never changes what Claude
sees, never prompts, blocks, or edits, unless you opt in to `delivery: agent` under
[Remediation proposals](#remediation-proposals). Each reviewed unit is recorded in the
[local review history](#local-review-history), which `jevguard report` reads, and its
result is also shown to you only, inside the session (see
[In-session results](#in-session-results)). Remediation proposals are off by default and
strategy-only; see [Remediation proposals](#remediation-proposals).

### Install

The plugin is a directory built from this repository with
`bun packages/claude-code-plugin/scripts/build-artifact.ts` (output:
`packages/claude-code-plugin/dist/`). For local testing, load that directory directly:

```sh
cd packages/claude-code-plugin/dist
npm ci --omit=dev
claude --plugin-dir <absolute path to that dist directory>
```

`npm ci --omit=dev` installs the one native dependency, `@napi-rs/keyring`, which
reads the credential. Claude Code does not install dependencies for a directory
loaded with `--plugin-dir`; a plugin copied into its cache from a marketplace gets an
automatic `npm install` when the plugin ships a lockfile, which this one does. How the
plugin will be distributed is an open decision and is not published.

Requirements:

- `node` on `PATH`, version 22.13 or newer. The hook and the review worker run with
  `node`. Claude Code's native installer does not necessarily provide Node. Without
  Node the hook cannot run, so nothing is reviewed and the Claude Code session is
  unaffected.
- A credential from `jevguard login` (stored in the OS credential store). In CI, set
  `TYPESAFE_API_KEY` in the process environment. Without a credential, or without the
  keyring binary, a review is recorded as `UNAVAILABLE` (`JEV_FAILURE`); the hook is
  never affected.
- Rules in `.jev/rules.md` and optional `.jev/config.yaml`, exactly as for OpenCode.

### What is reviewed

Claude Code does not expose a complete, attributed historical diff, so the plugin
reviews a smaller set of work that it can prove:

- **Unit of work.** A unit opens at the first user prompt after the previous unit
  closed and closes at the first main `Stop` with no active background tasks. It may
  contain several prompts, and all of them are the task. Delegated subagents and
  background subagents count as part of the unit. Work interrupted without a closing
  `Stop` is not reviewed.
- **Evidence.** Only files named by `Write`, `Edit`, `MultiEdit`, and `NotebookEdit`
  calls (including those of subagents), plus files a shell command changed. The patch
  is each file's net change from its state before the unit to its final state. No
  repository-wide diff is ever used.
- **Shell.** Each foreground shell call (Bash or PowerShell) is bracketed by a
  read-only Git status diff. A Git-ignored file written by a shell command is outside
  the evidence, by design. Set `JEVGUARD_CLAUDE_SHELL_GIT_DIFF=0` to turn this
  capture off; shell calls then make the unit `UNAVAILABLE`.
  The diff has fixed limits per hook call: 2000 dirty entries, 16 MiB of hashed or read
  content, 40 index reads (two per clean file a command changes), 16 MiB of Git output,
  2 s per Git call and 3 s in total. These values are not configurable. When any limit is exceeded the
  unit is `UNAVAILABLE` (`SHELL_DIFF_LIMIT_EXCEEDED`) and is never reviewed with
  partial evidence, so a very large or heavily dirty repository can make units with
  shell calls unreviewable.
- **Refused evidence.** A blocked path (see the [security model](./security.md)), a
  link, a file that is not UTF-8 text without NUL, or a file over 1 MiB makes the unit
  `UNAVAILABLE`, and its content is never read or stored.
- **Not provable.** A shell call in the background, a file already modified before the
  unit that a shell call then changed, an MCP or unknown tool that may write, a prompt
  that is not text, or a write by a process that is not attributed to the unit all make
  the unit `UNAVAILABLE`. A unit with no changed file and no write-capable tool is
  `SKIPPED` without calling Jev.

### In-session results

A small user-interface module bundled with the plugin (`hooks/jevguard-ui.js`) shows
the result of each reviewed unit in the Claude Code session. It is presentation only:
it reads a small local feed, never calls Jev, never reads a credential, and adds
nothing to the conversation the model sees. There is no slash command, because a
command result is also read by the model.

- While a unit is reviewed the status line shows `JevGuard reviewing unit N...`.
- A faint transcript line (not sent to the model) shows the outcome, the rules that
  failed or warned with the violation probability, typed reasons, and acquisition
  causes. `SKIPPED` units only update the status line.
- A `FAIL` also raises a toast naming the failing rule or check ids.
- The status line keeps the latest result.

Examples:

```text
JevGuard PASS · unit 2 · pass 3 · skipped 1
JevGuard WARN · unit 3 · warn: TEST-001 47% · pass 3
JevGuard FAIL · unit 4 · fail: ARCH-001 91% · warn: SCOPE-CREEP 52% · pass 2
JevGuard UNAVAILABLE · unit 5 · unavailable: review MISSING_ATTRIBUTED_DIFF (SHELL_BACKGROUND)
JevGuard UNAVAILABLE · unit 6 · unavailable: ARCH-001 JEV_FAILURE, COMPLEXITY JEV_FAILURE
```

The text is English only and carries ids, percentages, counts and closed codes, never
file paths, rule text or findings. Jev returns a probability, not prose, so there is
no explanation beyond the typed reason. At most five ids are listed per group, then
`+N more`.

After each main-loop turn the module polls the feed every 2 seconds for 45 seconds,
extended while a review is pending (up to 150 seconds per review, at most 15 minutes
in total). A review that finishes after that, or one that started more than 150
seconds before the session was reloaded, is not shown; it is still in
`jevguard report`, which remains the complete record. The
terminal and desktop surfaces draw these lines; `claude -p` ends before a review
finishes.

### Remediation proposals

Remediation is off. You turn it on in your own file, never in the repository:

```yaml
# <XDG_CONFIG_HOME | USERPROFILE | HOME/.config>/jevguard/claude-code.yaml
remediation:
  enabled: true      # default false
  delivery: user     # user | agent
  model: sonnet      # optional; Claude alias or id; default: the session's model
```

The file is read by the worker. `XDG_CONFIG_HOME` is used only when it is an absolute
path; otherwise `USERPROFILE` and then `HOME` plus `.config`. It is refused when its
real path is inside the project root or inside the Git working tree that contains it
(letter case never matters). It is validated strictly: an unknown key, a wrong
type, a `delivery` other than `user` or `agent`, or a `model` that is not a Claude alias
or id (a `provider/model` specifier is invalid) makes the whole file invalid, and nothing
is proposed. The worker log then holds one closed code:
`REMEDIATION_USER_CONFIG_INVALID`, `REMEDIATION_USER_CONFIG_IN_PROJECT` or
`REMEDIATION_USER_CONFIG_UNREADABLE`.

When a review of a unit has a `FAIL` with complete safe evidence, the worker builds the
same aggregate request as the OpenCode proposer (every `FAIL` finding, the task, the
complete attributed patch; same limits) and the in-session module drafts a strategy with
one call to the model, using the session's model unless you set `model`. It never edits
code and never applies anything; there is no retry. The result is shown as follows.

- **`delivery: user` (default).** A panel titled `JevGuard proposal` shows the strategy
  and a button that copies the manual apply instruction; a toast announces it. The panel
  and its text are not sent to the model. Where the terminal is narrower than 144 columns
  the panel cannot be placed without your action, so the proposal is also written to the
  transcript as faint lines of at most 1900 characters.
- **`delivery: agent` (explicit opt-in).** The module also submits the proposal to the
  agent as a visible message from the plugin (never as if you typed it), which starts a
  turn once the session is idle. At most one such message follows a unit you started, at
  most 3 are sent per session (the count survives a reload and a `/resume`), and the
  turn they cause is reviewed normally but never triggers another. The fourth delivery in
  a session is shown in the panel instead, with a line saying the limit was reached. The
  panel opens as a record of what was sent. The proposal text is shown without control
  characters and capped at 32768 characters.

A failure shows a generic toast and one transcript line with a closed code
(`REQUEST_UNREADABLE`, `REQUEST_INVALID`, `MODEL_REFUSED`, `MODEL_API_ERROR`,
`MODEL_EMPTY_REPLY`, `MODEL_ABORTED` or `DELIVERY_FAILED`), never the task, patch or
findings. In `.jev/config.yaml`, `remediation.auto_propose: false` still disables
proposals for the project, but a `remediation.model` there is ignored on Claude Code
(logged as `REMEDIATION_PROJECT_MODEL_IGNORED`). `delivery` is not accepted in
`.jev/config.yaml`. There is no slash command to reopen the panel, because a command
result is also read by the model.

### Local state

The hook keeps bounded state under `${CLAUDE_PLUGIN_DATA}/claude-code/`, with
directories at mode `0700` and files at `0600` on POSIX (the user-profile ACL applies
on Windows). When a unit closes it leaves one handoff in `handoff/`; a detached worker
reviews it, appends the result to `reviews.jsonl`, and deletes it. State and handoffs
unconsumed for 24 hours are removed, and ending a session deletes its open state. The
hook and worker write only closed codes to `hook-log.jsonl` and `worker-log.jsonl`
(each bounded to 256 KiB), never a task, patch, path, finding, or credential.

`reviews.jsonl` is the local history. For the in-session display the worker also
appends to a small per-session feed at
`<XDG_DATA_HOME or ~/.local/share>/jevguard/claude-code/feed/<sessionId>.jsonl`
(`USERPROFILE` is used before `HOME` when both are set). It holds only ids, outcomes,
probabilities, typed reasons, counts and slice counts, is bounded to 256 KiB, uses
modes `0600`/`0700` on POSIX, and a file untouched for 24 hours is deleted. It can
be deleted at any time; only the in-session display is lost.

When remediation is on, the worker also writes one private request per proposal to
`<XDG_DATA_HOME or ~/.local/share>/jevguard/claude-code/proposals/<sessionId>/`. It holds
the task and the attributed patch, uses modes `0600`/`0700` on POSIX, is blanked by the
module as soon as it reads it and removed by the worker when blank or older than 24
hours (at the worker's next run).
