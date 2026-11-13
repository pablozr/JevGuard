export const CLAUDE_COMMAND = "claude";

/** Oldest Claude Code release with the `claude plugin` subcommands the install relies on. */
export const CLAUDE_SUPPORTED_RANGE = ">=2.1.287";

export const CLAUDE_VERSION_TIMEOUT_MS = 5_000;

export const CLAUDE_LIST_TIMEOUT_MS = 30_000;

export const CLAUDE_INSTALL_TIMEOUT_MS = 120_000;

/** The GitHub repository that carries `.claude-plugin/marketplace.json`. */
export const MARKETPLACE_SOURCE = "pablozr/JevGuard";

export const MARKETPLACE_NAME = "jevguard";

export const PLUGIN_NAME = "jevguard";

export const PLUGIN_ID = `${PLUGIN_NAME}@${MARKETPLACE_NAME}`;
