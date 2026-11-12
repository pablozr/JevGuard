# ADR 0003: Use attributed diffs only

## Status

Accepted

JevGuard evaluates an assistant response against the direct parent user task and
the diff attributed to that assistant response by the host adapter. It must not
fall back to the repository's current global diff, because concurrent, prior, or
user-authored changes would make the policy result untrustworthy.

## Consequences

- Missing attributed task or full diff produces `UNAVAILABLE`.
- A completed response with no attributed patch produces `SKIPPED`.
- Every adapter must establish this attribution before it can claim semantic
  verdicts.
