import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { createClient, type SupabaseClient } from "jsr:@supabase/supabase-js@2";
import { verifyRazorpayWebhook } from "../_shared/webhook.ts";
import { supabaseEntitlementStore } from "../_shared/store.ts";
import {
  applyCreditPurchase,
  applySubscriptionCredit,
  type CreditPurchase,
  type GrantOutcome,
} from "../_shared/entitlements.ts";
import {
  billingReasonForPaidCount,
  fetchRazorpaySubscription,
  identityForOrder,
  identityForSubscriptionCharge,
  INVOICE_PAID_EVENTS,
  ORDER_GRANT_EVENTS,
  peekRazorpayEvent,
  readInvoicePaidEvent,
  readOrderPaidEvent,
  readSubscriptionChargedEvent,
  resolveOneTimeProduct,
  resolveSubscriptionProduct,
  SUBSCRIPTION_GRANT_EVENTS,
  type RazorpayIdentity,
} from "../_shared/razorpay.ts";

// NEW 2026-08-27. Razorpay's authoritative grant path - the fix for the GAP
// the original audit called out in razorpay-verify's header: "the only path
// that granted anything, and it runs in the buyer's browser. Phone dies, tab
// closes, signal drops on set: the payment succeeds, nothing is granted, the
// row sits [unfinished] and nobody finds out." A webhook is not a nicer
// version of that path, it is the one path that still runs when the browser
// never comes back, exactly like stripe-webhook already is for Stripe. Read
// that file's header first - this is the same posture, one gateway later.
//
// GRANTS ON order.paid, NOT payment.captured. Confirmed against the owner's
// own live Razorpay dashboard, not a tutorial: this webhook destination is
// subscribed to EXACTLY order.paid and invoice.paid. subscription.charged is
// NOT ticked - dashboard only, a PATCH attempt through the API silently
// no-oped - so a subscription that only granted on subscription.charged
// would grant nothing, ever, for real money already taken. That was true
// until 2026-08-27: one-off purchases grant on order.paid, subscription
// charges now grant on invoice.paid (see its section in _shared/razorpay.ts
// for how it resolves a buyer and a product it does not carry), and
// subscription.charged stays wired as a second grant path for the day the
// checkbox gets ticked - both are safe to receive for the same charge at
// once because they key off the same payment id. The reasoning for order.paid
// over payment.captured is sound independent of what any guide assumes -
// payment.captured can fire MORE THAN ONCE for a single order under partial
// or multiple payment attempts, which is exactly the double-grant hazard this
// codebase already solved once, on the Stripe side, by granting on
// invoice.paid and never on payment_intent events (see stripe-webhook's file
// header, section 1). order.paid fires exactly once, when an order's
// amount_due reaches zero, so it is the better idempotency anchor of the two
// and is what _shared/razorpay.ts's identityForOrder keys off.
//
// VERIFY JWT MUST BE OFF FOR THIS FUNCTION. Razorpay is not a Supabase user
// and has no anon key to send:
//
//   supabase functions deploy razorpay-webhook --no-verify-jwt
//
// Which means THE SIGNATURE CHECK IS THE AUTHENTICATION. There is no second
// gate behind it - same as stripe-webhook.
//
// NO CORS. Server to server. A browser has no business calling it.
//
// SECRETS (owner sets, never in this repo):
//   RAZORPAY_WEBHOOK_SECRET   the dashboard destination's own secret. NOT
//                             RAZORPAY_KEY_SECRET - see _shared/webhook.ts's
//                             Razorpay section for why those two must never
//                             be confused; they sign different messages.
//   RAZORPAY_KEY_ID / RAZORPAY_KEY_SECRET   order.paid already carries the
//                             order's notes in the payload, so these are not
//                             needed for that grant. invoice.paid's grant
//                             DOES need them: a subscription cycle's invoice
//                             carries no buyer, no product and no paid_count
//                             of its own (see _shared/razorpay.ts's
//                             invoice.paid section), so this webhook fetches
//                             the subscription back with these credentials,
//                             the same pair razorpay-subscription already
//                             uses to create one.

const PROVIDER = "razorpay";
/** Same 5s convention razorpay-verify uses for fetchRazorpayOrder - a slow or
 *  hanging fetch back to Razorpay must not itself become the failure. */
const SUBSCRIPTION_FETCH_TIMEOUT_MS = 5000;

Deno.serve(async (req: Request) => {
  const json = (body: unknown, status = 200) =>
    new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });

  if (req.method !== "POST") return json({ error: "POST only" }, 405);

  const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
  const SERVICE = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
  const WEBHOOK_SECRET = Deno.env.get("RAZORPAY_WEBHOOK_SECRET");
  const KEY_ID = Deno.env.get("RAZORPAY_KEY_ID");
  const KEY_SECRET = Deno.env.get("RAZORPAY_KEY_SECRET");

  // 1. THE RAW BYTES. Read once, hashed as they arrived, parsed from the
  // same buffer afterwards. Razorpay's docs say it in as many words as
  // Stripe's do: "Do not parse or cast the webhook request body" before
  // validating it - any manipulation, including a JSON round trip that
  // reorders keys or changes whitespace, breaks verification.
  const raw = new Uint8Array(await req.arrayBuffer());

  const verdict = await verifyRazorpayWebhook(raw, req.headers.get("X-Razorpay-Signature"), WEBHOOK_SECRET);
  if (!verdict.ok) {
    if (verdict.reason === "no_secret") {
      // A DEPLOY mistake, not a caller mistake - and, as of this file's
      // creation, the honest current state: RAZORPAY_WEBHOOK_SECRET was not
      // set anywhere in this codebase until today. 500 so Razorpay retries
      // it rather than marking the delivery permanently failed, the same
      // choice stripe-webhook makes for the same reason.
      console.error("razorpay-webhook: RAZORPAY_WEBHOOK_SECRET not set");
      return json({ error: "not configured" }, 500);
    }
    // Everything else is unauthenticated. 400, no retry will fix it.
    console.error(`razorpay-webhook: signature rejected (${verdict.reason})`);
    return json({ error: "bad signature" }, 400);
  }

  // 2. Only now is the body worth reading.
  let parsed: unknown;
  try {
    parsed = JSON.parse(new TextDecoder().decode(raw));
  } catch {
    console.error("razorpay-webhook: signed body was not JSON");
    return json({ error: "bad body" }, 400);
  }

  const eventType = peekRazorpayEvent(parsed);
  if (!eventType) return json({ error: "not an event" }, 400);

  const admin = createClient(SUPABASE_URL, SERVICE, { auth: { persistSession: false } });

  const logEvent = async (name: string, userId: string | null, props: Record<string, unknown>) => {
    try {
      await admin.from("events").insert({ user_id: userId, name, props });
    } catch {
      /* analytics is non-fatal */
    }
  };

  const store = supabaseEntitlementStore(admin, logEvent);

  // =========================================================================
  // order.paid - the grant.
  // =========================================================================
  if (ORDER_GRANT_EVENTS.indexOf(eventType) !== -1) {
    const read = readOrderPaidEvent(parsed);
    if (!read) return json({ error: "not an event" }, 400);

    // Defensive, not a real state machine: Razorpay's own docs give no case
    // where order.paid fires with status other than "paid" - that is
    // literally what the event means. If this is ever false anyway it is
    // refused rather than guessed at, the same way stripe-webhook refuses an
    // invoice.paid with paid=false instead of treating it as a lesser kind
    // of paid.
    if (read.order.status !== "paid") {
      console.error(`razorpay-webhook: order.paid with status ${read.order.status} (${read.order.id})`);
      await logEvent("purchase_needs_attention", null, {
        provider: PROVIDER,
        order_id: read.order.id,
        reason: "order_not_actually_paid",
        status: read.order.status,
      });
      return json({ ok: true, needs_attention: "order_not_actually_paid" });
    }

    const userId = typeof read.order.notes.user_id === "string" && read.order.notes.user_id.length > 0
      ? read.order.notes.user_id
      : null;
    // WHAT WAS BOUGHT. notes.product_key, written by razorpay-order at
    // order-creation time. THE CREDIT COUNT COMES FROM THE CATALOGUE, never
    // from notes, never from the amount paid - notes only says WHICH
    // product; _shared/products.ts says how many credits that is.
    // resolveOneTimeProduct also refuses a `subscription`-kind key - see its
    // own comment for why an order.paid delivery must never be allowed to
    // grant a subscription's credit count.
    const product = resolveOneTimeProduct(read.order.notes.product_key);

    const identity = identityForOrder(read.order.id);

    const purchase: CreditPurchase = {
      provider: identity.provider,
      eventId: identity.eventId,
      userId,
      productKey: product ? product.key : null,
      credits: product ? product.credits : 0,
      amountCents: read.order.amount,
      currency: read.order.currency,
      providerTxnId: identity.providerTxnId,
      occurredAt: null,
    };

    const outcome = await applyCreditPurchase(store, purchase);
    return grantOutcomeResponse(json, outcome, PROVIDER, read.order.id, userId);
  }

  // =========================================================================
  // subscription.charged - the RECURRING grant, wired 2026-08-27 with
  // razorpay-subscription and STILL LIVE for the day the owner ticks it on
  // the dashboard - see the file header for why invoice.paid, not this
  // event, is what actually runs today. Both key off the same payment id
  // (identityForSubscriptionCharge), so if this ever fires alongside
  // invoice.paid for the same charge, exactly one of the two grants and the
  // other answers `duplicate` - see _shared/razorpay.ts's subscription
  // section.
  // =========================================================================
  if (SUBSCRIPTION_GRANT_EVENTS.indexOf(eventType) !== -1) {
    const read = readSubscriptionChargedEvent(parsed);
    if (!read) return json({ error: "not an event" }, 400);

    const userId = typeof read.notes.user_id === "string" && read.notes.user_id.length > 0
      ? read.notes.user_id
      : null;
    // Same rule as the order path: notes says WHICH product, the catalogue
    // says how many credits. resolveSubscriptionProduct additionally refuses
    // a one_time key, so a mislabelled subscription can never grant a credit
    // pack on every cycle forever.
    const product = resolveSubscriptionProduct(read.notes.product_key);

    // NULL WHEN paid_count IS MISSING, deliberately - see
    // billingReasonForPaidCount. applySubscriptionCredit records an unknown
    // reason as needs-attention and grants nothing, which is one row for a
    // human rather than an unrecoverable over- or under-grant.
    const billingReason = billingReasonForPaidCount(read.paidCount);

    const identity = identityForSubscriptionCharge(read.subscriptionId, read.paymentId, read.paidCount);

    const outcome = await applySubscriptionCredit(store, {
      provider: identity.provider,
      eventId: identity.eventId,
      userId,
      productKey: product ? product.key : null,
      billingReason,
      // Both come from the catalogue, never from the payload. On a first
      // charge applySubscriptionCredit spends introCredits (once per account
      // ever); on a renewal it grants `credits`.
      introCredits: product ? (product.introCredits ?? product.credits) : 0,
      renewalCredits: product ? product.credits : 0,
      amountCents: read.amount,
      currency: read.currency,
      providerTxnId: identity.providerTxnId,
      occurredAt: null,
    });

    // THE MIRROR, not the grant. See mirrorSubscriptionProfile's own comment
    // for why this only runs on a fresh `granted` and not on `duplicate`: a
    // replayed old delivery would overwrite a newer subscription's row with
    // stale status/period data.
    if (outcome.status === "granted" && userId) {
      await mirrorSubscriptionProfile(admin, userId, read.status, read.subscriptionId, product?.key ?? null, read.currentEnd);
    }

    return grantOutcomeResponse(json, outcome, PROVIDER, identity.providerTxnId, userId);
  }

  // =========================================================================
  // invoice.paid - split by whether the invoice carries a subscription id,
  // since 2026-08-27.
  //
  // WITH a subscription_id: a subscription charge, and - see the file header
  // - the ONLY delivery that charge is guaranteed to produce on the owner's
  // live webhook. Granted below through the SAME applySubscriptionCredit
  // path subscription.charged uses. See _shared/razorpay.ts's invoice.paid
  // section for why the invoice's own payload cannot resolve the buyer, the
  // product or first-vs-renewal by itself, and why fetchRazorpaySubscription
  // is what supplies them.
  //
  // WITHOUT one: a standalone invoice. This app sells no product that issues
  // one, so this stays exactly what it always was - RECORDED, NOT GRANTED.
  // =========================================================================
  if (INVOICE_PAID_EVENTS.indexOf(eventType) !== -1) {
    const read = readInvoicePaidEvent(parsed);
    if (!read) return json({ error: "not an event" }, 400);

    if (read.subscriptionId) {
      // A subscription cycle. NOTHING is recorded under this charge's key
      // until the fetch below succeeds. That ordering is deliberate, not an
      // oversight: applyCreditPurchase/applySubscriptionCredit both RECORD
      // before they CLAIM, and claimPurchase only ever moves a row OUT of
      // `received` - so a row written here as `unknown_product` while the
      // buyer or the product was still unresolved would permanently poison
      // the key a later, successful delivery for the SAME charge needs: that
      // delivery would find the row already claimed-or-terminal and answer
      // `duplicate`, granting nothing, forever. Fail loud with a 500 instead
      // and let Razorpay retry the whole delivery - see the order.paid path
      // for why 500 is the right answer to "we could not finish this", and
      // razorpay-verify's identical posture around fetchRazorpayOrder.
      if (!KEY_ID || !KEY_SECRET) {
        console.error("razorpay-webhook: RAZORPAY_KEY_ID / RAZORPAY_KEY_SECRET not set, cannot resolve invoice.paid's subscription");
        return json({ error: "not configured" }, 500);
      }

      const fetched = await fetchRazorpaySubscription(read.subscriptionId, KEY_ID, KEY_SECRET, SUBSCRIPTION_FETCH_TIMEOUT_MS);
      if (!fetched.ok) {
        console.error(
          `razorpay-webhook: could not fetch subscription ${read.subscriptionId} for invoice ${read.invoiceId ?? "?"}: ${fetched.reason} ${fetched.detail}`,
        );
        return json({ error: "could not verify subscription" }, 500);
      }

      const sub = fetched.subscription;
      const userId = typeof sub.notes.user_id === "string" && sub.notes.user_id.length > 0
        ? sub.notes.user_id
        : null;
      // Same rule as every other grant path: notes says WHICH product, the
      // catalogue says how many credits.
      const product = resolveSubscriptionProduct(sub.notes.product_key);

      // NULL WHEN paid_count IS MISSING, deliberately - same rule
      // subscription.charged follows. Fetched fresh above, not read off the
      // invoice - the Invoice entity carries no paid_count of its own.
      const billingReason = billingReasonForPaidCount(sub.paidCount);

      // THE SAME KEY subscription.charged would build for this exact charge,
      // when the invoice carries a payment_id - the normal case for a paid
      // invoice, and what makes it safe for both events to be ticked at
      // once. See identityForSubscriptionCharge's own comment for why the
      // fallback here is the invoice id, not that function's
      // subscription-id-plus-paid_count composite.
      const identity: RazorpayIdentity = read.paymentId
        ? identityForSubscriptionCharge(sub.id, read.paymentId, sub.paidCount)
        : { provider: "razorpay", eventId: read.invoiceId ?? "", providerTxnId: read.invoiceId ?? "" };

      const outcome = await applySubscriptionCredit(store, {
        provider: identity.provider,
        eventId: identity.eventId,
        userId,
        productKey: product ? product.key : null,
        billingReason,
        introCredits: product ? (product.introCredits ?? product.credits) : 0,
        renewalCredits: product ? product.credits : 0,
        amountCents: read.amountPaid,
        currency: read.currency,
        providerTxnId: identity.providerTxnId,
        occurredAt: null,
      });

      if (outcome.status === "granted" && userId) {
        await mirrorSubscriptionProfile(admin, userId, sub.status, sub.id, product?.key ?? null, sub.currentEnd);
      }

      return grantOutcomeResponse(json, outcome, PROVIDER, identity.providerTxnId, userId);
    }

    // ---------------------------------------------------------------------
    // No subscription_id: a standalone invoice. Unchanged from before this
    // file granted anything against invoice.paid at all.
    // ---------------------------------------------------------------------
    const userId = typeof read.notes.user_id === "string" && read.notes.user_id.length > 0
      ? read.notes.user_id
      : null;
    console.error(
      `razorpay-webhook: invoice.paid received, RECORDED, NOT GRANTED - no subscription_id, this app sells nothing that issues a standalone invoice (invoice ${read.invoiceId ?? "?"})`,
    );
    await logEvent("purchase_needs_attention", userId, {
      provider: PROVIDER,
      event_type: eventType,
      invoice_id: read.invoiceId,
      subscription_id: null,
      amount_paid: read.amountPaid,
      currency: read.currency,
      reason: "razorpay_invoice_is_record_only",
    });
    // ALSO route this through the SAME `purchases` ledger every other
    // gateway's needs-attention row lands in, not analytics alone. The
    // dashboard's reconciliation query and purchases_attention_idx both read
    // `purchases`, not `events` - a purchase recorded only as an analytics
    // event is invisible to the exact query built to find "money that took
    // and did not land". `productKey: null, credits: 0` is what
    // applyCreditPurchase itself writes for an unresolved product, so this
    // asks for nothing this pair cannot already handle: it is recorded,
    // idempotent against Razorpay's own retries (same invoice id, same
    // claim), and grants nothing, exactly like an unrecognised product key
    // from any other event.
    if (read.invoiceId) {
      const recorded = await applyCreditPurchase(store, {
        provider: PROVIDER,
        eventId: read.invoiceId,
        userId,
        productKey: null,
        credits: 0,
        amountCents: read.amountPaid,
        currency: read.currency,
        providerTxnId: read.invoiceId,
        occurredAt: null,
      });
      // THE LEDGER WRITE ITSELF CAN FAIL, and this is the exact invariant
      // bug #3 was about: money with no record must never happen silently.
      // recordPurchase's own error - a transient DB error, not a duplicate,
      // those are already handled - comes back as `store_error` here. Answer
      // 500 so Razorpay retries, the same choice grantOutcomeResponse below
      // makes for the grant path. A retry is safe: recordPurchase tolerates
      // being called again for the same invoice id (ON CONFLICT DO NOTHING),
      // and an unactionable purchase (productKey null) always resolves to
      // `unknown_product`, never a second write.
      if (recorded.status === "store_error") {
        console.error(`razorpay-webhook: could not record invoice.paid ${read.invoiceId}: ${recorded.error}`);
        return json({ error: "could not record purchase" }, 500);
      }
    }
    // No invoiceId: there is no idempotency key to record against, the same
    // rule applyCreditPurchase itself enforces (`store_error` for a purchase
    // with no event id) - so this stays an analytics-only log line, already
    // written above.
    return json({ ok: true, needs_attention: "razorpay_invoice_is_record_only" });
  }

  // Anything else. 200, always - Razorpay retries a non-2xx and answering
  // 500 to an event type this endpoint will never handle would only be sixty
  // pointless retries and a noisy dashboard, the same reasoning
  // stripe-webhook gives for its own catch-all.
  return json({ ok: true, ignored: eventType });
});

/** Shared tail for the grant path, mirroring stripe-webhook's
 *  checkoutOutcomeResponse so the status-code and logging decisions cannot
 *  drift between the two gateways. */
function grantOutcomeResponse(
  json: (body: unknown, status?: number) => Response,
  outcome: GrantOutcome,
  provider: string,
  txnId: string,
  userId: string | null,
): Response {
  switch (outcome.status) {
    case "granted":
      console.log(
        `${provider}-webhook: granted ${outcome.credits} credit(s) to ${userId} (${txnId}), balance ${outcome.balance}`,
      );
      return json({ ok: true, granted: outcome.credits, balance: outcome.balance });

    case "duplicate":
      // The correct answer to a retried delivery.
      return json({ ok: true, duplicate: true });

    case "no_user":
    case "unknown_product":
      // Recorded, granted nothing, needs a human. STILL A 200: retrying
      // produces the same answer for as long as Razorpay keeps trying and
      // teaches this endpoint's caller nothing new.
      console.error(`${provider}-webhook: ${outcome.status} for ${txnId}`);
      return json({ ok: true, needs_attention: outcome.status });

    case "grant_failed":
    case "store_error":
      // Money moved and nothing was granted, for a reason that might not
      // repeat. 500 asks Razorpay to retry, and the claim in
      // _shared/entitlements.ts means a retry cannot double grant even if
      // the first attempt partly landed.
      console.error(`${provider}-webhook: ${outcome.status} for ${txnId}: ${outcome.error}`);
      return json({ error: "could not apply purchase" }, 500);
  }
}

/**
 * The profiles.subscription_* mirror - display only, nothing in this
 * codebase gates on it (see both 20260826170000_entitlements.sql's and
 * 20260827120000_project_metering.sql's comments on these four columns,
 * which say in as many words that they are "written by the webhook with a
 * plain UPDATE"). This is that UPDATE, for Razorpay, written for the first
 * time here - the RPC that grants credits (grant_subscription_invoice_credits)
 * never touched these columns, so before this function existed a Razorpay
 * subscriber's credits landed correctly but the Account screen's Money panel
 * had nothing to show for it.
 *
 * CALLED ONLY ON A FRESH `granted`, never on `duplicate`. A duplicate means
 * this exact charge was already mirrored by the delivery that won the claim;
 * writing again from a REPLAYED delivery risks overwriting a newer
 * subscription's row with this older one's status and period end, which a
 * plain unconditional UPDATE has no way to detect.
 *
 * Best effort by design, same posture as EntitlementStore.finishPurchase:
 * the credits are already granted by the time this runs, and refusing to
 * acknowledge a successful grant because a display-only mirror failed to
 * write would be the wrong trade.
 */
async function mirrorSubscriptionProfile(
  admin: SupabaseClient,
  userId: string,
  status: string | null,
  subscriptionId: string,
  productKey: string | null,
  currentPeriodEnd: string | null,
): Promise<void> {
  try {
    const { error } = await admin
      .from("profiles")
      .update({
        subscription_status: status,
        subscription_id: subscriptionId,
        subscription_product: productKey,
        subscription_current_period_end: currentPeriodEnd,
      })
      .eq("user_id", userId);
    if (error) {
      console.error(`razorpay-webhook: could not mirror subscription status for ${userId}: ${error.message ?? error}`);
    }
  } catch (e) {
    console.error(`razorpay-webhook: could not mirror subscription status for ${userId}: ${e}`);
  }
}

// ============================================================================
// OWNER SETUP
//
// Already done, as of 2026-08-27 - recorded here for whoever reads this file
// next, not as an instruction to redo it:
//
//   Dashboard destination : https://<project-ref>.supabase.co/functions/v1/razorpay-webhook
//   Events                : order.paid, invoice.paid (subscription.charged is
//                            NOT ticked and cannot be ticked through the API -
//                            see the file header for why that is what moved
//                            the subscription grant onto invoice.paid)
//   Mode                  : live (LIVE keys, confirmed against two real
//                            Rs 1 payments granting credits end to end)
//   supabase secrets set RAZORPAY_WEBHOOK_SECRET='...'
//   supabase secrets set RAZORPAY_KEY_ID='...' RAZORPAY_KEY_SECRET='...'
//                            NOW REQUIRED, not optional - invoice.paid's
//                            subscription grant fetches the subscription back
//                            with these, and answers 500 (Razorpay retries)
//                            without them.
//   supabase functions deploy razorpay-webhook --no-verify-jwt
//
// If payment.failed observability is ever wanted, it is NOT subscribed on
// the dashboard today and this file must not be written as though it
// arrives - see the file header.
// ============================================================================
