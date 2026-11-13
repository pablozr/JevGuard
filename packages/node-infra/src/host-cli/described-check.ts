import type { DescribedCheck } from "./types";

/** One doctor message with an optional annotation. */
export function checkLine(message: string, annotation: string | null = null): DescribedCheck {
  return { message, annotation };
}

/** The annotation form used by every doctor hint. */
export function checkHint(text: string): string {
  return `hint: ${text}`;
}
