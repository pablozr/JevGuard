import { createFifoJevPort } from "@jevguard/core";
import {
  createCredentialProvider,
  createKeyringCredentialStore,
  createNodePolicyFileSystem,
  createOpenCodeLogSink,
  createOpenCodePresentationClient,
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
 * concurrency limit for every rule and built-in batch of this plugin instance, and
 * is observe-only: it never mutates agent context, blocks a turn, asks for
 * permissions, or performs remediation. The host receives the runtime event hook
 * plus a `config` hook that registers the bundled `jevguard-rules` skill directory
 * on the live config; reviews run detached from the event so they never sit on the
 * agent's critical path.
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
