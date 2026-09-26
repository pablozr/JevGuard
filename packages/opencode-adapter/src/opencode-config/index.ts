export { createConfirmationPrompt } from "./confirmation";
export { addPluginEntry, createDefaultConfigDocument, JEVGUARD_PLUGIN_ENTRY } from "./entry";
export { createNodeConfigFileSystem } from "./file-system";
export { install } from "./install";
export { resolveConfigPath } from "./paths";
export type {
  ConfigFileSystem,
  ConfirmationPrompt,
  ConfirmationResult,
  InstallDependencies,
  InstallFailureReason,
  InstallOutcome,
  InstallPathContext,
  InstallTarget,
  PluginEntryMutation,
} from "./types";
