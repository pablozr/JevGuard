export { OPENCODE_CONFIG_FILE_NAME } from "./constants";
export {
  addPluginEntry,
  createDefaultConfigDocument,
  findPluginEntries,
  findPluginEntry,
  JEVGUARD_PLUGIN_ENTRY,
  JEVGUARD_PLUGIN_SPEC,
  JEVGUARD_PLUGIN_VERSION,
  type PluginEntryMatch,
  pluginPackageOf,
  pluginVersionOf,
} from "./entry";
export {
  createConfigFileSystem,
  createNodeConfigFileSystem,
  createNodePluginCacheFileSystem,
} from "./file-system";
export { inspectInstall } from "./inspect";
export { install } from "./install";
export { resolveConfigPath } from "./paths";
export {
  cacheDirNameOf,
  type PluginCacheFileSystem,
  type PluginResolution,
  type PluginResolutionDependencies,
  type PluginResolutionReason,
  resolveCachedPlugin,
} from "./resolution";
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
  PluginEntryLookup,
  PluginEntryMutation,
} from "./types";
export {
  checkOpenCodeVersion,
  OPENCODE_ENGINE_RANGE,
  OPENCODE_LATEST_SUPPORTED,
  OPENCODE_PIN_COMMAND,
  type OpenCodeVersionVerdict,
} from "./version";
