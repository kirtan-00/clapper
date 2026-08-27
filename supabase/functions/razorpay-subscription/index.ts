import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { createClient } from "jsr:@supabase/supabase-js@2";
import { cors } from "../_shared/cors.ts";
import { getProduct, priceEnvName } from "../_shared/products.ts";
import { isSuspended } from "../_shared/suspension.ts";

// NEW 2026-08-27. The recurring half of Razorpay, and the exact thing
// razorpay-order refuses in its step 2b: the Orders API cannot sell a
// subscription, so a `subscription`-kind product needs its own endpoint
// against Razorpay's Subscriptions API. Read razorpay-order/index.ts first -
// this file is deliberately the same shape (identity, rate limit, suspension,
// catalogue lookup, no client-supplied amount) and only the call at the end
// differs.
//
// WHAT THE CLIENT GETS BACK is a SUBSCRIPTION id, not an order id. Razorpay
// Checkout takes `subscription_id` where a one-off takes `order_id`, and that
// single field is the whole difference on the browser side.
//
// THIS ENDPOINT GRANTS NOTHING, exactly like razorpay-order. It cannot: no
// money has moved when it returns. The grant happens on the
// `subscription.charged` webhook, which is the only event that can tell a
// first charge from a renewal (via paid_count - see _shared/razorpay.ts's
// subscription section for why that matters and why invoice.paid is
// record-only). The consequence to hold on to: a person who closes the
// checkout sheet the instant it succeeds still gets what they paid for.
//
// PLAN IDS ARE ENVIRONMENT, NOT CODE. A Razorpay plan id is minted inside the
// owner's own Razorpay account and differs between test and live mode, so it
// cannot be hardcoded any more than a Stripe price id can. It comes through
// the table _shared/products.ts already maintains for exactly this:
// PRICE_ENV_SUFFIX_BY_PRODUCT + priceEnvName(key, "RAZORPAY"), which resolves
// pro_monthly to RAZORPAY_PRICE_PRO_MONTHLY and studio_plus to
// RAZORPAY_PRICE_STUDIO_PLUS. A product whose env var is unset is a DEPLOY
// mistake and answers 503 not_configured, never a guess at which plan was
// probably meant.

const RAZORPAY_SUBSCRIPTIONS_API = "https://api.razorpay.com/v1/subscriptions";

/**
 * Razorpay requires `total_count` - the number of billing cycles - at
 * creation time and has no "until cancelled" option. This is ten years of
 * monthly cycles, which is not a commitment the customer makes (they can
 * cancel any time and are only ever charged per cycle) but an upper bound
 * the API insists on. Chosen long enough that nobody's subscription quietly
 * stops renewing while they are still paying attention, which is the only
 * failure this number can cause.
 */
const TOTAL_CYCLES = 120;

Deno.serve(async (req: Request) => {
  const origin = req.headers.get("origin");
  const headers = { ...cors(origin), "Content-Type": "application/json" };

  if (req.method === "OPTIONS") return new Response("ok", { headers });
  if (req.method !== "POST") {
    return new Response(JSON.stringify({ error: "POST only" }), { status: 405, headers });
  }

  const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
  const ANON = Deno.env.get("SUPABASE_ANON_KEY")!;
  const SERVICE = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
  const KEY_ID = Deno.env.get("RAZORPAY_KEY_ID");
  const KEY_SECRET = Deno.env.get("RAZORPAY_KEY_SECRET");

  if (!KEY_ID || !KEY_SECRET) {
    console.error("razorpay-subscription: RAZORPAY_KEY_ID / RAZORPAY_KEY_SECRET not set");
    return new Response(
      JSON.stringify({ error: "Payments are not configured yet.", code: "not_configured" }),
      { status: 503, headers },
    );
  }

  // 1. Identity. No JWT, no subscription.
  const authHeader = req.headers.get("Authorization");
  const userClient = createClient(SUPABASE_URL, ANON, {
    global: { headers: { Authorization: authHeader ?? "" } },
  });
  const { data: { user } } = await userClient.auth.getUser();
  if (!user) {
    return new Response(
      JSON.stringify({ error: "Sign in first.", code: "SIGNIN_REQUIRED" }),
      { status: 401, headers },
    );
  }

  // 2. Product. The client names a key and nothing else; the plan, the price
  // and the credit count all come from our side.
  let payload: { product?: unknown };
  try {
    payload = await req.json();
  } catch {
    return new Response(JSON.stringify({ error: "Bad JSON" }), { status: 400, headers });
  }
  const product = getProduct(payload.product);
  if (!product) {
    return new Response(
      JSON.stringify({ error: "Unknown product", code: "unknown_product" }),
      { status: 400, headers },
    );
  }

  // 2b. The mirror of razorpay-order's refusal, in the other direction. A
  // one_time key here would create a RECURRING charge for something sold as
  // a single purchase - billing somebody every month for a credit pack they
  // bought once. Refuse rather than accommodate.
  if (product.kind !== "subscription") {
    console.error(`razorpay-subscription: refused a ${product.kind} product (${product.key})`);
    return new Response(
      JSON.stringify({
        error: "This product is not sold as a subscription.",
        code: "unknown_product",
      }),
      { status: 400, headers },
    );
  }

  const envName = priceEnvName(product.key, "RAZORPAY");
  const planId = envName ? Deno.env.get(envName) : undefined;
  if (!planId) {
    console.error(`razorpay-subscription: ${envName ?? "plan env var"} not set for ${product.key}`);
    return new Response(
      JSON.stringify({ error: "Payments are not configured yet.", code: "not_configured" }),
      { status: 503, headers },
    );
  }

  const admin = createClient(SUPABASE_URL, SERVICE, { auth: { persistSession: false } });

  // 3. Same rate limit namespace as every other paid endpoint.
  const { data: rateOk, error: rateErr } = await admin.rpc("rate_limit_check", {
    p_key: "pay:" + user.id,
    p_window_secs: 60,
    p_max: 10,
  });
  if (rateErr || rateOk === false) {
    return new Response(
      JSON.stringify({ error: "Too fast. Give it a moment and try again." }),
      { status: 429, headers },
    );
  }

  // 3b. A suspended account cannot start a subscription, for the reason
  // razorpay-order gives at length: refusing before the checkout modal means
  // there is never a captured payment for a booted account to reconcile.
  if (await isSuspended(admin, user.id)) {
    return new Response(
      JSON.stringify({
        error: "This account has been suspended. If you think that's a mistake, email us.",
        code: "suspended",
      }),
      { status: 403, headers },
    );
  }

  // 4. Create the subscription at Razorpay.
  const basic = btoa(`${KEY_ID}:${KEY_SECRET}`);

  let res: Response;
  try {
    res = await fetch(RAZORPAY_SUBSCRIPTIONS_API, {
      method: "POST",
      headers: {
        "Authorization": `Basic ${basic}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        plan_id: planId,
        total_count: TOTAL_CYCLES,
        quantity: 1,
        // Razorpay emails the customer its own receipts. Left ON: a
        // recurring charge somebody does not recognise is a chargeback, and
        // the cheapest way to prevent one is for them to have been told.
        customer_notify: 1,
        // THE authoritative record of who subscribed to what. Echoed back on
        // every subscription.charged delivery inside
        // payload.subscription.entity.notes, which is how the webhook
        // resolves the buyer without an extra API call. Ids only; notes are
        // not a private field.
        notes: { user_id: user.id, product_key: product.key },
      }),
    });
  } catch (e) {
    console.error("razorpay-subscription: fetch failed", e);
    return new Response(
      JSON.stringify({ error: "Could not reach the payment provider. Try again." }),
      { status: 502, headers },
    );
  }

  if (res.status === 401) {
    console.error("razorpay-subscription: Razorpay rejected our key (401)");
    return new Response(
      JSON.stringify({ error: "Payments are misconfigured. We have been told." }),
      { status: 500, headers },
    );
  }
  if (!res.ok) {
    const body = await res.text().catch(() => "");
    console.error(`razorpay-subscription: Razorpay ${res.status}: ${body.slice(0, 400)}`);
    return new Response(
      JSON.stringify({ error: "Could not start the subscription. Try again." }),
      { status: 500, headers },
    );
  }

  const sub = await res.json() as { id?: string; status?: string };
  if (!sub.id) {
    console.error("razorpay-subscription: Razorpay returned no subscription id");
    return new Response(
      JSON.stringify({ error: "Could not start the subscription. Try again." }),
      { status: 500, headers },
    );
  }

  // 5. Analytics only. NOT a ledger row - see razorpay-order's header for the
  // full reasoning on why writing a `purchases` row before money moves would
  // make the real grant dedupe against it and silently pay out nothing.
  try {
    await admin.from("events").insert({
      user_id: user.id,
      name: "checkout_started",
      props: {
        provider: "razorpay",
        subscription_id: sub.id,
        plan_id: planId,
        product: product.key,
        credits: product.credits,
        amount_cents: product.amountCents,
        currency: product.currency,
      },
    });
  } catch {
    /* analytics is non-fatal */
  }

  return new Response(
    JSON.stringify({
      subscription_id: sub.id,
      amount: product.amountCents,
      currency: product.currency,
      key_id: KEY_ID,
      label: product.label,
    }),
    { status: 200, headers },
  );
});

// ============================================================================
// OWNER SETUP
//
//   supabase secrets set RAZORPAY_PRICE_PRO_MONTHLY='plan_...'
//   supabase secrets set RAZORPAY_PRICE_STUDIO_PLUS='plan_...'
//   supabase functions deploy razorpay-subscription
//
// NO --no-verify-jwt - this is called by the app with a real session. The
// entry is declared in supabase/config.toml so a redeploy cannot forget it,
// which is exactly the mistake that made razorpay-webhook 401 every real
// delivery until 2026-08-27.
//
// THE WEBHOOK MUST SUBSCRIBE subscription.charged, or nothing bought here
// ever grants. order.paid alone does not cover subscriptions.
// ============================================================================
