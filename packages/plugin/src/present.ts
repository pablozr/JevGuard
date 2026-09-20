import type { TurnReview } from "@jevguard/core";
import type { ReviewPresenter } from "@jevguard/opencode-adapter";

/**
 * Delivers one aggregate turn review without letting a presentation failure reject
 * the caller, retry the review, or replace the review.
 */
export async function presentReview(presenter: ReviewPresenter, review: TurnReview): Promise<void> {
  try {
    await presenter.present(review);
  } catch {
    return;
  }
}
