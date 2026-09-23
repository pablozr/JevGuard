import type { TuiPlugin, TuiPluginModule } from "@opencode-ai/plugin/tui";
import { readCommandText } from "./bridge";
import { createHostDependencies } from "./host";
import { createRemediationWorkflow } from "./workflow";

/**
 * OpenCode TUI target for JevGuard remediation. It consumes only the internal
 * `tui.command.execute` bridge command emitted by the server plugin, recovers the
 * attributed turn, proposes a strategy through a confirmation dialog, and applies it
 * only after explicit approval. It is a separate, target-exclusive module: the
 * default export is the TUI plugin object and it never exports the server plugin.
 */
const tui: TuiPlugin = async (api) => {
  const workflow = createRemediationWorkflow(createHostDependencies(api));

  const unsubscribe = api.event.on("tui.command.execute", (event) => {
    const command = readCommandText(event);

    if (command !== null) {
      void workflow.handleCommand(command);
    }
  });

  api.lifecycle.onDispose(() => {
    unsubscribe();
  });
};

const plugin: TuiPluginModule & { readonly id: string } = { id: "jevguard", tui };

export default plugin;
