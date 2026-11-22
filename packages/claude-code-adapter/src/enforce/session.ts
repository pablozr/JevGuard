import type { EnforceSession } from "./types";

/**
 * The flag the host computes for the session and sets in the environment of every process
 * it starts, hooks included: `"1"` when the session is attended by a person, `"0"` when it
 * is not. It is the same value the host derives for its own children, so the hook reads
 * the host's own answer instead of guessing from a terminal or a permission mode that a
 * headless run can carry too.
 */
export const SESSION_ATTENDED_ENV = "CLAUDE_CODE_SESSION_ATTENDED";

/** How the host names the surface that started the session (`cli`, `sdk-cli`, ...). */
export const SESSION_ENTRYPOINT_ENV = "CLAUDE_CODE_ENTRYPOINT";

/** Entrypoints driven by a program, never by a person at a prompt. */
const HEADLESS_ENTRYPOINTS: readonly string[] = ["sdk-cli", "sdk-ts", "sdk-py"];

/** The part of the environment the detector reads; tests substitute a fake. */
export interface EnforceEnvironment {
  get(name: string): string | undefined;
}

/**
 * Classifies the session from what the host positively said, never from what a run looks
 * like: only `"1"` from a non-headless entrypoint is `INTERACTIVE`, `"0"` is
 * `NON_INTERACTIVE`, and anything else — absent, empty, another value, or `"1"` next to a
 * headless entrypoint — is `UNKNOWN`. The design treats `UNKNOWN` as non-interactive, so a
 * run the hook cannot classify never blocks (ADR 0022, decision 4).
 */
export function detectSession(environment: EnforceEnvironment): EnforceSession {
  const attended = environment.get(SESSION_ATTENDED_ENV);

  if (attended === undefined || attended === "") return "UNKNOWN";
  if (attended === "0") return "NON_INTERACTIVE";
  if (attended !== "1") return "UNKNOWN";

  const entrypoint = environment.get(SESSION_ENTRYPOINT_ENV);

  if (entrypoint !== undefined && HEADLESS_ENTRYPOINTS.includes(entrypoint)) return "UNKNOWN";

  return "INTERACTIVE";
}
