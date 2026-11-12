# ADR 0002: Separate semantic judgment from policy

## Status

Accepted

JevGuard uses Jev only for narrow, typed semantic judgments and keeps thresholds,
severity interpretation, aggregation, operational outcomes, and future remediation
in deterministic code. This avoids delegating workflow authority to a probabilistic
model, preserves raw evidence for later calibration, and lets repository policy
change without changing the meaning of a model response.

## Consequences

- Each repository rule produces one independent violation-probability judgment.
- `PASS`, `WARN`, and `FAIL` are local gate results, not Jev responses.
- `SKIPPED` and `UNAVAILABLE` remain operational states, never model judgments.
