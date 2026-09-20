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
codebase. V0.1 evaluates exactly **one rule per document**.

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
```

### Document grammar

The parser is line-based and strict:

- Exactly one `## <RULE-ID>` heading must appear in the document. No heading is
  `MISSING_ID`; more than one is `MULTIPLE_RULES`. A `##` heading is only a rule
  heading when followed by whitespace; `###` headings are sections.
- The rule ID is the trimmed heading text and must match
  `[A-Za-z0-9][A-Za-z0-9._-]*`.
- Everything between the `##` heading and the first `###` heading is metadata.
  Blank lines are ignored. Any non-blank line must match `key: value`, and only
  `severity` and `scope` are accepted. An unknown key, a duplicate key, or a line
  without `:` is invalid.
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

A document is invalid when it has no rule heading, more than one rule heading, an
invalid rule ID, malformed or duplicated metadata, a missing or invalid
`severity`, an unknown or empty `scope`, an unknown or duplicated section, or a
required section that is missing or empty. An invalid document is `INVALID_RULE`
and makes the review `UNAVAILABLE`; Jev is never called.

### Scope behavior

A valid rule is evaluated only when at least one changed file matches its scope.
When no attributed file matches, the review is `SKIPPED` with reason
`NO_SCOPE_MATCH` and Jev is never called.

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

The evidence policy is fixed in V0.1, not read from `.jev/`. It caps the assembled
diff at `100000` characters, sends only common code and text extensions, and
rejects sensitive names, extensions, and directories. Oversized or blocked
evidence is `UNAVAILABLE`, never a partial judgment. See the
[security model](./security.md) for the defaults.

## Outcomes

| Outcome | Meaning |
| --- | --- |
| `PASS` | Applicable rule evaluated and stayed below its warning threshold. |
| `WARN` | Applicable rule evaluated and reached its warning threshold. |
| `FAIL` | An `error` rule evaluated at or above its failure threshold. |
| `SKIPPED` | No attributed patch (`NO_ATTRIBUTED_PATCH`) or no file matched the scope (`NO_SCOPE_MATCH`). |
| `UNAVAILABLE` | Evaluation could not safely or completely happen. |

`UNAVAILABLE` reasons: `INVALID_RULE`, `INVALID_CONFIG`, `MISSING_ATTRIBUTED_DIFF`,
`OVERSIZED_DIFF`, `BLOCKED_EVIDENCE`, and `JEV_FAILURE`. `SKIPPED` and
`UNAVAILABLE` are operational states, never semantic verdicts.

## Presentation

Each review produces exactly one transient TUI toast and one structured log entry:

- Toast: `JevGuard <OUTCOME>` with the rule label and either the violation
  probability or the reason. `PASS`/`WARN`/`FAIL` use `success`/`warning`/`error`
  variants; `SKIPPED` uses `info`; `UNAVAILABLE` uses `error`. Toasts last 5
  seconds.
- Log: service `jevguard`, level `info` for `PASS`/`SKIPPED`, `warn` for `WARN`,
  and `error` for `FAIL`/`UNAVAILABLE`, with the turn ID, rule ID, severity,
  scoped paths, and either the probability or the reason.

OpenCode sees only these transient toasts and logs. JevGuard does not inject
messages into the agent context, does not modify the session, and does not block a
turn.
