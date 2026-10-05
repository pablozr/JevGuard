import type { Budget } from "./types";

/** Thrown by capture steps that find the hook's wall-clock allowance spent. */
export class BudgetExceededError extends Error {
  constructor() {
    super("HOOK_BUDGET_EXCEEDED");
  }
}

export function createBudget(monotonicNow: () => number, limitMs: number): Budget {
  const deadline = monotonicNow() + limitMs;

  return {
    expired: () => monotonicNow() >= deadline,
    remainingMs: () => Math.max(0, deadline - monotonicNow()),
  };
}

export const UNLIMITED_BUDGET: Budget = {
  expired: () => false,
  remainingMs: () => Number.POSITIVE_INFINITY,
};

export function assertWithinBudget(budget: Budget): void {
  if (budget.expired()) throw new BudgetExceededError();
}
