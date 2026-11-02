import { spawnSync } from "node:child_process";

/** The supported OpenCode line: one minor release, from a minimum patch. */
const SUPPORTED = { major: 2, minor: 2, minimumPatch: 2 } as const;

/** OpenCode releases the plugin supports; a test pins it to `engines.opencode`. */
export const OPENCODE_ENGINE_RANGE = `>=${SUPPORTED.major}.${SUPPORTED.minor}.${SUPPORTED.minimumPatch} <${SUPPORTED.major}.${SUPPORTED.minor + 1}`;

const VERSION_PATTERN = /(\d+)\.(\d+)\.(\d+)(-[0-9A-Za-z.-]+)?/;
const VERSION_TIMEOUT_MS = 5_000;

export type OpenCodeVersionVerdict =
  | { readonly status: "SUPPORTED" | "UNSUPPORTED"; readonly version: string }
  | { readonly status: "UNKNOWN" };

/**
 * Classifies the output of `opencode --version` against {@link OPENCODE_ENGINE_RANGE}.
 * A pre-release is unsupported, as semver ranges exclude it; no readable version is
 * `UNKNOWN`.
 */
export function checkOpenCodeVersion(output: string | null): OpenCodeVersionVerdict {
  const match = output === null ? null : VERSION_PATTERN.exec(output);

  if (match === null) return { status: "UNKNOWN" };

  const [version, major, minor, patch, prerelease] = match;
  const supported =
    prerelease === undefined &&
    Number(major) === SUPPORTED.major &&
    Number(minor) === SUPPORTED.minor &&
    Number(patch) >= SUPPORTED.minimumPatch;

  return { status: supported ? "SUPPORTED" : "UNSUPPORTED", version };
}

/**
 * Runs `opencode --version` from `PATH` and returns its output, or `null` when the
 * command is missing, fails, or times out. It never throws.
 */
export function readInstalledOpenCodeVersion(): string | null {
  try {
    const result = spawnSync("opencode", ["--version"], {
      encoding: "utf8",
      timeout: VERSION_TIMEOUT_MS,
      windowsHide: true,
      // `opencode` is a `.cmd` shim on Windows; the arguments are fixed.
      shell: process.platform === "win32",
    });

    return result.status === 0 ? result.stdout : null;
  } catch {
    return null;
  }
}
