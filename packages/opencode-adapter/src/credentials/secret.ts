/**
 * Returns the trimmed secret, or `null` when the value is absent or
 * whitespace-only. A blank environment value never overrides a stored credential.
 */
export function normalizeSecret(value: string | undefined): string | null {
  if (value === undefined) {
    return null;
  }

  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : null;
}
