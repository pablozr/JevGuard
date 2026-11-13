export { OPENCODE_CONFIG_FILE_NAME } from "./constants";
export { addPluginEntry, createDefaultConfigDocument, JEVGUARD_PLUGIN_ENTRY } from "./entry";
export { createConfigFileSystem, createNodeConfigFileSystem } from "./file-system";
export { inspectInstall } from "./inspect";
export { install } from "./install";
export { resolveConfigPath } from "./paths";
export type {
  ConfigFileSystem,
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
export {
  checkOpenCodeVersion,
  OPENCODE_ENGINE_RANGE,
  type OpenCodeVersionVerdict,
} from "./version";
