import { writeSync } from "node:fs";

/**
 * The one place a hook may write to stdout: the documented `Stop` decision that holds
 * the turn (ADR 0022, decision 5). It is synchronous, so the decision is out before the
 * process exits, and a failure is contained — a decision that cannot be printed is a
 * turn that simply ends, never a crash.
 */
export function writeDecisionOutput(text: string): boolean {
  try {
    writeSync(1, `${text}\n`);

    return true;
  } catch {
    return false;
  }
}
