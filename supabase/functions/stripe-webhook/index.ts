import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { createClient } from "jsr:@supabase/supabase-js@2";
import { verifyStripeWebhook } from "../_shared/webhook.ts";
import { getProduct, productForPriceId } from "../_shared/products.ts";
import { supabaseEntitlementStore } from "../_shared/store.ts";
import {
  applyCreditPurchase,
  applySubscriptionCredit,
  type CreditPurchase,
  type SubscriptionInvoiceGrant,
} from "../_shared/entitlements.ts";
import {
  CHECKOUT_GRANT_EVENTS,
  CHECKOUT_NOTED_EVENTS,
  INVOICE_GRANT_EVENTS,
  INVOICE_NOTED_EVENTS,
  peekEventType,
  readCheckoutEvent,
  readInvoiceEvent,
  readSubscriptionStatusEvent,
  SUBSCRIPTION_STATUS_EVENTS,
} from "../_shared/stripe.ts";

// Stripe webhook. The only path that turns money into credits.
//
// WHY A WEBHOOK IS THE PRIMARY PATH. Stripe's own fulfilment guide puts it
// better than a comment could: "You can't rely on triggering fulfilment only
// from your checkout landing page, because it's not guaranteed customers visit
// that page." On a phone, on a set, with one bar of signal, that is not an
// edge case. The money moves at Stripe whether or not the browser comes back.
//
// VERIFY JWT MUST BE OFF FOR THIS FUNCTION. Stripe is not a Supabase user and
// has no anon key to send:
//
//   supabase functions deploy stripe-webhook --no-verify-jwt
//
// Which means THE SIGNATURE CHECK IS THE AUTHENTICATION. There is no second
// gate behind it.
//
// NO CORS. Server to server. A browser has no business calling it.
//
// ANSWER FAST. Stripe wants a 2xx "before any complex logic that could cause a
// timeout", and when a success_url is set it holds the customer's redirect for
// up to ten seconds waiting for this response. The work below is one insert,
// one conditional update, one RPC, and at most one call back to Stripe.
//
// STRIPE IS NOT A MERCHANT OF RECORD. The owner is the seller and the tax is
// his. Nothing in this file assumes otherwise. Amounts are recorded exactly
// as charged and are never treated as the catalogue price.
//
// ---------------------------------------------------------------------------
// THREE KINDS OF EVENT, THREE JOBS, ONE RULE CARRIED THROUGH ALL OF THEM:
// never grant twice for the same money.
//
// 1. CHECKOUT SESSIONS (checkout.session.completed,
//    .async_payment_succeeded, .async_payment_failed). Grant ONLY when
//    mode is "payment" - the one-time bundle. When mode is "subscription"
//    these events are read only far enough to log them, never granted: the
//    subscription's first invoice.paid describes the SAME payment, and
//    granting on both would be exactly the double-grant this file already
//    refuses for two Paddle event names that mean one transaction. See
//    _shared/stripe.ts, above CHECKOUT_GRANT_EVENTS, for the full reasoning.
//
// 2. INVOICES (invoice.paid, invoice.payment_failed). invoice.paid is the
//    ONLY event that grants a subscription credit, for the first invoice of
//    a new subscription and for every renewal after it. Which one it is
//    comes from billing_reason, read off the invoice itself:
//      subscription_create   first invoice   -> up to 5 credits (the bonus)
//      subscription_cycle    a renewal       -> 2 credits
//    Quoted, not guessed: docs.stripe.com/billing/subscriptions/webhooks,
//    read 2026-08-26. "invoice.paid: ... You can provision access to your
//    product when you receive this event." A subscription that only granted
//    on signup is a subscription that silently stops delivering in month
//    two, and this is the fix for that.
//
// 3. SUBSCRIPTION STATUS (customer.subscription.created/.updated/.deleted).
//    Grant NOTHING, ever. These three keep profiles.subscription_status /
//    subscription_id in sync for the dashboard Money panel, and that is
//    all they do. A cancelled or unpaid subscription stops FUTURE credits
//    by simply not sending any more invoice.paid events - it does not, and
//    this handler cannot, touch a credit already spent or a project already
//    unlocked. See the migration's section 4b for why that is true by
//    construction rather than by care taken here.
//
// SECRETS (owner sets, never in this repo):
//   STRIPE_WEBHOOK_SECRET   the endpoint signing secret, whsec_...
//   STRIPE_SECRET_KEY       only for the bundle's line-item fallback below, sk_...
//   STRIPE_PRICE_PRO_MONTHLY  price id for the 5 USD/month subscription
//   STRIPE_PRICE_BUNDLE_5     price id for the 20 USD one-time bundle

const PROVIDER = "stripe";
const STRIPE_API = "https://api.stripe.com/v1";
/** The line-item fallback is a network call inside a request Stripe is timing.
 *  It gets one short go, then gives up and records rather than hangs. */
const LINE_ITEM_TIMEOUT_MS = 3000;

const CHECKOUT_EVENT_TYPES = [...CHECKOUT_GRANT_EVENTS, ...CHECKOUT_NOTED_EVENTS];
const INVOICE_EVENT_TYPES = [...INVOICE_GRANT_EVENTS, ...INVOICE_NOTED_EVENTS];

Deno.serve(async (req: Request) => {
  const json = (body: unknown, status = 200) =>
    new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });

  if (req.method !== "POST") return json({ error: "POST only" }, 405);

  const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
  const SERVICE = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
  const WEBHOOK_SECRET = Deno.env.get("STRIPE_WEBHOOK_SECRET");
  const API_KEY = Deno.env.get("STRIPE_SECRET_KEY");

  // 1. THE RAW BYTES. Read once, hashed as they arrived, parsed from the same
  // buffer afterwards. Stripe's docs say it twice in bold: any manipulation of
  // the raw body, including a JSON round trip that reorders keys or changes
  // whitespace, breaks verification.
  const raw = new Uint8Array(await req.arrayBuffer());

  const verdict = await verifyStripeWebhook(raw, req.headers.get("Stripe-Signature"), WEBHOOK_SECRET);
  if (!verdict.ok) {
    if (verdict.reason === "no_secret") {
      // A deploy mistake, not a caller mistake. 500 so Stripe retries it: it
      // keeps trying for three days, which is time enough to set the secret.
      console.error("stripe-webhook: STRIPE_WEBHOOK_SECRET not set");
      return json({ error: "not configured" }, 500);
    }
    // Everything else is unauthenticated. 400 is what Stripe's own samples
    // return for a bad signature, and no retry will fix it.
    console.error(`stripe-webhook: signature rejected (${verdict.reason})`);
    return json({ error: "bad signature" }, 400);
  }

  // 2. Only now is the body worth reading.
  let parsed: unknown;
  try {
    parsed = JSON.parse(new TextDecoder().decode(raw));
  } catch {
    console.error("stripe-webhook: signed body was not JSON");
    return json({ error: "bad body" }, 400);
  }

  const eventType = peekEventType(parsed);
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
  // 1. CHECKOUT SESSIONS
  // =========================================================================
  if (CHECKOUT_EVENT_TYPES.indexOf(eventType) !== -1) {
    const read = readCheckoutEvent(parsed);
    if (!read) return json({ error: "not an event" }, 400);

    // A subscription session. Read far enough to log it, never granted:
    // invoice.paid on this subscription's first invoice is the same money,
    // and grants it. See the file header.
    if (read.mode === "subscription") {
      await logEvent("checkout_subscription_started", read.userId, {
        provider: PROVIDER,
        event_id: read.eventId,
        event_type: read.eventType,
        session_id: read.sessionId,
        payment_status: read.paymentStatus,
      });
      return json({ ok: true, subscription_checkout: true });
    }

    // Events we are not here for. 200, always. Stripe retries a non-2xx for
    // three days and then marks the delivery failed; answering 500 to an
    // event type that will never be handled is sixty pointless retries and a
    // noisy dashboard.
    if (CHECKOUT_GRANT_EVENTS.indexOf(read.eventType) === -1) {
      if (CHECKOUT_NOTED_EVENTS.indexOf(read.eventType) !== -1) {
        await logEvent("payment_event", read.userId, {
          provider: PROVIDER,
          event_id: read.eventId,
          event_type: read.eventType,
          session_id: read.sessionId,
        });
      }
      return json({ ok: true, ignored: read.eventType });
    }

    // IS THE MONEY ACTUALLY IN? This, not the event name, is what authorises
    // a grant. `checkout.session.completed` fires for a delayed payment
    // method (ACH, bank transfer) with payment_status `unpaid`, and the
    // funds arrive later with `checkout.session.async_payment_succeeded`.
    //
    // An unpaid session writes NO purchases row, deliberately. If it did, the
    // unique index on the transaction id would then block the event that
    // arrives when the money actually lands, and the customer would pay and
    // get nothing. A row in `purchases` means money moved; a promise is not
    // money.
    if (!read.moneyIsIn) {
      await logEvent("payment_pending", read.userId, {
        provider: PROVIDER,
        event_id: read.eventId,
        session_id: read.sessionId,
        payment_status: read.paymentStatus,
      });
      return json({ ok: true, pending: read.paymentStatus });
    }

    // A mode that is neither payment nor subscription should be impossible:
    // nothing here sells anything else. If one ever appears it is a
    // configuration mistake, and guessing what it entitles somebody to would
    // be worse than recording it and stopping.
    if (read.mode !== null && read.mode !== "payment") {
      console.error(`stripe-webhook: unexpected mode ${read.mode} on ${read.sessionId}`);
      await logEvent("purchase_needs_attention", read.userId, {
        provider: PROVIDER,
        event_id: read.eventId,
        session_id: read.sessionId,
        reason: "unexpected_mode",
        mode: read.mode,
      });
      return json({ ok: true, needs_attention: "unexpected_mode" });
    }

    // WHAT WAS BOUGHT.
    //
    // Preferred: `metadata.product_key`, written by our own server when it
    // created the Checkout Session. No network call, and it survives a price
    // id being rotated in the Stripe dashboard.
    //
    // Fallback: LINE ITEMS ARE NOT IN THE WEBHOOK PAYLOAD. Stripe's
    // fulfilment guide is explicit that the session must be retrieved with
    // `line_items` expanded to see what was actually bought. That costs one
    // API call with the secret key, so it only runs when the metadata is
    // missing.
    //
    // EITHER WAY THE CREDIT COUNT COMES FROM THE CATALOGUE. Never from
    // metadata, never from the amount.
    let credits = 0;
    let productKey: string | null = null;
    let resolveNote: string | null = null;

    const fromMetadata = getProduct(read.productKey);
    if (fromMetadata && fromMetadata.kind === "one_time") {
      productKey = fromMetadata.key;
      credits = fromMetadata.credits * read.quantity;
    } else if (read.sessionId && API_KEY) {
      try {
        const controller = new AbortController();
        const timer = setTimeout(() => controller.abort(), LINE_ITEM_TIMEOUT_MS);
        const res = await fetch(
          `${STRIPE_API}/checkout/sessions/${encodeURIComponent(read.sessionId)}?expand[]=line_items`,
          { headers: { Authorization: `Bearer ${API_KEY}` }, signal: controller.signal },
        );
        clearTimeout(timer);
        if (res.ok) {
          const session = await res.json() as {
            line_items?: { data?: { quantity?: unknown; price?: { id?: unknown } | null }[] };
          };
          for (const item of session.line_items?.data ?? []) {
            const product = productForPriceId(item?.price?.id, (n) => Deno.env.get(n), "STRIPE");
            if (!product || product.kind !== "one_time") {
              resolveNote = `unmapped price ${String(item?.price?.id ?? "?")}`.slice(0, 200);
              continue;
            }
            const qtyRaw = typeof item?.quantity === "number" ? item.quantity : 1;
            const qty = Number.isInteger(qtyRaw) && qtyRaw > 0 && qtyRaw <= 100 ? qtyRaw : 1;
            credits += product.credits * qty;
            productKey = productKey === null || productKey === product.key ? product.key : "mixed";
          }
        } else {
          resolveNote = `line item lookup returned ${res.status}`;
        }
      } catch (e) {
        // A timeout or a network error here must NOT lose the payment. It is
        // recorded as unresolved and shows up in the dashboard panel.
        resolveNote = "line item lookup failed: " + String(e).slice(0, 120);
      }
    } else if (!API_KEY) {
      resolveNote = "no metadata.product_key and STRIPE_SECRET_KEY is not set";
    }

    if (resolveNote) {
      console.error(`stripe-webhook: ${resolveNote} (${read.sessionId})`);
      await logEvent("purchase_unmapped_price", read.userId, {
        provider: PROVIDER,
        event_id: read.eventId,
        session_id: read.sessionId,
        detail: resolveNote,
      });
    }

    const purchase: CreditPurchase = {
      provider: PROVIDER,
      eventId: read.eventId,
      userId: read.userId,
      productKey: credits > 0 ? productKey : null,
      credits,
      amountCents: read.amountTotal,
      currency: read.currency ? read.currency.toUpperCase() : null,
      // The SESSION id is the idempotency key at the transaction level. Both
      // grant events for one purchase carry the same session id, so the
      // unique index cannot be defeated by them arriving as two different
      // event ids.
      providerTxnId: read.sessionId,
      occurredAt: null,
    };

    const outcome = await applyCreditPurchase(store, purchase);
    return checkoutOutcomeResponse(json, outcome, read.eventId, read.sessionId, read.userId);
  }

  // =========================================================================
  // 2. INVOICES - the subscription grant
  // =========================================================================
  if (INVOICE_EVENT_TYPES.indexOf(eventType) !== -1) {
    const read = readInvoiceEvent(parsed);
    if (!read) return json({ error: "not an event" }, 400);

    if (INVOICE_GRANT_EVENTS.indexOf(read.eventType) === -1) {
      // invoice.payment_failed. Recorded, never granted: useful context next
      // to a subscription that stops renewing, but not money.
      await logEvent("payment_event", read.userId, {
        provider: PROVIDER,
        event_id: read.eventId,
        event_type: read.eventType,
        invoice_id: read.invoiceId,
        subscription_id: read.subscriptionId,
      });
      return json({ ok: true, ignored: read.eventType });
    }

    // Defensive, not a real state machine: unlike checkout.session.completed,
    // Stripe's docs give no case where invoice.paid fires before the money is
    // in. If this is ever false anyway it is not a "wait for a later event"
    // situation - there is no later event for this - so it is refused rather
    // than recorded, exactly like an impossible mode above.
    if (!read.paid) {
      console.error(`stripe-webhook: invoice.paid with paid=false (${read.invoiceId})`);
      await logEvent("purchase_needs_attention", read.userId, {
        provider: PROVIDER,
        event_id: read.eventId,
        invoice_id: read.invoiceId,
        reason: "invoice_not_actually_paid",
      });
      return json({ ok: true, needs_attention: "invoice_not_actually_paid" });
    }

    // WHAT WAS BOUGHT. metadata.product_key first (copied onto the invoice
    // from the subscription's own metadata - see _shared/stripe.ts). Unlike
    // Checkout, an invoice's line items are already IN the webhook payload,
    // so the fallback needs no API call: just the price id, mapped through
    // the same catalogue every other gateway path uses.
    const fromMetadata = getProduct(read.productKey);
    const fromPrice = fromMetadata ? null : productForPriceId(read.linePriceId, (n) => Deno.env.get(n), "STRIPE");
    const resolved = fromMetadata ?? fromPrice;
    // Only a subscription product is sane here. A bundle's price id turning
    // up on an invoice would mean the catalogue and Stripe's dashboard have
    // drifted, and that is exactly the kind of mismatch this refuses to
    // guess through.
    const product = resolved && resolved.kind === "subscription" ? resolved : null;

    const grant: SubscriptionInvoiceGrant = {
      provider: PROVIDER,
      eventId: read.eventId,
      userId: read.userId,
      productKey: product?.key ?? null,
      billingReason: read.billingReason,
      introCredits: product?.introCredits ?? 0,
      renewalCredits: product?.credits ?? 0,
      amountCents: read.amountPaid,
      currency: read.currency ? read.currency.toUpperCase() : null,
      // The INVOICE id. Idempotency at the transaction level, same role the
      // checkout session id plays for a one-time purchase.
      providerTxnId: read.invoiceId,
      occurredAt: null,
    };

    const outcome = await applySubscriptionCredit(store, grant);
    return checkoutOutcomeResponse(json, outcome, read.eventId, read.invoiceId, read.userId);
  }

  // =========================================================================
  // 3. SUBSCRIPTION STATUS - a mirror, never a grant
  // =========================================================================
  if (SUBSCRIPTION_STATUS_EVENTS.indexOf(eventType) !== -1) {
    const read = readSubscriptionStatusEvent(parsed);
    if (!read) return json({ error: "not an event" }, 400);

    if (!read.userId || !read.subscriptionId) {
      // Nothing to attach this to. Not money, so not a needs-attention row
      // in `purchases` - just a log line, because the account will still get
      // its credits from invoice.paid regardless of whether this mirror
      // landed.
      await logEvent("subscription_status_unresolved", null, {
        provider: PROVIDER,
        event_id: read.eventId,
        event_type: read.eventType,
        subscription_id: read.subscriptionId,
      });
      return json({ ok: true, unresolved: true });
    }

    const { error: updErr } = await admin
      .from("profiles")
      .update({
        subscription_status: read.status,
        subscription_id: read.subscriptionId,
        subscription_current_period_end: read.currentPeriodEnd
          ? new Date(read.currentPeriodEnd * 1000).toISOString()
          : null,
      })
      .eq("user_id", read.userId);

    if (updErr) {
      // Best effort, on purpose. This is a display mirror, not the grant
      // path: retrying it via a 500 would not make the row exist any more
      // than logging the failure does, and Stripe's retry budget is worth
      // saving for money that did not land.
      console.error(`stripe-webhook: could not mirror subscription status for ${read.userId}:`, updErr);
      return json({ ok: true, mirror_failed: true });
    }

    await logEvent("subscription_status_changed", read.userId, {
      provider: PROVIDER,
      event_id: read.eventId,
      subscription_id: read.subscriptionId,
      status: read.status,
    });
    return json({ ok: true, status: read.status });
  }

  // Anything else. 200, always - see the CHECKOUT_EVENT_TYPES comment above
  // for why retrying an event type this endpoint will never handle is worse
  // than ignoring it once.
  return json({ ok: true, ignored: eventType });
});

/** Shared tail for both grant paths (applyCreditPurchase and
 *  applySubscriptionCredit return the same GrantOutcome shape), so the
 *  status-code and logging decisions cannot drift between the bundle and the
 *  subscription. */
function checkoutOutcomeResponse(
  json: (body: unknown, status?: number) => Response,
  outcome:
    | { status: "granted"; credits: number; balance: number | null }
    | { status: "duplicate" }
    | { status: "no_user" }
    | { status: "unknown_product" }
    | { status: "grant_failed"; error: string }
    | { status: "store_error"; error: string },
  eventId: string,
  txnId: string | null,
  userId: string | null,
): Response {
  switch (outcome.status) {
    case "granted":
      console.log(
        `stripe-webhook: granted ${outcome.credits} credit(s) to ${userId} (${eventId}), balance ${outcome.balance}`,
      );
      return json({ ok: true, granted: outcome.credits, balance: outcome.balance });

    case "duplicate":
      // The correct answer to a retry, and to the second grant event for a
      // transaction that has already been paid out.
      return json({ ok: true, duplicate: true });

    case "no_user":
    case "unknown_product":
      // Recorded, granted nothing, needs a human. STILL A 200: retrying
      // produces the same answer for three days and teaches Stripe that this
      // endpoint is broken, which would cost the NEXT customer too.
      console.error(`stripe-webhook: ${outcome.status} for event ${eventId} (${txnId})`);
      return json({ ok: true, needs_attention: outcome.status });

    case "grant_failed":
    case "store_error":
      // Money moved and nothing was granted, for a reason that might not
      // repeat. 500 asks Stripe to try again, and the claim means a retry
      // cannot double grant.
      console.error(`stripe-webhook: ${outcome.status} for event ${eventId}: ${outcome.error}`);
      return json({ error: "could not apply purchase" }, 500);
  }
}

// ============================================================================
// OWNER SETUP
//
// 1. Two Stripe prices, in Product catalogue:
//      "Clapper Pro"            USD 5.00, RECURRING, monthly
//      "Clapper: 5 project bundle"   USD 20.00, one time
//    Copy both price ids (`price_...`).
//
// 2. Workbench > Webhooks > Create an event destination
//      Endpoint URL : https://<project-ref>.supabase.co/functions/v1/stripe-webhook
//      Events       : checkout.session.completed
//                     checkout.session.async_payment_succeeded
//                     checkout.session.async_payment_failed   (logged only)
//                     invoice.paid
//                     invoice.payment_failed                  (logged only)
//                     customer.subscription.created
//                     customer.subscription.updated
//                     customer.subscription.deleted
//    Reveal the signing secret (whsec_...). It differs between test and live
//    mode even for the same URL.
//
// 3. supabase secrets set STRIPE_WEBHOOK_SECRET='whsec_...'
//    supabase secrets set STRIPE_SECRET_KEY='sk_...'
//    supabase secrets set STRIPE_PRICE_PRO_MONTHLY='price_...'
//    supabase secrets set STRIPE_PRICE_BUNDLE_5='price_...'
//
// 4. Apply supabase/migrations/20260826170000_entitlements.sql FIRST, then
//    supabase functions deploy stripe-webhook --no-verify-jwt
//
// 5. When the checkout is built (see stripe-checkout/index.ts), a
//    SUBSCRIPTION session MUST carry subscription_data.metadata.user_id and
//    .product_key - that is what invoice.paid reads to know who to credit,
//    because an Invoice has no client_reference_id of its own. A one-time
//    bundle session carries client_reference_id and metadata.product_key
//    directly, exactly as before. Without the right one of these, the
//    relevant event records `user_unknown` and the owner fixes it by hand
//    from the Money panel.
//
// Test mode and live mode are separate price ids and separate signing
// secrets. Same variable names, different values, which is why no id is in
// this repo.
// ============================================================================
