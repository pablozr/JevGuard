# Configuration Reference

JevGuard reads repository policy from `.jev/`:

```text
.jev/
├── rules.md       required to evaluate a turn
└── config.yaml    optional; absent means defaults
```

Both files are read once per attributed turn. A missing `.jev/rules.md` is not a
pass: the review becomes `UNAVAILABLE`.

## `rules.md`

Rules are Markdown so they can be authored, reviewed, and versioned alongside the
codebase. One document may declare any number of rules, and every rule block is
evaluated.

```md
## ARCH-001

severity: error
scope: backend/**

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
  and only `severity` and `scope` are accepted. An unknown key, a duplicate key, or
  a line without `:` is invalid.
- `severity` is required and must be exactly `error` or `warning`.
- `scope` is optional. When present it must have a non-empty value. It is a glob
  matched against changed file paths, where `*` matches within a path segment,
  `**` matches across segments, and `?` matches one non-separator character. Both
  `/` and `\` separators are normalized before matching. When `scope` is absent,
  every changed file in the turn is in scope.
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
unknown or empty, a section is unknown or duplicated, or a required section is
missing or empty. An invalid block becomes a per-rule `UNAVAILABLE` result with
reason `INVALID_RULE`; Jev is never called for that block, and its valid siblings
are still evaluated.

### Scope behavior

Scope is evaluated per rule against the same attributed turn. A valid rule is
evaluated only when at least one changed file matches its scope. When no attributed
file matches, that rule is `SKIPPED` with reason `NO_SCOPE_MATCH` and Jev is never
called for it.

`Allowed` belongs to the same violation judgment. It is sent in the same Noul
criteria as `Rule` and `Violation`; it never creates a second model call or a
separate advisory exception.

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
```

Validation rules:

- `version` must be exactly `1`.
- `thresholds.error.warn`, `thresholds.error.fail`, and `thresholds.warning.warn`
  must be numbers in `[0, 1]`.
- `thresholds.error.warn` must be strictly less than `thresholds.error.fail`.

A present but invalid configuration is `INVALID_CONFIG` and makes the review
`UNAVAILABLE`. JevGuard never guesses which thresholds you intended.

### Thresholds

| Severity | PASS | WARN | FAIL |
| --- | ---: | ---: | ---: |
| `error` | below `warn` | `warn` through below `fail` | `fail` and above |
| `warning` | below `warn` | `warn` and above | never |

Defaults: `error` warns at `0.40` and fails at `0.70`; `warning` warns at `0.60`
and never fails.

## Evidence

The evidence policy is fixed in core, not read from `.jev/`. For each rule it
assembles a diff only from that rule's applicable files, caps that diff at `100000`
characters, sends only common code and text extensions, and rejects sensitive
names, extensions, and directories. Oversized or blocked evidence makes only the
affected matching rule `UNAVAILABLE` (never a partial judgment for that rule);
rules whose applicable files are all safe still run. See the
[security model](./security.md) for the defaults.

## Outcomes

Outcomes are per rule.

| Outcome | Meaning |
| --- | --- |
| `PASS` | Applicable rule evaluated and stayed below its warning threshold. |
| `WARN` | Applicable rule evaluated and reached its warning threshold. |
| `FAIL` | An `error` rule evaluated at or above its failure threshold. |
| `SKIPPED` | No attributed patch (`NO_ATTRIBUTED_PATCH`) or no file matched the rule scope (`NO_SCOPE_MATCH`). |
| `UNAVAILABLE` | That rule's evaluation could not safely or completely happen. |

`UNAVAILABLE` reasons: `INVALID_RULE`, `INVALID_CONFIG`, `MISSING_ATTRIBUTED_DIFF`,
`OVERSIZED_DIFF`, `BLOCKED_EVIDENCE`, and `JEV_FAILURE`. `SKIPPED` and
`UNAVAILABLE` are operational states, never semantic verdicts.

Not every `UNAVAILABLE` is a policy-rule result. Failures that happen before any
rule is evaluated — no attributed diff (`MISSING_ATTRIBUTED_DIFF`), unreadable
policy files (`INVALID_RULE`/`INVALID_CONFIG`), or a missing `.jev/rules.md`
(`INVALID_RULE`) — are reported as one synthetic aggregate entry with `ruleId:
null`, `severity: null`, and empty `scopedPaths`. That entry is not replicated once
per declared rule, and the aggregate counts include it.

## Presentation

Each turn produces exactly one transient TUI toast and one structured log entry for
the whole review:

- Toast: `JevGuard <OUTCOME>` where `<OUTCOME>` is the aggregate display outcome.
  The display precedence is `FAIL > UNAVAILABLE > WARN > PASS > SKIPPED`: any
  `FAIL` shows `FAIL`, otherwise any `UNAVAILABLE` shows `UNAVAILABLE`, and so on
  down to a review where every rule is `SKIPPED`. The message is a count summary
  such as `pass 1 · warn 1 · fail 1 · skipped 0 · unavailable 0`. `PASS`/`WARN`/
  `FAIL` use `success`/`warning`/`error` variants; `SKIPPED` uses `info`;
  `UNAVAILABLE` uses `error`. Toasts last 5 seconds.
- Log: one entry with service `jevguard`. Its level follows the same aggregate
  display outcome: `info` for `PASS`/`SKIPPED`, `warn` for `WARN`, and `error` for
  `FAIL`/`UNAVAILABLE`. The entry carries the turn ID, the aggregate summary
  (highest verdict, whether any rule was unavailable, and per-outcome counts), and
  the full result list with rule ID, severity, scoped paths, and either the raw
  violation probability or the typed reason. A review-level failure contributes its
  single synthetic entry (null rule ID and severity) to that list and to the counts.

The toast is intentionally compact and never includes probabilities or paths. A
generic count summary does not mean every rule was evaluated: an `UNAVAILABLE` rule
is a missing judgment, and it does not erase a known `FAIL` elsewhere in the turn.

OpenCode sees only these transient toasts and logs. JevGuard does not inject
messages into the agent context, does not modify the session, and does not block a
turn.
