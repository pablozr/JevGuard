# ADR 0016: a host-neutral CLI package with one extension per host

Status: accepted — 2026-11-12, explicit owner decision. Builds on
[ADR 0008](0008-adopt-layered-pnpm-monorepo.md) and
[ADR 0014](0014-claude-code-tool-attributed-turn-profile.md).

## Context

The `jevguard` binary lived inside the OpenCode plugin package. Claude Code users had to
install an OpenCode plugin to run `jevguard login`, `report` or `doctor`, the plugin
artifact carried a command line it does not use at runtime, and every new host would have
needed another place to hang its install and diagnosis steps. The `testkit` package had
become an unused shell.

## Decision

- A new package, `packages/cli` (`@pablozrrrr/jevguard-cli`, bin `jevguard`), runs on Node
  and owns the commands: `login`, `report`, `feedback`, `rules check`, `doctor`,
  `install` and `setup`.
- Host-specific behavior sits behind a `HostCliExtension` port defined in `node-infra`
  (detect, inspect and perform the install, extra doctor checks, the name of the user
  config file and its remediation validation rules). `opencode-adapter` and
  `claude-code-plugin` each export one extension through a `./cli` subpath. `cli`
  imports extensions only through those subpaths and never a host SDK, the OpenCode
  plugin, or the Claude Code adapter.
- The Claude Code extension installs through the `claude plugin` subcommands with fixed
  arguments and a minimum Claude Code version, after an interactive yes.
- `jevguard setup` plans first (credential, then each detected host, `delivery: agent`,
  starter policy), changes nothing without a yes or `--yes`, stores the key through the
  same masked prompt as `login` (a missing terminal fails that step only), never creates
  `.jev/` without `--init`, and asks about `delivery: agent` (default No; `--yes` needs
  `--agent-delivery`) writing it only to the user's own config home.
- The OpenCode plugin artifact no longer ships a `bin` or the command line; its event
  runtime moves into `opencode-adapter/src/runtime` and the plugin stays composition.
- `packages/testkit` is removed.

## Alternatives considered

- Keep the binary in the OpenCode plugin: keeps Claude Code users dependent on an
  OpenCode package.
- One CLI per host: duplicates login, report and feedback, and splits shared state.
- A dispatcher that shells out to per-host binaries: hides failures and complicates
  credentials.

## Consequences

- Both hosts install and diagnose through the same command; adding a host means adding
  an extension, not editing the CLI.
- Existing OpenCode users run `npx @pablozrrrr/jevguard-cli <command>` instead of the
  plugin's binary, a breaking change for the plugin package (version 0.4.0).
- The CLI package has its own runtime dependencies (the keyring and prompt libraries) and
  its own artifact; the hook and worker bundles of Claude Code stay free of them.
