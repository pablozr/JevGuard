import { parseVersion, satisfiesRange } from "@jevguard/node-infra";

/** The supported OpenCode line: one minor release, from a minimum patch. */
const SUPPORTED = { major: 2, minor: 2, minimumPatch: 2 } as const;

/** OpenCode releases the plugin supports; a test pins it to `engines.opencode`. */
export const OPENCODE_ENGINE_RANGE = `>=${SUPPORTED.major}.${SUPPORTED.minor}.${SUPPORTED.minimumPatch} <${SUPPORTED.major}.${SUPPORTED.minor + 1}`;

export type OpenCodeVersionVerdict =
  | { readonly status: "SUPPORTED" | "UNSUPPORTED"; readonly version: string }
  | { readonly status: "UNKNOWN" };

/**
 * Classifies the output of `opencode --version` against {@link OPENCODE_ENGINE_RANGE}.
 * A pre-release is unsupported, as semver ranges exclude it; no readable version is
 * `UNKNOWN`.
 */
export function checkOpenCodeVersion(output: string | null): OpenCodeVersionVerdict {
  const version = parseVersion(output);

  if (version === null) return { status: "UNKNOWN" };

  const supported = satisfiesRange(version, OPENCODE_ENGINE_RANGE);

  return { status: supported ? "SUPPORTED" : "UNSUPPORTED", version: version.raw };
}
