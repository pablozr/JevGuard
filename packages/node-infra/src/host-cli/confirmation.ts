import { createInterface } from "node:readline/promises";
import type { ConfirmationPrompt, ConfirmationResult } from "./types";

/**
 * Interactive `y/N` confirmation on the terminal. It refuses off a TTY and treats
 * any answer other than an explicit yes — or a read error — as a decline.
 */
export function createConfirmationPrompt(): ConfirmationPrompt {
  return {
    confirm: askForConfirmation,
  };
}

async function askForConfirmation(message: string): Promise<ConfirmationResult> {
  if (process.stdin.isTTY !== true) {
    return { status: "FAILED", reason: "NOT_A_TTY" };
  }

  try {
    const readline = createInterface({ input: process.stdin, output: process.stdout });

    try {
      const answer = await readline.question(`${message} [y/N] `);

      return isAffirmative(answer) ? { status: "CONFIRMED" } : { status: "DECLINED" };
    } finally {
      readline.close();
    }
  } catch {
    return { status: "DECLINED" };
  }
}

function isAffirmative(answer: string): boolean {
  const normalized = answer.trim().toLowerCase();

  return normalized === "y" || normalized === "yes";
}
