import { fileExtension, pathBasename, pathSegments } from "./paths";
import type { EvidencePolicy, PathSafety } from "./types";

const DENIED_SENSITIVE: PathSafety = { allowed: false, reason: "DENIED_SENSITIVE_PATH" };
const DENIED_EXTENSION: PathSafety = { allowed: false, reason: "EXTENSION_NOT_ALLOWED" };

/**
 * Decides whether one path may leave the machine. Matching is case-insensitive on
 * both Windows and POSIX separators; a path with no allowlisted extension is
 * rejected rather than assumed textual.
 */
export function checkFilePath(path: string, policy: EvidencePolicy): PathSafety {
  const basename = pathBasename(path).toLowerCase();

  if (matchesDeniedFileName(basename, policy)) {
    return DENIED_SENSITIVE;
  }

  const segments = pathSegments(path).map((segment) => segment.toLowerCase());

  if (segments.some((segment) => policy.deniedDirectoryNames.includes(segment))) {
    return DENIED_SENSITIVE;
  }

  const extension = fileExtension(path);

  if (policy.deniedExtensions.includes(extension)) {
    return DENIED_SENSITIVE;
  }

  if (!policy.allowedExtensions.includes(extension)) {
    return DENIED_EXTENSION;
  }

  return { allowed: true };
}

function matchesDeniedFileName(basename: string, policy: EvidencePolicy): boolean {
  return policy.deniedFileNames.some((name) =>
    name.startsWith(".") ? basename === name || basename.startsWith(`${name}.`) : basename === name,
  );
}
