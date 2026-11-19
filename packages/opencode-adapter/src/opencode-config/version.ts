import { parseVersion, satisfiesRange } from "@jevguard/node-infra";

/**
 * The supported OpenCode lines: 2.2 from patch 2 through 2.3, whose plugin API only
 * adds to the 2.2 one.
 */
const SUPPORTED = { major: 2, firstMinor: 2, minimumPatch: 2, lastMinor: 3 } as const;

/** OpenCode releases the plugin supports; a test pins it to `engines.opencode`. */
export const OPENCODE_ENGINE_RANGE = `>=${SUPPORTED.major}.${SUPPORTED.firstMinor}.${SUPPORTED.minimumPatch} <${SUPPORTED.major}.${SUPPORTED.lastMinor + 1}`;

/** The newest supported line, named when the installed host is outside the range. */
export const OPENCODE_LATEST_SUPPORTED = `${SUPPORTED.major}.${SUPPORTED.lastMinor}.x`;

/** Pins the newest supported line; names an install that works on every host. */
export const OPENCODE_PIN_COMMAND = `npm install --global @opencode/cli@${SUPPORTED.major}.${SUPPORTED.lastMinor}`;

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
