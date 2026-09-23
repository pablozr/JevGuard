# JevGuard Engineering Guide

## Product boundary

JevGuard is a semantic policy engine for coding agents. Jev provides narrow
probabilistic judgments; deterministic code owns policy, thresholds, outcomes,
workflow, and presentation.

Read the local [`SPEC.md`](./SPEC.md), [`CONTEXT.md`](./CONTEXT.md), and applicable
local ADRs before changing behavior. They are deliberately ignored by Git and are
the authoritative working-product record in this repository. The V0.1 specification
is normative.

## Package boundaries

```text
packages/
├── core/
├── opencode-adapter/
├── plugin/
└── testkit/
```

Dependencies only point inward:

```text
plugin → opencode-adapter → core
testkit ───────────────────┘
```

- `core` owns domain types, rules/config validation, scope filtering, evidence
  policy, Jev ports, use cases, gates, and the review-bridge encoding. Do not import
  OpenCode, Bun, Node filesystem/environment APIs, HTTP clients, or TUI APIs here.
- `opencode-adapter` owns OpenCode event handling, task/diff attribution, concrete
  infrastructure implementations, structured logging, TUI toasts, and the
  review-bridge transport.
- `plugin` is composition plus the two public OpenCode plugin entrypoints: the server
  plugin and the separate remediation TUI.
- `testkit` provides fixtures and fakes; never make production packages depend on it.

The credential CLI and OS credential-store integration are adapter/infrastructure
concerns. Core code receives a credential through an explicit port and never reads
the environment or a system credential store directly.

Host adapters must provide complete, attributed turn evidence. Do not substitute
the current repository diff when host attribution fails.

## Required V0.1 invariants

- One evaluated turn is one completed assistant message, its direct parent user
  message, and the assistant-attributed patch.
- One applicable rule maps to one Jev Noul. `Allowed` belongs in that Noul's
  criteria; never create a second model decision for it.
- Do not emit semantic results from partial evidence. Oversized, missing, blocked,
  invalid, or otherwise incomplete evidence is `UNAVAILABLE`.
- No patch or no scope match is `SKIPPED` without calling Jev.
- The default review is background and observe-only: it never alters agent context,
  blocks a turn, or edits code. A separate, explicitly user-approved remediation
  workflow (see `SPEC.md` §8) acts only on a local `error`-severity repository rule
  that reached `FAIL`; built-ins and `warning` rules are never remediated. Do not
  broaden it: no unattended retry or re-evaluation, and no repository or global diff
  fallback.
- For local use, API credentials come from `jevguard login` and the OS credential
  store. `TYPESAFE_API_KEY` is a CI/automation-only process override. Never expose
  a key in repository configuration, arguments, logs, errors, toasts, fixtures, or
  agent context.

## Code standards

- Use TypeScript strict; avoid `any`, unsafe assertions, and unvalidated external
  input.
- Use Biome for formatting and linting. Do not add ESLint or Prettier.
- Keep modules and functions small, cohesive, and domain-named.
- Separate logical steps with blank lines. Prefer named intermediate values over
  dense expressions.
- Avoid implementation comments. Write TSDoc only for exported contracts and
  non-obvious invariants that types and names cannot express.
- Keep type declarations in focused `types.ts` modules for each feature/domain area
  instead of scattering interfaces and unions through implementation files. Co-locate
  a type only when it is private to one very small module and extracting it would
  make the code harder to follow.
- Keep I/O at the adapter boundary. Pass dependencies explicitly into use cases.
- Prefer exhaustive handling for outcome/state unions.

## Testing

- Use Vitest.
- Unit-test core parsing, invalid rules, scope behavior, evidence safety, gates,
  and orchestration with fakes.
- Contract-test OpenCode attribution and presentation behavior in the adapter.
- Unit-test review-bridge encoding bounds in `core`; contract-test the
  approval-gated TUI remediation workflow in `plugin` with fakes.
- Test threshold boundaries exactly.
- Add regression coverage for every corrected defect.

## Validation

Run the relevant commands before completing work:

```sh
pnpm format
pnpm lint
pnpm typecheck
pnpm test
```

Until the workspace exists, state explicitly which commands could not be run.

## Documentation

`SPEC.md`, `CONTEXT.md`, `docs/adr/`, and `docs/tasks/` are local planning records
and must never be committed. Update `SPEC.md` only when changing a normative MVP
contract or an approved roadmap direction. Update `CONTEXT.md` when canonical
vocabulary changes. Add an ADR only for hard-to-reverse architectural decisions
with meaningful alternatives.

Keep user-facing configuration and safety behavior synchronized with
`docs/configuration.md` and `docs/security.md`.
