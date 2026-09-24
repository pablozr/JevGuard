import { createFifoJevPort, createRemediationProposalStore } from "@jevguard/core";
import {
  createCredentialProvider,
  createKeyringCredentialStore,
  createNodePolicyFileSystem,
  createOpenCodeLogSink,
  createOpenCodePresentationClient,
  createOpenCodeProposalSessionFacade,
  createOpenCodeSessionFacade,
  createOpenCodeSessionNavigator,
  createOpenCodeToastSink,
  createPolicyFileLoader,
  createProcessEnvironment,
  createRemediationNotifier,
  createReviewPresenter,
  createTypeSafeJevTransport,
  InMemoryTurnDeduplicator,
} from "@jevguard/opencode-adapter";
import type { Plugin } from "@opencode-ai/plugin";
import { registerRemediationConfig } from "./remediation/config";
import { createPluginRuntime } from "./runtime";
import { createConfigHook } from "./skills/config-hook";
import { resolveInstalledSkillDirectory } from "./skills/skill-directory";
import type { PluginRuntimeDependencies } from "./types";

const DEFAULT_JEV_MAX_CONCURRENCY = 2;

/**
 * OpenCode V1.18.32 server plugin entrypoint. It composes the adapter
 * infrastructure at the composition root and wraps the concrete Jev transport in one
 * shared FIFO concurrency limit for every rule and built-in batch of this plugin
 * instance. Its review stays detached, nonblocking, and never mutates agent context.
 * After a review containing a `FAIL` with complete safe full-turn evidence and an
 * enabled, valid remediation config, it creates one child session, registers and
 * navigates the TUI to it, then prompts the hidden `jevguard-proposer` subagent and
 * shows a generic toast when the proposal is ready. The `config` hook
 * registers the bundled `jevguard-rules` skill and that internal subagent only; there
 * is no command hook, no session prompt into the parent, and no auto-apply.
 */
export const JevGuardPlugin: Plugin = async (input) => {
  const presentationClient = createOpenCodePresentationClient(input.client);
  const toast = createOpenCodeToastSink(presentationClient);

  const dependencies: PluginRuntimeDependencies = {
    facade: createOpenCodeSessionFacade(input.client),
    deduplicator: new InMemoryTurnDeduplicator(),
    policy: createPolicyFileLoader({
      root: input.worktree,
      fileSystem: createNodePolicyFileSystem(),
    }),
    presenter: createReviewPresenter({
      log: createOpenCodeLogSink(presentationClient),
      toast,
    }),
    proposals: createRemediationProposalStore(),
    proposalFacade: createOpenCodeProposalSessionFacade(input.client),
    navigator: createOpenCodeSessionNavigator(presentationClient),
    notifier: createRemediationNotifier(toast),
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

  const skillConfigHook = createConfigHook({
    skillDirectory: resolveInstalledSkillDirectory(import.meta.url),
  });

  return {
    ...createPluginRuntime(dependencies).hooks,
    config: async (config: unknown) => {
      try {
        await skillConfigHook(config);
        registerRemediationConfig(config);
      } catch {
        return;
      }
    },
  };
};
