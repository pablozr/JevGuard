# ADR 0001: Preserve an adapter-independent turn contract

## Status

Accepted

## Context

JevGuard starts as an OpenCode V1 plugin but is intended to support other coding
agents. Host APIs differ in how they expose messages, completion events, snapshots,
and diffs. Binding evaluation and gate logic directly to OpenCode types would make
future adapters duplicate or reinterpret semantic policy behavior.

The product must also prevent evaluation of unattributed worktree state.

## Decision

JevGuard core operates on a normalized `Turn`:

```ts
interface Turn {
  id: string
  task: string
  files: Array<{
    path: string
    patch: string
  }>
}
```

Adapters are responsible for obtaining complete, attributable evidence and mapping
it into this contract. The core owns rule parsing, scope filtering, evidence safety,
Jev calls, gates, and review outcomes.

An adapter that cannot obtain the task or full attributed diff reports
`UNAVAILABLE`; it must not use a repository-wide diff as a substitute.

## Consequences

- OpenCode-specific code remains at the adapter boundary.
- Multi-agent support has a stable semantic interface.
- CI can later provide a compatible PR-derived turn/review input.
- The small contract may need extension for future evidence ranges, baselines, or
  repository metadata; additions must preserve attribution and core independence.
