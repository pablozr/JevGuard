import { createFifoJevPort } from "@jevguard/core";
import {
  createCredentialProvider,
  createKeyringCredentialStore,
  createNodePolicyFileSystem,
  createOpenCodeCommandClient,
  createOpenCodeLogSink,
  createOpenCodePresentationClient,
  createOpenCodeReviewBridge,
  createOpenCodeSessionFacade,
  createOpenCodeToastSink,
  createPolicyFileLoader,
  createProcessEnvironment,
  createReviewPresenter,
  createTypeSafeJevTransport,
  InMemoryTurnDeduplicator,
} from "@jevguard/opencode-adapter";
import type { Plugin } from "@opencode-ai/plugin";
import { createPluginRuntime } from "./runtime";
import { createConfigHook } from "./skills/config-hook";
import { resolveInstalledSkillDirectory } from "./skills/skill-directory";
import type { PluginRuntimeDependencies } from "./types";

const DEFAULT_JEV_MAX_CONCURRENCY = 2;

/**
 * OpenCode V1.18.31 plugin entrypoint. It composes the adapter infrastructure at
 * the composition root, wraps the concrete Jev transport in one shared FIFO
 * concurrency limit for every rule and built-in batch of this plugin instance. Its
 * review stays detached, nonblocking, and never mutates agent context. A local
 * `error` rule that fails may emit a bounded bridge command for the separate TUI
 * target; only that target can begin the approval-gated remediation workflow. The
 * host also receives a `config` hook that registers the bundled `jevguard-rules`
 * skill directory on the live config.
 */
export const JevGuardPlugin: Plugin = async (input) => {
  const presentationClient = createOpenCodePresentationClient(input.client);

  const dependencies: PluginRuntimeDependencies = {
    facade: createOpenCodeSessionFacade(input.client),
    deduplicator: new InMemoryTurnDeduplicator(),
    policy: createPolicyFileLoader({
      root: input.worktree,
      fileSystem: createNodePolicyFileSystem(),
    }),
    presenter: createReviewPresenter({
      log: createOpenCodeLogSink(presentationClient),
      toast: createOpenCodeToastSink(presentationClient),
    }),
    bridge: createOpenCodeReviewBridge(createOpenCodeCommandClient(input.client)),
    jev: createFifoJevPort(
      createTypeSafeJevTransport(
        createCredentialProvider({
          environment: createProcessEnvironment(),
          store: createKeyringCredentialStore(),
        }),
      ),
      { maxConcurrency: DEFAULT_JEV_MAX_CONCURRENCY },
    ),
  };

  return {
    ...createPluginRuntime(dependencies).hooks,
    config: createConfigHook({ skillDirectory: resolveInstalledSkillDirectory(import.meta.url) }),
  };
};
