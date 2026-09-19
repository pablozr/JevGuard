# Contributing to JevGuard

Thanks for contributing. JevGuard is designed to make coding-agent changes more
trustworthy without pretending that incomplete evidence is safe to judge.

## Before you start

Read:

- [`README.md`](./README.md) for product intent;
- local [`SPEC.md`](./SPEC.md) for scope and normative V0.1 contracts;
- [`AGENTS.md`](./AGENTS.md) for architecture and code standards;
- local [`docs/adr`](./docs/adr) for decisions that should not be casually reversed.

`SPEC.md`, `CONTEXT.md`, `docs/adr/`, and `docs/tasks/` are intentionally local
planning records and are ignored by Git. Do not add, force-add, or publish them.

## Development setup

The project uses pnpm workspaces. Bun is the OpenCode plugin runtime, not the
workspace package manager.

```sh
corepack enable
pnpm install
```

The workspace scaffold and package scripts are landing with the MVP implementation.
Until then, these commands describe the required development contract:

```sh
pnpm format
pnpm lint
pnpm typecheck
pnpm test
```

## Contribution expectations

- Keep changes focused and preserve package dependency direction.
- Add or update tests for behavior changes and regressions.
- Do not use a global git diff as fallback evidence.
- Do not change `UNAVAILABLE` into a semantic verdict.
- Do not add auto-remediation, blocking behavior, or agent-context injection to
  the V0.1 observe-mode slice.
- Do not expose API keys, environment files, secrets, or rejected evidence in
  tests, fixtures, logs, or documentation.
- Do not accept the TypeSafe API key as a CLI argument or repository setting. Local
  credentials use `jevguard login` and the OS credential store; the environment
  override is reserved for CI and controlled automation.

## Pull requests

Explain the problem, behavioral change, tests, and documentation updates. Mention
any intentional deviation from `SPEC.md` or an ADR.

Keep pull requests reviewable. If a change introduces a hard-to-reverse boundary,
technology commitment, or non-obvious trade-off, propose an ADR with it.

## Code style

Write small, readable TypeScript modules. Prefer strong types, explicit names, and
whitespace between logical steps over comments. TSDoc is for public contracts and
non-obvious invariants, not for narrating implementation. Centralize a feature's
interfaces, unions, and shared type aliases in a focused `types.ts` module; keep a
type beside implementation only when it is truly private and extraction would make
the module less readable.

## License

By contributing, you agree that your contributions are licensed under the
[MIT License](./LICENSE).
