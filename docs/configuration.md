# Configuration Reference

JevGuard reads repository policy from `.jev/`:

```text
.jev/
├── rules.md
└── config.yaml
```

## `rules.md`

Rules are Markdown so they can be authored, reviewed, and versioned alongside the
codebase.

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

### Fields

| Field | Required | Meaning |
| --- | --- | --- |
| Heading | Yes | Rule ID. Example: `## ARCH-001`. Must be unique. |
| `severity` | Yes | `error` or `warning`. |
| `scope` | No | Glob selecting changed files relevant to the rule. |
| `Rule` | Yes | The normative policy. |
| `Violation` | Yes | The condition that breaches the policy. |
| `Allowed` | No | Normative exception to `Violation`. |

JevGuard evaluates a rule only when at least one changed file matches its scope. A
rule with no matching files is `SKIPPED`.

`Allowed` is included in the same violation judgment. It does not create a second
model call or an advisory exception.

### Invalid policies

JevGuard validates rules before sending any content to Jev. A malformed, duplicate,
or self-contradictory rule is `INVALID_RULE`; the review becomes `UNAVAILABLE`.

## `config.yaml`

Configuration is optional. Missing configuration uses the defaults below.

```yaml
version: 1

thresholds:
  error:
    warn: 0.40
    fail: 0.70
  warning:
    warn: 0.60
```

| Severity | PASS | WARN | FAIL |
| --- | ---: | ---: | ---: |
| `error` | below `warn` | `warn` through below `fail` | `fail` and above |
| `warning` | below `warn` | `warn` and above | never |

A present but invalid configuration produces `UNAVAILABLE`. JevGuard does not guess
which thresholds you intended.

## Outcomes

| Outcome | Meaning |
| --- | --- |
| `PASS` | Applicable rule evaluated and did not reach its warning threshold. |
| `WARN` | Applicable rule evaluated and reached its warning threshold. |
| `FAIL` | An `error` rule evaluated at or above its failure threshold. |
| `SKIPPED` | No attributed patch or no file matched the rule scope. |
| `UNAVAILABLE` | Evaluation could not safely or completely happen. |
