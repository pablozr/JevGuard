import { join } from "node:path";
import {
  type HostCheckStatus,
  type HostCliContext,
  type HostDoctorCheck,
  versionDoctorCheck,
} from "@jevguard/node-infra";
import { JEVGUARD_PLUGIN_VERSION } from "../opencode-config/entry";
import {
  createConfigFileSystem,
  createNodePluginCacheFileSystem,
} from "../opencode-config/file-system";
import { inspectInstall } from "../opencode-config/inspect";
import {
  type PluginCacheFileSystem,
  type PluginResolution,
  resolveCachedPlugin,
} from "../opencode-config/resolution";
import type { InstallInspection, InstallTarget } from "../opencode-config/types";
import { OPENCODE_COMMAND } from "./constants";
import { detectOpenCode } from "./detect";
import { describeOpenCodePlugin, describeOpenCodeRuntime } from "./doctor-messages";
import { pathContext } from "./path-context";
import type { OpenCodePluginCheckCode, OpenCodeRuntimeCheckCode } from "./types";

const TARGETS: readonly InstallTarget[] = ["global", "project"];

type RegisteredInspection = Extract<InstallInspection, { status: "REGISTERED" }>;

/** `~/.cache/opencode/npm`: where the host installs package plugins on every platform. */
const CACHE_SUBPATH = [".cache", "opencode", "npm"] as const;

export interface OpenCodeDoctorDependencies {
  /** The host's plugin cache; tests inject a fake, the CLI uses Node. */
  readonly pluginCacheFileSystem?: PluginCacheFileSystem;
}

export async function openCodeDoctorChecks(
  context: HostCliContext,
  dependencies: OpenCodeDoctorDependencies = {},
): Promise<readonly HostDoctorCheck[]> {
  const fileSystem = dependencies.pluginCacheFileSystem ?? createNodePluginCacheFileSystem();
  const [targets, detection] = await Promise.all([
    inspectTargets(context),
    detectOpenCode(context),
  ]);
  const runtime = await runtimeCheck(targets, context, fileSystem);

  return [
    pluginCheck(targets),
    runtime,
    versionDoctorCheck(detection, {
      id: "opencode-version",
      displayName: "OpenCode",
      command: OPENCODE_COMMAND,
    }),
  ];
}

function inspectTargets(context: HostCliContext): Promise<readonly InstallInspection[]> {
  const fileSystem = createConfigFileSystem(context.files);

  return Promise.all(
    TARGETS.map((target) => inspectInstall({ ...pathContext(context), target, fileSystem })),
  );
}

function registered(targets: readonly InstallInspection[]): readonly RegisteredInspection[] {
  return targets.filter((target): target is RegisteredInspection => target.status === "REGISTERED");
}

/**
 * A registered entry only counts as a healthy setup when it pins the version this CLI
 * knows; an unpinned entry makes the host resolve `@latest`, which the doctor must not
 * report as OK.
 */
function pluginCode(targets: readonly InstallInspection[]): OpenCodePluginCheckCode {
  if (targets.some((target) => target.status === "FAILED")) {
    return "INSPECTION_FAILED";
  }

  const entries = registered(targets);

  if (entries.length === 0) {
    return "NOT_REGISTERED";
  }

  if (entries.every((entry) => entry.pin === JEVGUARD_PLUGIN_VERSION)) {
    return "REGISTERED";
  }

  return entries.some((entry) => entry.pin !== null) ? "PIN_MISMATCH" : "PIN_MISSING";
}

function pluginCheck(targets: readonly InstallInspection[]): HostDoctorCheck {
  const code = pluginCode(targets);
  const status: HostCheckStatus = code === "REGISTERED" ? "OK" : "WARN";
  const described = describeOpenCodePlugin(code, targets);

  return {
    json: { id: "opencode-plugin", status, code, targets },
    message: described.message,
    annotation: described.annotation,
  };
}

async function runtimeCheck(
  targets: readonly InstallInspection[],
  context: HostCliContext,
  fileSystem: PluginCacheFileSystem,
): Promise<HostDoctorCheck> {
  const specs = targets.flatMap((target) =>
    target.status === "REGISTERED" ? [...new Set(target.specs)] : [],
  );

  if (specs.length === 0) {
    const described = describeOpenCodeRuntime("NOT_REGISTERED", null);

    return {
      json: { id: "opencode-plugin-runtime", status: "WARN", code: "NOT_REGISTERED" },
      message: described.message,
      annotation: described.annotation,
    };
  }

  const cacheRoot = join(context.homedir, ...CACHE_SUBPATH);
  const resolutions = await Promise.all(
    specs.map((spec) => resolveCachedPlugin({ cacheRoot, spec, fileSystem })),
  );
  const code = runtimeCode(resolutions);
  const resolution =
    resolutions.find((candidate) => candidate.status !== "RESOLVED") ?? resolutions[0] ?? null;
  const described = describeOpenCodeRuntime(code, resolution);

  return {
    json: {
      id: "opencode-plugin-runtime",
      status: runtimeStatus(code),
      code,
      ...runtimeFields(resolution),
    },
    message: described.message,
    annotation: described.annotation,
  };
}

/**
 * The worst resolution: an entry the host cannot read or that holds another version
 * outranks one that is merely absent from the cache. `RESOLVED` needs every entry.
 */
function runtimeCode(resolutions: readonly PluginResolution[]): OpenCodeRuntimeCheckCode {
  if (resolutions.some((resolution) => resolution.status === "UNREADABLE")) return "UNREADABLE";
  if (resolutions.some((resolution) => resolution.status === "VERSION_MISMATCH"))
    return "VERSION_MISMATCH";
  if (resolutions.some((resolution) => resolution.status === "NOT_CACHED")) return "NOT_CACHED";
  if (resolutions.some((resolution) => resolution.status === "UNSUPPORTED")) return "UNSUPPORTED";
  if (divergentVersions(resolutions)) return "DIVERGENT_ENTRIES";

  return "RESOLVED";
}

/**
 * Every registered occurrence must agree on one version: two entries of the same
 * package pinning different versions are two live registrations, and the host reads
 * both, so resolving one of them does not prove the runtime.
 */
function divergentVersions(resolutions: readonly PluginResolution[]): boolean {
  const versions = new Set(
    resolutions.flatMap((resolution) =>
      resolution.status === "RESOLVED" ? [resolution.version] : [],
    ),
  );

  return versions.size > 1;
}

function runtimeStatus(code: OpenCodeRuntimeCheckCode): HostCheckStatus {
  return code === "RESOLVED" ? "OK" : "WARN";
}

/** Only the resolved package and version reach the report; never a cache path. */
function runtimeFields(resolution: PluginResolution | null): Readonly<Record<string, unknown>> {
  if (resolution === null) return {};

  const fields: Record<string, unknown> = { package: resolution.package };

  if ("version" in resolution) fields.version = resolution.version;
  if (resolution.status === "VERSION_MISMATCH") fields.pin = resolution.pin;

  return fields;
}
