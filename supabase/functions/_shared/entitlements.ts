// The grant layer. ONE place where a purchase turns into credits.
//
// WHY THIS FILE EXISTS AT ALL. Two code paths that both grant entitlements is
// how one of them ends up wrong: the browser-return path and the webhook path
// drift, one gets a fix the other does not, and the bug is invisible until it
// is somebody's money. So the webhook does not know how to grant anything. It
// knows how to VERIFY a signature and how to describe a purchase; this file
// turns that description into credits, and any second gateway added later
// calls the same function.
//
// GATEWAY AGNOSTIC. Nothing below mentions Paddle. A purchase is
// `{ provider, eventId, userId, productKey, credits, amount }` and that shape
// is as true of Razorpay, Stripe or a hand written comp as it is of Paddle.
//
// IDEMPOTENCY IS THE WHOLE JOB. Paddle retries a failed delivery up to 60
// times over three days (their documented live schedule), and a manual replay
// creates a NEW notification carrying the SAME event id. Granting five credits
// twice is a direct, silent loss. So the guard is not "read the row, check the
// status, then write" - two concurrent retries both pass that. The guard is IN
// THE WHERE CLAUSE of a single conditional UPDATE, the same shape as
// consume_quota: exactly one caller can move a purchase out of `received`, and
// only that caller grants.
//
// NO IMPORTS, NO DENO API, NO SUPABASE CLIENT. The database is reached through
// the small port interface below, which the edge function implements with
// supabase-js and the test suite implements with a fake. That is what makes
// the idempotency claim testable without a database.

/** A purchase, as described by whichever gateway took the money. */
export interface CreditPurchase {
  /** "paddle", "razorpay", "comp". Half of the idempotency key. */
  provider: string;
  /** The gateway's own event id. The OTHER half, and the thing that makes a
   *  retry free. For Paddle this is `event_id` (evt_...), NOT `notification_id`:
   *  a replay of the same event carries a new notification id and must still
   *  be recognised as the same event. */
  eventId: string;
  /** The account being credited, resolved server-side. Null when the gateway
   *  told us about money we cannot attach to anybody - which is a thing that
   *  must be RECORDED, never dropped. */
  userId: string | null;
  /** Key from _shared/products.ts. Null when the price id matched nothing. */
  productKey: string | null;
  /** Projects to grant. Already multiplied by quantity by the caller. */
  credits: number;
  /** Ledger only. Charged in the buyer's currency by a merchant of record, so
   *  this is NOT the catalogue price and is never used as a gate. */
  amountCents: number | null;
  currency: string | null;
  /** The gateway's transaction id, for looking a payment up in their dashboard. */
  providerTxnId: string | null;
  /** The gateway's own timestamp for the event. */
  occurredAt: string | null;
}

/** What happened. The webhook maps this to an HTTP status and nothing else. */
export type GrantOutcome =
  | { status: "granted"; credits: number; balance: number | null }
  /** Already processed. The correct answer to a retry, and a 200. */
  | { status: "duplicate" }
  /** Recorded, granted nothing, needs a human. */
  | { status: "no_user" }
  | { status: "unknown_product" }
  /** The claim or the credit write failed. Recorded and retryable. */
  | { status: "grant_failed"; error: string }
  | { status: "store_error"; error: string };

/** Statuses that mean money moved and nobody got anything. The dashboard
 *  reconciliation panel reads exactly this list. */
export const NEEDS_ATTENTION_STATUSES = [
  "received",
  "granting",
  "grant_failed",
  "user_unknown",
  "unknown_product",
];

/** The database, narrowed to the five things a grant does. Implemented with
 *  supabase-js in the edge function and with a fake in the tests. */
export interface EntitlementStore {
  /** INSERT the purchase if it is new. MUST be an insert that tolerates a
   *  duplicate primary key without throwing (`on conflict do nothing`), because
   *  a retry lands here first and is not an error. */
  recordPurchase(p: CreditPurchase, status: string): Promise<{ error?: string }>;

  /** THE CLAIM. A single conditional UPDATE:
   *
   *    update purchases set status = 'granting'
   *     where provider = $1 and provider_event_id = $2 and status = 'received'
   *    returning user_id, credits
   *
   *  Returns null when zero rows matched, which means somebody else already
   *  has this event. Never read-then-write. */
  claimPurchase(
    provider: string,
    eventId: string,
  ): Promise<{ claimed: { userId: string | null; credits: number } | null; error?: string }>;

  /** Add credits to the account, atomically, and return the new balance.
   *  Null balance means there was no such account. */
  addCredits(userId: string, credits: number): Promise<{ balance: number | null; error?: string }>;

  /** Move the purchase to its final status. Best effort by design: the credits
   *  are already granted by the time this runs, and refusing to acknowledge a
   *  successful grant because the note about it failed would be the wrong
   *  trade. A row stuck at `granting` is visible in the dashboard panel. */
  finishPurchase(
    provider: string,
    eventId: string,
    status: string,
    note?: string | null,
  ): Promise<{ error?: string }>;

  /** One row in `events` per grant, so the dashboard can see revenue. */
  logEvent(name: string, userId: string | null, props: Record<string, unknown>): Promise<void>;
}

/**
 * Apply a purchase. Safe to call twice with the same event; the second call
 * returns `duplicate` and changes nothing.
 *
 * Order of operations is deliberate:
 *   1. RECORD first, always, even for a purchase we cannot act on. A payment
 *      we have no row for is a payment nobody can reconcile.
 *   2. CLAIM. One winner. Everything after this point runs exactly once.
 *   3. GRANT. Then mark it granted.
 *
 * If step 3 dies between granting and marking, the row sits at `granting` with
 * the credits already added. That is the safe direction to fail: it shows up
 * in the reconciliation panel and it never double grants, because `granting`
 * is not claimable.
 */
export async function applyCreditPurchase(
  store: EntitlementStore,
  purchase: CreditPurchase,
): Promise<GrantOutcome> {
  // A purchase with no event id has no idempotency key, so it cannot be made
  // safe. Refuse rather than grant something that can arrive again.
  if (!purchase.provider || !purchase.eventId) {
    return { status: "store_error", error: "missing provider or event id" };
  }

  const actionable = !!purchase.userId && !!purchase.productKey && purchase.credits > 0;
  const initialStatus = !purchase.productKey
    ? "unknown_product"
    : !purchase.userId
    ? "user_unknown"
    : "received";

  const rec = await store.recordPurchase(purchase, initialStatus);
  if (rec.error) return { status: "store_error", error: rec.error };

  if (!actionable) {
    // Recorded, deliberately not granted, loud in the log and in the panel.
    await store.logEvent("purchase_needs_attention", purchase.userId, {
      provider: purchase.provider,
      event_id: purchase.eventId,
      txn_id: purchase.providerTxnId,
      reason: initialStatus,
    });
    return initialStatus === "unknown_product" ? { status: "unknown_product" } : { status: "no_user" };
  }

  const { claimed, error: claimErr } = await store.claimPurchase(purchase.provider, purchase.eventId);
  if (claimErr) return { status: "store_error", error: claimErr };
  // Zero rows: another delivery of this same event already owns it.
  if (!claimed) return { status: "duplicate" };

  const userId = claimed.userId ?? purchase.userId!;
  const credits = claimed.credits > 0 ? claimed.credits : purchase.credits;

  // WHY grant_failed IS NOT RETRIED AUTOMATICALLY. The credit write is not
  // idempotent (it is `balance = balance + n`), so a delivery that failed
  // AFTER the credits landed is indistinguishable from one that failed before.
  // Re-claiming a grant_failed row would therefore risk paying out twice to
  // fix a case that might already be fine. The row stays out of the claimable
  // set, the reconciliation panel shows it, and a human repairs it. That costs
  // one manual fix in a rare case; the alternative costs money in a rare case
  // and nobody notices.
  const { balance, error: addErr } = await store.addCredits(userId, credits);
  if (addErr || balance === null) {
    const error = addErr ?? "no profile row for that account";
    await store.finishPurchase(purchase.provider, purchase.eventId, "grant_failed", error.slice(0, 300));
    await store.logEvent("purchase_needs_attention", userId, {
      provider: purchase.provider,
      event_id: purchase.eventId,
      txn_id: purchase.providerTxnId,
      reason: "grant_failed",
    });
    return { status: "grant_failed", error };
  }

  await store.finishPurchase(purchase.provider, purchase.eventId, "granted", null);
  // The revenue row. user_id is set, unlike the dashboard's own admin events,
  // because "who bought" is the whole question being asked of it later.
  await store.logEvent("credits_purchased", userId, {
    provider: purchase.provider,
    event_id: purchase.eventId,
    txn_id: purchase.providerTxnId,
    product: purchase.productKey,
    credits,
    amount_cents: purchase.amountCents,
    currency: purchase.currency,
    balance,
  });
  return { status: "granted", credits, balance };
}
