# ADR 0008: Adopt a layered pnpm monorepo

## Status

Accepted

JevGuard uses a pnpm TypeScript monorepo with `core`, `opencode-adapter`,
`plugin`, and `testkit` packages. Dependencies flow `plugin → adapter → core`; the
core owns policy and evaluation without importing OpenCode, Bun, filesystem,
transport, or TUI APIs.

This adds small workspace overhead before the first slice, but preserves a stable
core for additional agent adapters, rule packs, CI, and tests without forcing an
OpenCode-specific architecture to be extracted later.
