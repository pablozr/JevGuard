import type { TurnReview } from "@jevguard/core";
import type { PresentationDelivery, ReviewPresenter } from "../index";

/**
 * Delivery reported to a caller that is no longer there. A unit closed by `abandon` has
 * already been presented as `REVIEW_INTERRUPTED`; the caller that receives this value
 * must drop its work, so the unit never carries two lines.
 */
export const DROPPED_DELIVERY: PresentationDelivery = { log: "DELIVERED", toast: "DELIVERED" };

/**
 * Delivers one aggregate turn review without letting a presentation failure reject
 * the caller, retry the review, or replace the review. The delivery travels back so the
 * caller can tell a dropped one from a real one; `null` means presentation threw.
 */
export async function presentReview(
  presenter: ReviewPresenter,
  review: TurnReview,
): Promise<PresentationDelivery | null> {
  try {
    return await presenter.present(review);
  } catch {
    return null;
  }
}
