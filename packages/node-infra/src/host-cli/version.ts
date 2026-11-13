const VERSION_PATTERN = /(\d+)\.(\d+)\.(\d+)(-[0-9A-Za-z.-]+)?/;
const COMPARATOR_PATTERN = /^(>=|<=|>|<|=)?(\d+)(?:\.(\d+))?(?:\.(\d+))?$/;

export interface ParsedVersion {
  /** The matched version text, pre-release included. */
  readonly raw: string;
  readonly major: number;
  readonly minor: number;
  readonly patch: number;
  readonly prerelease: boolean;
}

type Triplet = Pick<ParsedVersion, "major" | "minor" | "patch">;

/** Finds the first `major.minor.patch[-pre]` in a command's output, or `null`. */
export function parseVersion(output: string | null): ParsedVersion | null {
  const match = output === null ? null : VERSION_PATTERN.exec(output);

  if (match === null) return null;

  const [raw, major, minor, patch, prerelease] = match;

  return {
    raw,
    major: Number(major),
    minor: Number(minor),
    patch: Number(patch),
    prerelease: prerelease !== undefined,
  };
}

/** Negative when `left` is lower, positive when higher, zero when equal. Pre-release is ignored. */
export function compareVersions(left: Triplet, right: Triplet): number {
  return left.major - right.major || left.minor - right.minor || left.patch - right.patch;
}

/**
 * Checks a version against space-separated comparators such as `>=2.2.2 <2.3`; missing
 * parts count as zero. A pre-release never satisfies a range, as semver ranges exclude it.
 */
export function satisfiesRange(version: ParsedVersion, range: string): boolean {
  if (version.prerelease) return false;

  return range
    .trim()
    .split(/\s+/)
    .every((comparator) => satisfiesComparator(version, comparator));
}

function satisfiesComparator(version: Triplet, comparator: string): boolean {
  const match = COMPARATOR_PATTERN.exec(comparator);

  if (match === null) return false;

  const [, operator = "=", major, minor, patch] = match;
  const bound = { major: Number(major), minor: Number(minor ?? 0), patch: Number(patch ?? 0) };
  const order = compareVersions(version, bound);

  switch (operator) {
    case ">=":
      return order >= 0;
    case "<=":
      return order <= 0;
    case ">":
      return order > 0;
    case "<":
      return order < 0;
    default:
      return order === 0;
  }
}
