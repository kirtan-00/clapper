// The launch offer, and the only place its cap is enforced.
//
// NEW 2026-08-27: `jumpstart_5`, INR 100 for 5 project credits, for the FIRST
// TEN PEOPLE ONLY, one each. That is 5 credits for the price of a seventh of
// one, so the cap is not decoration - it is the whole product. A promo that
// silently kept selling would be the most expensive bug this codebase could
// ship, because every over-sale looks exactly like a successful purchase.
//
// NO MIGRATION. The cap is derived from two tables that already exist:
//
//   purchases  - money that actually moved. The authoritative claim count.
//   events     - `checkout_started`, written by razorpay-order before the
//                modal opens. Used as a SOFT, EXPIRING reservation.
//
// WHY A SOFT RESERVATION AT ALL. `purchases` rows are only written when money
// moves, so counting them alone leaves a real race: thirty people could each
// open checkout while the count still reads zero, and every one of them would
// pay. Counting `checkout_started` closes that window without a new table and
// without a lock. It EXPIRES (see RESERVATION_MINUTES) because the opposite
// failure matters too: somebody who opens the modal and wanders off must not
// hold a slot forever, or ten idle taps kill the offer for everybody.
//
// SO THE COUNT IS DELIBERATELY APPROXIMATE, and it errs toward refusing a
// borderline eleventh buyer rather than accepting them. That is the right
// direction: a refused buyer sees "the offer has gone" and can still buy at
// list price. An over-sold buyer has already been charged.
//
// THE GRANT PATH DOES NOT ENFORCE THIS. razorpay-webhook grants whatever a
// paid order says it bought, cap or no cap. If the race above ever does let
// an eleventh payment through, the person gets their five credits and the
// over-sale is logged for a human. Taking somebody's money and then refusing
// to deliver because of our own counter is not a trade-off worth making.

// NOT `import type { SupabaseClient } from "jsr:@supabase/supabase-js@2"`,
// which is what store.ts does. This module is imported by
// src/net/promo.test.ts so the cap can be tested, and that drags it into the
// APP's tsconfig, where a `jsr:` specifier does not resolve. store.ts gets
// away with it only because nothing under src/ imports store.ts. The same
// reasoning is why suspension.ts in this directory already types its client
// loosely.
//
// The cost is real and worth naming: this file gets no type checking on the
// query chain, so a typo in a column name is a runtime bug, not a compile
// error. That is exactly why every query below is covered by a test with a
// hand written double rather than trusted to the compiler.
// deno-lint-ignore-file no-explicit-any
type PromoDb = any;

/** The catalogue key. Must match _shared/products.ts. */
export const PROMO_PRODUCT_KEY = "jumpstart_5";

/** How many people may ever claim it. */
export const PROMO_SLOTS = 10;

/** How long an opened checkout holds a slot. Long enough to find a card or
 *  approve a UPI request without hurrying, short enough that an abandoned
 *  tap frees up inside one sitting. */
const RESERVATION_MINUTES = 20;

export interface PromoState {
  /** Slots left, floored at 0. Approximate by design - see the header. */
  remaining: number;
  /** True when THIS user has already claimed it. A one-per-account promo,
   *  so this is checked separately from the global count. */
  alreadyClaimed: boolean;
  /** False when the offer is gone or this user has had theirs. */
  eligible: boolean;
}

/**
 * Read the promo's state for one user. Never throws: an unreadable table
 * resolves to "no slots left", because refusing to sell a 96%-off product
 * we cannot count is the safe direction. The caller can always fall back to
 * list price.
 */
export async function readPromoState(
  admin: PromoDb,
  userId: string,
): Promise<PromoState> {
  const gone: PromoState = { remaining: 0, alreadyClaimed: false, eligible: false };

  try {
    // 1. Money that moved. One row per claim, whatever status it landed at:
    // a purchase recorded as needs-attention still took the person's money
    // and still has to count against the ten.
    const { data: paid, error: paidErr } = await admin
      .from("purchases")
      .select("user_id")
      .eq("product_key", PROMO_PRODUCT_KEY);
    if (paidErr) {
      console.error("promo: could not read purchases", paidErr.message);
      return gone;
    }

    const claimants = new Set<string>();
    for (const row of paid ?? []) {
      const id = (row as { user_id: string | null }).user_id;
      if (id) claimants.add(id);
    }
    const alreadyClaimed = claimants.has(userId);

    // 2. Checkouts opened recently and not yet paid. Soft reservations.
    const since = new Date(Date.now() - RESERVATION_MINUTES * 60_000).toISOString();
    const { data: started, error: startedErr } = await admin
      .from("events")
      .select("user_id")
      .eq("name", "checkout_started")
      .eq("props->>product", PROMO_PRODUCT_KEY)
      .gte("created_at", since);
    if (startedErr) {
      // NOT fatal, unlike the purchases read. Losing the reservation half
      // only widens the race back to what it would be without it; losing the
      // paid half would mean not knowing how many were sold at all.
      console.error("promo: could not read reservations", startedErr.message);
    }
    for (const row of started ?? []) {
      const id = (row as { user_id: string | null }).user_id;
      if (id) claimants.add(id);
    }

    // A person holding their own reservation must not be counted as blocking
    // themselves: they are mid-purchase, not a competitor for the last slot.
    // Without this, opening the modal would immediately make you ineligible
    // to complete the very purchase you just started.
    const others = claimants.size - (claimants.has(userId) ? 1 : 0);
    const remaining = Math.max(0, PROMO_SLOTS - claimants.size);

    return {
      remaining,
      alreadyClaimed,
      eligible: !alreadyClaimed && others < PROMO_SLOTS,
    };
  } catch (e) {
    console.error("promo: state read threw", e);
    return gone;
  }
}

/** True when this key is the capped launch offer. Kept as a function rather
 *  than an inline comparison so razorpay-order cannot drift from the
 *  catalogue if a second promo is ever added beside this one. */
export function isPromoProduct(productKey: string): boolean {
  return productKey === PROMO_PRODUCT_KEY;
}
