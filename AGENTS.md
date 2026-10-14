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
  policy, Jev ports, use cases, gates, and the remediation config/proposal-request
  encoding. Do not import OpenCode, Bun, Node filesystem/environment APIs, HTTP
  clients, or TUI APIs here.
- `opencode-adapter` owns OpenCode event handling, task/diff attribution, concrete
  infrastructure implementations, structured logging, TUI toasts, the proposal child
  session, and the safe remediation notifier.
- `plugin` is composition plus the single public OpenCode server plugin entrypoint.
  Its `config` hook registers the bundled `jevguard-rules` and `jev-init` skills and
  the hidden `jevguard-proposer` subagent; there is no command hook and no apply path.
- `testkit` provides fixtures and fakes; never make production packages depend on it.

The credential CLI and OS credential-store integration are adapter/infrastructure
concerns. Core code receives a credential through an explicit port and never reads
the environment or a system credential store directly.

Host adapters must provide complete, attributed turn evidence. Do not substitute
the current repository diff when host attribution fails.

## Required V0.1 invariants

- One evaluated turn is one completed assistant message, its direct parent user
  message, and the assistant-attributed patch.
- One applicable repository rule maps to exactly one Jev Noul for each complete
  evidence slice produced for it; `Allowed` belongs in every such Noul's criteria and
  never creates a separate model decision. A rule-level semantic verdict exists only
  after every planned slice has a valid Jev judgment and is the deterministic maximum
  of those slice judgments.
- Do not emit semantic results from partial evidence. Oversized evidence is sliced by
  file and unified-diff hunk; missing, blocked, invalid, or otherwise incomplete
  evidence is `UNAVAILABLE`, and a rule whose slices do not fit the per-rule or
  per-turn slice budget is `UNAVAILABLE/SLICE_LIMIT_EXCEEDED`.
- No patch or no scope match is `SKIPPED` without calling Jev.
- The default review is background and observe-only: it never alters agent context,
  prompts a session, blocks a turn, or edits code. A separate, configurable
  remediation workflow (see `SPEC.md` §8) is delivered by the server plugin: after a
  review with any `FAIL`, and only when remediation is enabled (the default), the
  plugin sends the task, the complete safe attributed patch, and every `FAIL` finding
  (rules and built-ins) to a hidden `jevguard-proposer` subagent in an isolated child
  session parented to the source session, using the configured `remediation.model` when
  present and otherwise inheriting the host's model, then shows a generic toast. A
  contained proposal failure shows a generic error toast and writes only one typed
  reason code to the log — never task, diff, findings, paths, or credentials. The
  proposer has no tools and returns a strategy only; it never edits code or applies
  anything. The
  user reviews the proposal and copies its manual apply instruction into their normal
  coding agent, and that ordinary turn is reviewed normally. Do not broaden it: no
  parent injection, no repository or global diff fallback, no retry or re-evaluation
  loop, and no background session prompting beyond that single child-session proposal.
- For local use, API credentials come from `jevguard login` and the OS credential
  store. `TYPESAFE_API_KEY` is a CI/automation-only process override. Never expose
  a key in repository configuration, arguments, logs, errors, toasts, fixtures, or
  agent context.

## Approved V2 episode direction (not the shipped V1 runtime)

SPEC §7.10 defines the ratified host-independent episode contract. The approved
acquisition direction is strict host-owned native historical changesets, initially
Git text only, queried read-only by exact durable closure with typed frozen coverage.
Do not integrate the archived standalone J02 scanner or add an owned scanner,
duplicate strict Git capturer, incremental framework or fallback. Ignored relevant
omissions and unrepresented binary content remain explicit problems; unknown or
incomplete coverage cannot yield semantic results. Safe disjoint rules require
provable complete coverage; incomplete total evidence blocks built-ins/proposals.
Classify sensitive paths before new opt-in native content acquisition: native reuse
does not authorize secret reads or exports, nor certify unrelated legacy host reads.
Public capability, native no-read and retention remain design gates, not shipped support.
Keep V1 Turn,
evaluation and remediation unchanged until their migration tasks. Episode evidence
is complete observed net delta, not exclusive authorship or a write/revert audit.
Known overlapping sessions on one root and unsettled known writers make evidence
unavailable; never serialize sessions with a global lock. Recovery uses only frozen
evidence and a verifiable durable closure, never the current tree. Freeze initial
policy with the baseline for both review and proposal. Capture waits are bounded,
including required persistence; timeout invalidates late results. Numeric budgets
and host capabilities remain gated, not defaults. No Jev, credential, network or
proposal work belongs in capture callbacks. All existing evidence safety,
observe-only and strategy-only boundaries remain in force.

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
- Unit-test remediation config validation, proposal-request bounds, and the proposal
  store in `core`; contract-test the remediation config registration and the automatic
  child-session proposal in `plugin` with fakes.
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
