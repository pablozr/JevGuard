# Architecture decision records

Hard-to-reverse decisions for JevGuard, one file per decision, numbered in the order they
were taken. Each record states its status, context, decision, alternatives and
consequences; later records can supersede earlier ones. References to "SPEC" or
"CONTEXT" point to local planning documents that are not published in this repository.

| ADR | Title | Status |
| --- | --- | --- |
| [0001](0001-core-turn-contract.md) | Preserve an adapter-independent turn contract | Accepted |
| [0002](0002-separate-semantic-judgment-from-policy.md) | Separate semantic judgment from policy | Accepted |
| [0003](0003-use-attributed-diffs-only.md) | Use attributed diffs only | Accepted |
| [0004](0004-require-complete-safe-evidence.md) | Require complete and safe evidence | Accepted |
| [0005](0005-keep-policy-local-and-versioned.md) | Keep policy local and versioned | Accepted |
| [0006](0006-start-in-observe-mode.md) | Start in observe mode | Accepted |
| [0007](0007-preserve-one-rule-one-judgment.md) | Preserve one rule, one judgment | Accepted |
| [0008](0008-adopt-layered-pnpm-monorepo.md) | Adopt a layered pnpm monorepo | Accepted |
| [0009](0009-use-biome-strict-typescript-and-vitest.md) | Use Biome, strict TypeScript, and Vitest | Accepted |
| [0010](0010-store-local-api-keys-in-os-credential-store.md) | Store local API keys in the OS credential store | Accepted |
| [0011](0011-opencode-v2-review-episode.md) | Review closed episodes on OpenCode v2 (in Portuguese) | Accepted direction |
| [0012](0012-owned-capture-awaited-host-bridge.md) | Owned capture and awaited host bridge (in Portuguese) | Superseded by 0013 |
| [0013](0013-native-historical-changesets.md) | Strict native historical changesets | Accepted direction |
| [0014](0014-claude-code-tool-attributed-turn-profile.md) | Claude Code tool-attributed turn profile | Accepted |
| [0015](0015-single-agent-delivery.md) | One agent delivery per unit, no remediation chain | Accepted |
| [0016](0016-host-neutral-cli.md) | A host-neutral CLI package with one extension per host | Accepted |
| [0017](0017-mcp-calls-fenced-by-git-snapshot.md) | MCP calls are fenced by the same Git snapshot as the shell | Accepted |
| [0018](0018-project-root-from-the-edited-repository.md) | A unit's project root is the repository its files belong to | Accepted |
