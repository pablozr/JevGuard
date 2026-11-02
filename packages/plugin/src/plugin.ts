import { createRemediationProposalStore } from "@jevguard/core";
import {
  createLocalReviewHistory,
  createMirroredReviewLogSink,
  createNodePolicyFileSystem,
  createNodeReviewHistoryFileSystem,
  createPolicyFileLoader,
  createProcessReviewHistoryContext,
  createRemediationChainLog,
  type RemediationUserSettingsResult,
} from "@jevguard/node-infra";
import {
  createConsoleLogWriter,
  createNullSessionNavigator,
  createNullToastSink,
  createOpenCodeLogSink,
  createOpenCodeOriginPromptFacade,
  createOpenCodeProposalSessionFacade,
  createOpenCodeSessionFacade,
  createOperationalLogSink,
  createRemediationFailureLogSink,
  createRemediationNotifier,
  createReviewPresenter,
  createTurnTracker,
  InMemoryTurnDeduplicator,
  type OperationalLogSink,
  registerProposalRetryGuard,
  writtenPaths,
} from "@jevguard/opencode-adapter";
import type { Plugin } from "@opencode/plugin";
import { createDefaultJevPort } from "./jev-port";
import { createRemediationChains } from "./remediation/chains";
import { createChildExecutionWatcher } from "./remediation/child-executions";
import { PROPOSAL_TIMEOUT_MS } from "./remediation/propose";
import type { RemediateSetup } from "./remediation/remediate";
import { createOpenCodeRemediationSettings } from "./remediation/user-settings";
import { createPluginRuntime } from "./runtime";
import { readBundledSkills, registerSkills } from "./skills/register-skills";
import { resolveInstalledSkillDirectories } from "./skills/skill-directory";
import { TURN_EVENT_TYPES } from "./turn-event";
import type { PluginRuntime, PluginRuntimeDependencies } from "./types";

const PLUGIN_ID = "jevguard";
const SHUTDOWN_DRAIN_MS = 2_000;

type Registration = { readonly dispose: () => Promise<void> };

/**
 * `remediate` only when the user's own `opencode.yaml` opts in; a refused file is logged
 * once and leaves remediation off.
 */
function remediationSetupOf(
  context: Plugin.Context,
  root: string,
  operational: OperationalLogSink,
  settingsOf: (projectRoot: string) => RemediationUserSettingsResult,
): RemediateSetup | null {
  const settings = settingsOf(root);

  if (settings.status === "INVALID") {
    void operational
      .write({ kind: "REMEDIATION_CONFIG_INVALID", reason: settings.reason })
      .catch(() => undefined);
    return null;
  }

  if (settings.status !== "ENABLED" || settings.settings.mode !== "remediate") return null;

  return {
    originPrompt: createOpenCodeOriginPromptFacade(context),
    maxAttempts: settings.settings.maxAttempts,
    chains: createRemediationChains(),
    chainLog: createRemediationChainLog({
      context: createProcessReviewHistoryContext(),
      fileSystem: createNodeReviewHistoryFileSystem(),
      now: () => new Date(),
    }),
  };
}

/**
 * Composes the runtime dependencies for one setup at the composition root. The
 * project root is the canonical project directory; logs go to the host's stderr
 * capture; the server context has no toast or TUI routing, so both are no-ops.
 */
export function createPluginDependencies(
  context: Plugin.Context,
  settingsOf = createOpenCodeRemediationSettings(),
): PluginRuntimeDependencies {
  const root = context.location.project.canonical;
  const writer = createConsoleLogWriter();
  const toast = createNullToastSink();
  const operational = createOperationalLogSink(writer);
  const history = createLocalReviewHistory({
    context: createProcessReviewHistoryContext(),
    fileSystem: createNodeReviewHistoryFileSystem(),
    now: () => new Date(),
  });

  return {
    tracker: createTurnTracker({
      facade: createOpenCodeSessionFacade(context, root),
      deduplicator: new InMemoryTurnDeduplicator(),
    }),
    operational,
    remediation: remediationSetupOf(context, root, operational, settingsOf),
    policy: createPolicyFileLoader({ root, fileSystem: createNodePolicyFileSystem() }),
    presenter: createReviewPresenter({
      log: createMirroredReviewLogSink(createOpenCodeLogSink(writer), history),
      toast,
    }),
    jev: createDefaultJevPort(),
    proposals: createRemediationProposalStore(),
    proposalFacade: createOpenCodeProposalSessionFacade(context),
    navigator: createNullSessionNavigator(),
    notifier: createRemediationNotifier(toast),
    failures: createRemediationFailureLogSink(writer),
    childExecutions: createChildExecutionWatcher(),
    proposalTimeoutMs: PROPOSAL_TIMEOUT_MS,
  };
}

/**
 * Wires a runtime into the host: the proposer retry guard, write-tool path tracking,
 * the bundled skills, and the lifecycle event loop. Returns the cleanup, which stops
 * the loop, drains briefly, disposes every registration, and never throws.
 */
export async function startPlugin(
  context: Plugin.Context,
  dependencies: PluginRuntimeDependencies,
  skillDirectories: readonly string[],
): Promise<{ readonly runtime: PluginRuntime; readonly cleanup: () => Promise<void> }> {
  const root = context.location.project.canonical;
  const runtime = createPluginRuntime(dependencies);
  const abort = new AbortController();
  const registrations: Registration[] = [];

  async function register(work: () => Promise<Registration>): Promise<void> {
    try {
      registrations.push(await work());
    } catch {
      return;
    }
  }

  await register(() =>
    registerProposalRetryGuard(context, (sessionID) =>
      dependencies.proposals.isChildSession(sessionID),
    ),
  );
  await register(() =>
    // Every write-tool call counts, whatever its status (plan §10.2).
    context.tool.hook("execute.after", (event) => {
      for (const path of writtenPaths(event.tool, event.input, root)) {
        dependencies.tracker.recordWrite(event.sessionID, path);
      }
    }),
  );
  await register(async () => registerSkills(context, await readBundledSkills(skillDirectories)));

  const loop = consumeEvents(context, runtime, abort.signal);

  return {
    runtime,
    async cleanup() {
      abort.abort();

      try {
        await Promise.race([Promise.all([loop, runtime.drain()]), delay(SHUTDOWN_DRAIN_MS)]);
      } catch {
        // Shutdown never throws into the host.
      }

      await Promise.all(
        registrations.map((registration) => registration.dispose().catch(() => undefined)),
      );
    },
  };
}

async function consumeEvents(
  context: Plugin.Context,
  runtime: PluginRuntime,
  signal: AbortSignal,
): Promise<void> {
  try {
    for await (const event of context.event.subscribe({ types: [...TURN_EVENT_TYPES], signal })) {
      runtime.onEvent(event);
    }
  } catch {
    return;
  }
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, ms).unref?.();
  });
}

/**
 * OpenCode 2.2.x server plugin. Each completed execution is reviewed detached from the
 * agent: findings go to the log. In observe (the default), a `FAIL` the project's `.jev`
 * allows prepares one proposal in a deny-all child session. Only when the user's own
 * `opencode.yaml` opts into `remediate` is one visible remediation message queued into the
 * originating session per attempt, under the core's anti-loop chain. Nothing is applied.
 */
const plugin: Plugin.Plugin = {
  id: PLUGIN_ID,
  async setup(context) {
    const { cleanup } = await startPlugin(
      context,
      createPluginDependencies(context),
      resolveInstalledSkillDirectories(import.meta.url),
    );

    return cleanup;
  },
};

export default plugin;
