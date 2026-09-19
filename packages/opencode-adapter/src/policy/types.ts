import type { PolicySource } from "@jevguard/core";

export type PolicyLoadFailureReason = "RULES_READ_FAILURE" | "CONFIG_READ_FAILURE";

/**
 * Result of reading the fixed `.jev` policy paths. `LOADED` carries `null` for an
 * absent file; any non-ENOENT I/O failure is `FAILED` and is never treated as an
 * absent file.
 */
export type PolicyLoadResult =
  | { readonly status: "LOADED"; readonly source: PolicySource }
  | { readonly status: "FAILED"; readonly reason: PolicyLoadFailureReason };

export interface PolicyFileSystem {
  readFile(path: string): Promise<string>;
}

export interface PolicyLoaderDependencies {
  readonly root: string;
  readonly fileSystem: PolicyFileSystem;
}

export interface PolicyLoader {
  load(): Promise<PolicyLoadResult>;
}

export type ConfigParseFailureReason = "INVALID_CONFIG";

/**
 * Result of safely parsing optional `.jev/config.yaml` text. `PARSED` yields an
 * untyped value for the core validator; `INVALID` means the YAML itself was unsafe
 * or malformed.
 */
export type ConfigParseResult =
  | { readonly status: "PARSED"; readonly value: unknown }
  | { readonly status: "INVALID"; readonly reason: ConfigParseFailureReason };
