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
   *  trade. A row stuck at `granting` is visible in the dashboard panel.
   *
   *  `credits`, when passed, corrects the row's own credits column. Used by
   *  applySubscriptionCredit, where the true amount (5 or 2) is only known
   *  after grantSubscriptionCredits runs - the row is recorded with 0 up
   *  front rather than a guess. applyCreditPurchase never passes it: the
   *  amount there is known before recording, so there is nothing to correct. */
  finishPurchase(
    provider: string,
    eventId: string,
    status: string,
    note?: string | null,
    credits?: number,
  ): Promise<{ error?: string }>;

  /** THE SUBSCRIPTION CLAIM. Unlike addCredits, the caller does not decide
   *  the credit count - the database does, atomically, because the decision
   *  ("has this ACCOUNT ever had its first-month bonus, on any subscription,
   *  ever") is state a read-then-write could race. One conditional UPDATE,
   *  same shape as unlock_project:
   *
   *    update profiles set subscription_intro_bonus_granted = true
   *     where user_id = $1 and subscription_intro_bonus_granted = false
   *
   *  Zero rows matched means the bonus is already spent - by this account, on
   *  a subscription that may not even be this one - and renewalCredits is
   *  granted instead. This is the whole mechanism that makes the bonus
   *  impossible to collect twice by cancelling and resubscribing: it is keyed
   *  to the ACCOUNT, not to the subscription id, and it is never reset. */
  grantSubscriptionCredits(
    userId: string,
    isFirstInvoice: boolean,
    introCredits: number,
    renewalCredits: number,
  ): Promise<{ credits: number; bonusApplied: boolean; balance: number | null; error?: string }>;

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

// =============================================================================
// Subscriptions
//
// A SEPARATE FUNCTION, NOT A BRANCH INSIDE applyCreditPurchase, because the
// credit count is not a pure function of the catalogue the way a one-time
// purchase's is. applyCreditPurchase's `credits` is known before anything is
// written; a subscription invoice's is not - it depends on account state
// (has this account ever had the first-month bonus) that can only be decided
// safely inside the database, in the same claim that spends it. Folding that
// into applyCreditPurchase would mean smuggling a state-dependent decision
// through a parameter that every other caller treats as a constant.
//
// Everything else about the shape is deliberately identical to
// applyCreditPurchase: record first (even when unactionable), claim once,
// grant, then finish. Same idempotency guarantee, same reconciliation
// statuses, same reasoning for why grant_failed is not retried automatically.

/** An invoice.paid event, read down to what a grant needs. */
export interface SubscriptionInvoiceGrant {
  /** "stripe". Half of the idempotency key, same as CreditPurchase. */
  provider: string;
  /** The invoice.paid event id. */
  eventId: string;
  userId: string | null;
  /** Key from products.ts. Null when neither metadata nor the line price id
   *  matched anything. */
  productKey: string | null;
  /** billing_reason off the invoice, verbatim - Stripe's enum has several
   *  more values than the two this app grants against (subscription_update,
   *  subscription_threshold, the legacy `subscription`, `manual`, ...), and
   *  every one of those is a paid invoice this app does not sell anything
   *  for. Only "subscription_create" and "subscription_cycle" ever grant;
   *  everything else, including null, is recorded as needs-attention rather
   *  than guessed at. See applySubscriptionCredit below. */
  billingReason: string | null;
  /** From products.ts: PRODUCTS[productKey].introCredits. */
  introCredits: number;
  /** From products.ts: PRODUCTS[productKey].credits. */
  renewalCredits: number;
  amountCents: number | null;
  currency: string | null;
  /** The invoice id (in_...). Idempotency at the transaction level, exactly
   *  as the checkout session id is for a one-time purchase: if Stripe were
   *  ever configured to also send invoice.payment_succeeded or
   *  invoice.updated for the same invoice, the unique index on
   *  (provider, provider_txn_id) blocks the second one from granting again,
   *  whatever event name it arrives under. */
  providerTxnId: string | null;
  occurredAt: string | null;
}

/**
 * Apply a subscription invoice. Safe to call twice with the same event; the
 * second call returns `duplicate` and changes nothing. Safe to call for a
 * second, later subscription on an account that already spent its
 * first-month bonus: it grants the standing renewal amount instead, it does
 * not refuse the payment.
 */
export async function applySubscriptionCredit(
  store: EntitlementStore,
  grant: SubscriptionInvoiceGrant,
): Promise<GrantOutcome> {
  if (!grant.provider || !grant.eventId) {
    return { status: "store_error", error: "missing provider or event id" };
  }

  const knownReason = grant.billingReason === "subscription_create" || grant.billingReason === "subscription_cycle";
  const actionable = !!grant.userId && !!grant.productKey && knownReason;
  const initialStatus = !grant.productKey
    ? "unknown_product"
    : !grant.userId
    ? "user_unknown"
    : !knownReason
    // A paid invoice for a product this app sells, but not a first invoice
    // or a renewal of it (a plan change, a threshold invoice, ...). Money
    // moved and nothing was granted, which is exactly what `unknown_product`
    // means to the reconciliation panel, even though the product itself was
    // perfectly well known.
    ? "unknown_product"
    : "received";

  // Recorded with credits 0. The true amount (5 or 2) is decided ATOMICALLY
  // inside grantSubscriptionCredits below and corrected onto this row only
  // once known - recording a guess here would either double count against
  // "credits sold" if the bonus turned out already spent, or under-report it
  // if not.
  const purchase: CreditPurchase = {
    provider: grant.provider,
    eventId: grant.eventId,
    userId: grant.userId,
    productKey: grant.productKey,
    credits: 0,
    amountCents: grant.amountCents,
    currency: grant.currency,
    providerTxnId: grant.providerTxnId,
    occurredAt: grant.occurredAt,
  };

  const rec = await store.recordPurchase(purchase, initialStatus);
  if (rec.error) return { status: "store_error", error: rec.error };

  if (!actionable) {
    await store.logEvent("purchase_needs_attention", grant.userId, {
      provider: grant.provider,
      event_id: grant.eventId,
      txn_id: grant.providerTxnId,
      reason: initialStatus,
      billing_reason: grant.billingReason,
    });
    return initialStatus === "unknown_product" ? { status: "unknown_product" } : { status: "no_user" };
  }

  const { claimed, error: claimErr } = await store.claimPurchase(grant.provider, grant.eventId);
  if (claimErr) return { status: "store_error", error: claimErr };
  // Zero rows: another delivery of this same event already owns it.
  if (!claimed) return { status: "duplicate" };

  const userId = claimed.userId ?? grant.userId!;
  const isFirstInvoice = grant.billingReason === "subscription_create";

  const { credits, bonusApplied, balance, error: grantErr } = await store.grantSubscriptionCredits(
    userId,
    isFirstInvoice,
    grant.introCredits,
    grant.renewalCredits,
  );
  if (grantErr || balance === null) {
    const error = grantErr ?? "no profile row for that account";
    await store.finishPurchase(grant.provider, grant.eventId, "grant_failed", error.slice(0, 300));
    await store.logEvent("purchase_needs_attention", userId, {
      provider: grant.provider,
      event_id: grant.eventId,
      txn_id: grant.providerTxnId,
      reason: "grant_failed",
    });
    return { status: "grant_failed", error };
  }

  // The row's credits column is corrected here, from 0 to what was actually
  // granted - the only point in this function that number is known.
  await store.finishPurchase(grant.provider, grant.eventId, "granted", null, credits);
  await store.logEvent("credits_purchased", userId, {
    provider: grant.provider,
    event_id: grant.eventId,
    txn_id: grant.providerTxnId,
    product: grant.productKey,
    credits,
    bonus_applied: bonusApplied,
    billing_reason: grant.billingReason,
    amount_cents: grant.amountCents,
    currency: grant.currency,
    balance,
  });
  return { status: "granted", credits, balance };
}
