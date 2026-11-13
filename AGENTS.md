# JevGuard Engineering Guide

## Product boundary

JevGuard is a semantic policy engine for coding agents. Jev provides narrow
probabilistic judgments; deterministic code owns policy, thresholds, outcomes,
workflow, and presentation.

Read the local [`SPEC.md`](./SPEC.md) and [`CONTEXT.md`](./CONTEXT.md), deliberately
ignored by Git, and the applicable ADRs in [`docs/adr/`](./docs/adr/README.md) before
changing behavior. Together they are the authoritative working-product record in this
repository. The V0.1 specification is normative.

## Package boundaries

```text
packages/
├── claude-code-adapter/
├── claude-code-plugin/
├── cli/
├── core/
├── node-infra/
├── opencode-adapter/
└── plugin/
```

Dependencies only point inward:

```text
plugin → opencode-adapter → node-infra → core
plugin ────────────────────→ node-infra
claude-code-plugin → claude-code-adapter → node-infra → core
claude-code-adapter ─────────→ node-infra → core
cli → opencode-adapter/cli ──→ node-infra → core
cli → claude-code-plugin/cli → node-infra → core
cli ─────────────────────────→ node-infra → core
```

- `core` owns domain types, rules/config validation, scope filtering, evidence
  policy, Jev ports, use cases (including the host-independent turn review), gates,
  and the remediation config/proposal-request encoding. Do not import OpenCode, Bun,
  Node filesystem/environment APIs, HTTP clients, or TUI APIs here.
- `node-infra` owns host-independent Node infrastructure shared by host adapters:
  the OS credential store, the `TYPESAFE_API_KEY` override and `jevguard login`
  primitives, the TypeSafe Jev transport, fixed-path `.jev` policy loading and strict
  YAML config parsing, the review-log allowlist projection, and the bounded local
  review history. It also owns the host-neutral CLI ports (`HostCliExtension`, the
  process runner, the confirmation prompt, the text file port) and the user-level
  `delivery: agent` writer. It never imports a host SDK or TUI API; host adapters never
  depend on each other.
- `opencode-adapter` owns OpenCode execution-event handling, task/diff attribution,
  OpenCode-specific infrastructure, structured logging, the proposal child session,
  the origin-session prompt facade for the opt-in delivery, and the safe remediation notifier
  (a no-op toast sink on the 2.2.x server context, which has no toast channel).
- `claude-code-adapter` owns Claude Code hook-event normalization, tool-attributed
  quiescent-unit acquisition (ADR 0014) and the `Turn` mapping. It never imports
  `opencode-adapter` or a host SDK. Its core (`hook-event/`, `acquisition/`, `turn/`)
  and `presentation/` (feed encoding, parsing and wording) is pure and imports no
  Node module; `capture/` and `hook/` add the Node hook
  entrypoint and bounded local unit state (Node builtins only). Hooks never call Jev,
  credentials or the network, and never write to stdout or stderr. `worker/` is the
  only module that may import `node-infra`: a detached, observe-only review worker
  that drains the handoffs the hook leaves, runs core `reviewTurn` (remediation only when the user enables it; see ADR 0014)
  and records the result in the local review history plus a per-session user-only
  presentation feed.
- `claude-code-plugin` is composition plus the Claude Code artifact (`hook.js`,
  `worker.js`, `hooks/hooks.json`, `.claude-plugin/plugin.json`, a pinned
  `package.json` and `package-lock.json` for the native keyring, the only external
  dependency). The hook bundle never contains the keyring or the Jev client; the
  worker loads the keyring lazily. It also ships `hooks/jevguard-ui.js`, a UI-only
  mod that shows results to the user (`ui.log`, status, toast) from the feed; it
  never touches Jev, credentials or the network. Remediation is opt-in and
  strategy-only (ADR 0014): the worker writes a private proposal request, and the mod makes
  one `$.model.complete` call and shows the result in a user-only panel; an explicit
  user opt-in (`delivery: agent`) may also submit it to the agent once, visibly.
- `plugin` is composition plus the single public OpenCode 2.2.x server plugin entrypoint
  (V2 `Plugin.Plugin`, engine range `>=2.2.2 <2.3`). It registers the bundled
  `jevguard-rules` and `jev-init` skills through `skill.transform`; there is no command
  hook and no apply path. In `observe` (the default) a `FAIL` prepares one strategy-only
  proposal in a deny-all child session. Only when the user's own `opencode.yaml` opts
  into `delivery: agent` does `opencode-adapter/src/runtime/remediation` also queue one visible message
  (the failing findings and the strategy) into the source session per reviewed unit,
  never while the session is busy and never for a turn that came from a delivery. The
  repository can only veto it. The event runtime (turn queue, review, presentation and
  remediation) lives in `opencode-adapter/src/runtime`, exported as
  `@jevguard/opencode-adapter/runtime`; `plugin` only wires it. The package ships no
  `bin`.
- `cli` is the host-neutral command line (`@pablozrrrr/jevguard-cli`, bin `jevguard`,
  runs on Node): `login`, `report`, `feedback`, `rules check`, `doctor`, `install` and
  `setup`. Host-specific behavior (detect, install, doctor checks, the user config file)
  lives behind `HostCliExtension`: `opencode-adapter/src/cli` and
  `claude-code-plugin/src/cli` each export one extension, and `cli` imports them only
  through their `./cli` subpaths. `cli` never imports a host SDK, `plugin`,
  `claude-code-adapter`, or the review hot path; `setup` plans first, writes only after a
  yes, stores a missing key through the `login` prompt, offers `delivery: agent`
  (default No) and never creates `.jev/` without `--init`.

The credential primitives and OS credential-store integration are `node-infra`
concerns; the `jevguard login` command is dispatched by `cli`. Core code receives a credential through an explicit port and never reads
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
  (rules and built-ins) to an isolated, deny-all child session parented to the source
  session (no agent is registered for it), using the configured `remediation.model`
  when present and otherwise the source session's model. A contained proposal failure
  writes only one typed reason code to the log (the OpenCode 2.2.x server context has no
  toast channel) — never task, diff, findings, paths, or credentials. The proposer has
  no tools and returns a strategy only; it never edits code or applies anything. The
  user reviews the proposal and copies its manual apply instruction into their normal
  coding agent, and that ordinary turn is reviewed normally. In `observe` do not
  broaden it: no parent injection, no repository or global diff fallback, no retry or
  re-evaluation loop, and no background session prompting beyond that single
  child-session proposal.
  OpenCode exception (`delivery: agent`, opt-in; ADR 0015): only when the user enables it in
  their own `opencode.yaml` (never in the repository, which can only veto it with
  `remediation.auto_propose: false`), the plugin runs the proposer in the background and
  queues at most one visible, framed message into the source session per reviewed unit. It
  carries every `FAIL` finding (id, description, severity, probability, location with
  hunk) and the strategy, or the findings alone when the proposer failed. It is sent only
  after the execution succeeded and never while the session is busy (an idle wait of 120
  seconds), at most 3 per session for the plugin lifetime, and only a message the host
  accepted counts. The turn it causes is reviewed normally; it gets its own proposal but
  never another delivery. The legacy `mode` and `max_attempts` keys are accepted with a
  warning code and change nothing. No apply path, no retry or forced re-evaluation, and no
  other parent injection.
  Claude Code exception (ADR 0014, 2026-10-14): when the user enables remediation in
  their own config file (never in the repository), the in-session mod drafts the same
  strategy-only proposal with one `$.model.complete` call and shows it in a panel only
  the user sees. With the user's explicit `delivery: agent` it may also submit the
  framed proposal to the agent through `$.prompt.submit` (never as the user), at most
  once per user-initiated unit and three times per session; the resulting turn is reviewed
  normally and never triggers another automatic delivery. The message carries the same
  findings and strategy (findings alone when the model call failed). No other parent injection, no
  apply path, no retry or forced re-evaluation, and the request file that carries the
  task and patch stays private, blanked on read and removed by the worker.
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
- Unit-test remediation config validation, proposal-request bounds, and the proposal
  store in `core`; contract-test the remediation config registration and the automatic
  child-session proposal in `plugin` with fakes.
- Test threshold boundaries exactly.
- Add regression coverage for every corrected defect.
- `tools/evidence-parity` is the only place allowed to import both host adapters; it
  pins byte-identical patch reconstruction between OpenCode and Claude Code.

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

`SPEC.md`, `CONTEXT.md`, `docs/tasks/`, and `PLUGIN-FLOW.md` are local planning
records and must never be committed. `docs/adr/` is published in the repository; ADRs
must not link to the local files, and must not contain secrets, personal data, or
local paths. Update `SPEC.md` only when changing a normative MVP
contract or an approved roadmap direction. Update `CONTEXT.md` when canonical
vocabulary changes. Add an ADR only for hard-to-reverse architectural decisions
with meaningful alternatives.

Keep user-facing configuration and safety behavior synchronized with
`docs/configuration.md` and `docs/security.md`.
