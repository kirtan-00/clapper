import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { createClient } from "jsr:@supabase/supabase-js@2";
import { verifyStripeWebhook } from "../_shared/webhook.ts";
import { getProduct, productForPriceId } from "../_shared/products.ts";
import { supabaseEntitlementStore } from "../_shared/store.ts";
import { applyCreditPurchase, type CreditPurchase } from "../_shared/entitlements.ts";
import {
  CHECKOUT_GRANT_EVENTS,
  CHECKOUT_NOTED_EVENTS,
  readCheckoutEvent,
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
// STRIPE IS NOT A MERCHANT OF RECORD. Paddle, which this replaced, took on the
// sales tax liability as the seller. Stripe does not: the owner is the seller
// and the tax is his. Nothing in this file assumes otherwise. `amount_total`
// is recorded exactly as charged and is never treated as the catalogue price.
//
// SECRETS (owner sets, never in this repo):
//   STRIPE_WEBHOOK_SECRET   the endpoint signing secret, whsec_...
//   STRIPE_SECRET_KEY       only for the line-item fallback below, sk_...
//   STRIPE_PRICE_INTRO_5    price id for the 5 USD / 5 projects first purchase
//   STRIPE_PRICE_CREDIT_1   price id for the 3 USD / 1 project standing buy

const PROVIDER = "stripe";
const STRIPE_API = "https://api.stripe.com/v1";
/** The line-item fallback is a network call inside a request Stripe is timing.
 *  It gets one short go, then gives up and records rather than hangs. */
const LINE_ITEM_TIMEOUT_MS = 3000;

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

  const read = readCheckoutEvent(parsed);
  if (!read) return json({ error: "not an event" }, 400);

  const admin = createClient(SUPABASE_URL, SERVICE, { auth: { persistSession: false } });

  const logEvent = async (name: string, userId: string | null, props: Record<string, unknown>) => {
    try {
      await admin.from("events").insert({ user_id: userId, name, props });
    } catch {
      /* analytics is non-fatal */
    }
  };

  // 3. Events we are not here for. 200, always. Stripe retries a non-2xx for
  // three days and then marks the delivery failed; answering 500 to an event
  // type that will never be handled is sixty pointless retries and a noisy
  // dashboard.
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

  // 4. IS THE MONEY ACTUALLY IN? This, not the event name, is what authorises
  // a grant. `checkout.session.completed` fires for a delayed payment method
  // (ACH, bank transfer) with payment_status `unpaid`, and the funds arrive
  // later with `checkout.session.async_payment_succeeded`.
  //
  // An unpaid session writes NO purchases row, deliberately. If it did, the
  // unique index on the transaction id would then block the event that arrives
  // when the money actually lands, and the customer would pay and get nothing.
  // A row in `purchases` means money moved; a promise is not money.
  if (!read.moneyIsIn) {
    await logEvent("payment_pending", read.userId, {
      provider: PROVIDER,
      event_id: read.eventId,
      session_id: read.sessionId,
      payment_status: read.paymentStatus,
    });
    return json({ ok: true, pending: read.paymentStatus });
  }

  // A subscription session should be impossible: nothing here sells one, and
  // the prices carry no `recurring` block. If one ever appears it is a
  // configuration mistake, and guessing what it entitles somebody to would be
  // worse than recording it and stopping.
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

  // 5. WHAT WAS BOUGHT.
  //
  // Preferred: `metadata.product_key`, written by our own server when it
  // created the Checkout Session. No network call, and it survives a price id
  // being rotated in the Stripe dashboard.
  //
  // Fallback: LINE ITEMS ARE NOT IN THE WEBHOOK PAYLOAD. Stripe's fulfilment
  // guide is explicit that the session must be retrieved with `line_items`
  // expanded to see what was actually bought. That costs one API call with the
  // secret key, so it only runs when the metadata is missing.
  //
  // EITHER WAY THE CREDIT COUNT COMES FROM THE CATALOGUE. Never from metadata,
  // never from the amount. metadata is a string bag; a field reading
  // `credits: 500` is ignored by construction because nothing reads it.
  let credits = 0;
  let productKey: string | null = null;
  let resolveNote: string | null = null;

  const fromMetadata = getProduct(read.productKey);
  if (fromMetadata) {
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
          if (!product) {
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
    // Logged as an EVENT, not only to the console. The parked Paddle webhook
    // already did this and the Stripe one did not, which is exactly the kind
    // of drift the shared seam exists to prevent: a console line is invisible
    // in the dashboard, and an unmapped price is a purchase somebody made.
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
    // Recorded as charged. Under a non-MoR gateway this is the gross the buyer
    // paid us, tax included where tax was collected, and the liability for
    // that tax is the owner's.
    amountCents: read.amountTotal,
    currency: read.currency ? read.currency.toUpperCase() : null,
    // The SESSION id is the idempotency key at the transaction level. Both
    // grant events for one purchase carry the same session id, so the unique
    // index cannot be defeated by them arriving as two different event ids.
    providerTxnId: read.sessionId,
    occurredAt: null,
  };

  const store = supabaseEntitlementStore(admin, logEvent);
  const outcome = await applyCreditPurchase(store, purchase);

  switch (outcome.status) {
    case "granted":
      console.log(
        `stripe-webhook: granted ${outcome.credits} credit(s) to ${read.userId} (${read.eventId}), balance ${outcome.balance}`,
      );
      return json({ ok: true, granted: outcome.credits, balance: outcome.balance });

    case "duplicate":
      // The correct answer to a retry, and to the second grant event for a
      // session that has already been paid out.
      return json({ ok: true, duplicate: true });

    case "no_user":
    case "unknown_product":
      // Recorded, granted nothing, needs a human. STILL A 200: retrying
      // produces the same answer for three days and teaches Stripe that this
      // endpoint is broken, which would cost the NEXT customer too.
      console.error(
        `stripe-webhook: ${outcome.status} for event ${read.eventId} session ${read.sessionId}`,
      );
      return json({ ok: true, needs_attention: outcome.status });

    case "grant_failed":
    case "store_error":
      // Money moved and nothing was granted, for a reason that might not
      // repeat. 500 asks Stripe to try again, and the claim means a retry
      // cannot double grant.
      console.error(`stripe-webhook: ${outcome.status} for event ${read.eventId}: ${outcome.error}`);
      return json({ error: "could not apply purchase" }, 500);
  }
});

// ============================================================================
// OWNER SETUP
//
// 1. Two prices, both ONE TIME (no recurring block), in the Stripe dashboard
//    under Product catalogue:
//      "Clapper: 5 projects"  USD 5.00   first purchase only, enforced by us
//      "Clapper: 1 project"   USD 3.00
//    Copy both price ids. In Stripe they look like `price_...`.
//
// 2. Workbench > Webhooks > Create an event destination
//      Endpoint URL : https://<project-ref>.supabase.co/functions/v1/stripe-webhook
//      Events       : checkout.session.completed
//                     checkout.session.async_payment_succeeded
//                     checkout.session.async_payment_failed   (optional, logged only)
//    Reveal the signing secret (whsec_...). It differs between test and live
//    mode even for the same URL.
//
// 3. supabase secrets set STRIPE_WEBHOOK_SECRET='whsec_...'
//    supabase secrets set STRIPE_SECRET_KEY='sk_...'
//    supabase secrets set STRIPE_PRICE_INTRO_5='price_...'
//    supabase secrets set STRIPE_PRICE_CREDIT_1='price_...'
//
// 4. Apply supabase/migrations/20260826170000_entitlements.sql FIRST, then
//    supabase functions deploy stripe-webhook --no-verify-jwt
//
// 5. When the checkout is built, the Checkout Session MUST carry the account:
//      client_reference_id : the signed-in user's uuid
//      metadata            : { product_key: 'credits_intro_5' | 'credits_1' }
//    Without one of those this function records `user_unknown`, grants
//    nothing, and the owner has to fix it by hand from the dashboard.
//
// Test mode and live mode are separate price ids and separate signing secrets.
// Same variable names, different values, which is why no id is in this repo.
// ============================================================================
