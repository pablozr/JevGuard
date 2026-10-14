import { readFileSync } from "node:fs";
import { parsePolicyConfig } from "@jevguard/node-infra";
import { createNodeFileReader, isMissingPathError } from "../../capture/node-ports";
import { projectProbeOf } from "./containment";
import { loadClaudeRemediationSettings, userConfigFileOf } from "./settings";
import type { ClaudeRemediationSettingsResult } from "./types";

function orNullWhenMissing<T>(read: () => T): T | null {
  try {
    return read();
  } catch (error) {
    if (isMissingPathError(error)) return null;

    throw error;
  }
}

/**
 * Resolves the user's remediation settings for one project from the real file system.
 * The answer is remembered per project for the life of this worker process.
 */
export function createUserRemediationSettings(environment: {
  get(name: string): string | undefined;
}): (projectRoot: string) => ClaudeRemediationSettingsResult {
  const file = userConfigFileOf({
    xdgConfigHome: environment.get("XDG_CONFIG_HOME"),
    userProfile: environment.get("USERPROFILE"),
    home: environment.get("HOME"),
  });
  const probe = projectProbeOf(createNodeFileReader());
  const remembered = new Map<string, ClaudeRemediationSettingsResult>();

  function load(projectRoot: string): ClaudeRemediationSettingsResult {
    if (file === null) return { status: "DISABLED" };

    return loadClaudeRemediationSettings({
      file,
      projectRoot,
      readText: (path) => orNullWhenMissing(() => readFileSync(path, "utf8")),
      realPath: probe.realPath,
      hasGitMarker: probe.hasGitMarker,
      parse: (text) => {
        const parsed = parsePolicyConfig(text);

        return parsed.status === "PARSED"
          ? { status: "PARSED", value: parsed.value }
          : { status: "INVALID" };
      },
    });
  }

  return (projectRoot) => {
    const known = remembered.get(projectRoot);

    if (known !== undefined) return known;

    const loaded = load(projectRoot);

    remembered.set(projectRoot, loaded);

    return loaded;
  };
}
