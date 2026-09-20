import type { ReviewResult } from "@jevguard/core";
import type { ReviewPresenter } from "@jevguard/opencode-adapter";

/**
 * Delivers one review result without letting a presentation failure reject the
 * caller, retry the review, or replace the result.
 */
export async function presentResult(
  presenter: ReviewPresenter,
  result: ReviewResult,
): Promise<void> {
  try {
    await presenter.present(result);
  } catch {
    return;
  }
}
