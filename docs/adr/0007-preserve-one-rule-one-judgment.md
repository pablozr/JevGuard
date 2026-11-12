# ADR 0007: Preserve one rule, one judgment

## Status

Accepted

Each applicable semantic rule maps to one narrow Jev Noul whose value is the
probability that the attributed change violates that rule. The MVP starts with one
rule; later multi-rule evaluation may batch independent questions for latency or
cost, but must retain separate state/evidence selection, raw probabilities, and
gate outcomes per rule.

This rejects a monolithic “does this diff follow all policies?” prompt, whose mixed
criteria would be hard to threshold, debug, calibrate, or remediate.
