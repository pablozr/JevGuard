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
import type { PluginRuntimeDependencies } from "./types";

/**
 * OpenCode V1.18.31 plugin entrypoint. It composes the adapter infrastructure at
 * the composition root and is observe-only: it never mutates agent context, blocks
 * a turn, asks for permissions, or performs remediation.
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
    jev: createTypeSafeJevTransport(
      createCredentialProvider({
        environment: createProcessEnvironment(),
        store: createKeyringCredentialStore(),
      }),
    ),
  };

  return createPluginRuntime(dependencies);
};
