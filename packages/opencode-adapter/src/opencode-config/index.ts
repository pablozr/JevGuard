export { createConfirmationPrompt } from "./confirmation";
export { addPluginEntry, createDefaultConfigDocument, JEVGUARD_PLUGIN_ENTRY } from "./entry";
export { createNodeConfigFileSystem } from "./file-system";
export { inspectInstall } from "./inspect";
export { install } from "./install";
export { resolveConfigPath } from "./paths";
export type {
  ConfigFileSystem,
  ConfirmationPrompt,
  ConfirmationResult,
  InspectInstallDependencies,
  InstallDependencies,
  InstallFailureReason,
  InstallInspection,
  InstallInspectionFailureReason,
  InstallOutcome,
  InstallPathContext,
  InstallTarget,
  PluginEntryMutation,
} from "./types";
