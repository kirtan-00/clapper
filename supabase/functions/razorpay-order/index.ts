import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { createClient } from "jsr:@supabase/supabase-js@2";
import { cors } from "../_shared/cors.ts";
import { getProduct } from "../_shared/products.ts";
import { isSuspended } from "../_shared/suspension.ts";

// UN-PARKED 2026-08-27. Razorpay is a SECOND provider, INR, alongside
// Stripe/Paddle in USD - not a replacement for either. The file used to
// carry a 2026-08-26 PARKED header written when the plan was Stripe/Paddle
// only; that plan changed the next day and this file is live work again.
// Read supabase/functions/stripe-checkout/index.ts first - this is the same
// posture, a gateway later, and everywhere the two differ it is because
// Razorpay's API differs, never because the posture does.
//
// Razorpay: create an order. Step one of two - the browser cannot do this,
// because it needs the key SECRET, which never leaves this function.
//
// WHY NO npm SDK. The `razorpay` package is Node-only (it wants `crypto` and
// `https` from Node core). Edge functions are Deno, so this calls the REST
// API with fetch and HTTP Basic auth, which is all that SDK does for this
// endpoint anyway. Verification (razorpay-verify) and the webhook
// (razorpay-webhook) do the same for the same reason.
//
// SIGNED IN ONLY. There is no point taking money from a session with no
// account attached: what is being sold is project credits on `profiles`,
// and without a user id there is nothing to grant them to and no way for the
// payer to ever get them back.
//
// THE AMOUNT IS NOT IN THE REQUEST. The client sends a PRODUCT KEY from
// _shared/products.ts; the price, the currency and the credit count are all
// looked up here, server side. There is no code path that reads a number out
// of the body. Paise, not rupees - Razorpay's orders API takes the amount in
// the smallest unit, so 699 rupees is 69900, and product.amountCents (named
// for the USD gateways, where a cent is the same kind of unit a paisa is -
// both are hundredths of the display currency) is passed straight through
// with no arithmetic anywhere in this file. An off-by-100 here is a real
// financial bug, which is exactly why there is no multiplication to get
// wrong: the catalogue already stores the smallest-unit integer.
//
// ONE ENDPOINT, ONE KIND OF PRODUCT. Razorpay's Orders API only knows how to
// take a single payment; it cannot sell a `subscription`-kind product, which
// needs Razorpay's separate Plans/Subscriptions API and a mandate flow this
// pair does not implement. A subscription product reaching this function is
// refused explicitly (step 2b) rather than silently mis-sold as a one-time
// order for its recurring price - that would charge once and never renew,
// which is worse than refusing.
//
// NO ROW IS WRITTEN HERE ANY MORE. The previous version of this file
// inserted a row into `payments` right after creating the order, and SWALLOWED
// the insert failure with a console line - bug #3 from the audit that
// rebuilt this pair. The fix is not a retry, it is removing the write
// entirely: `purchases` is keyed on (provider, provider_event_id), which for
// Razorpay is the PAYMENT id (see _shared/razorpay.ts's identityForPayment) -
// an id that does not exist yet at order-creation time, because no payment
// has happened. Writing a row here would have to key on something else (the
// order id), and `recordPurchase`'s insert is an UNTARGETED
// `on conflict do nothing` - it has to be, so that a retried grant event and
// a second grant EVENT for the same transaction both land safely - which
// means a pre-existing row for the order id would make the real grant
// path's own insert a silent no-op, and the credits would never be granted
// at all. (This is the same reason stripe-checkout does not write to
// `purchases` either; see its own header.) So the only record of an order
// being STARTED is the `checkout_started` analytics event at the bottom -
// which is not money, and is allowed to fail non-fatally - and the only
// record of money MOVING is written by razorpay-verify or razorpay-webhook,
// whichever gets there first, both keyed on the payment id, both routed
// through the same claim in _shared/entitlements.ts so neither can double
// grant against the other.

const RAZORPAY_ORDERS_API = "https://api.razorpay.com/v1/orders";

/** Razorpay's own floor for any order, confirmed at
 *  api.razorpay.com/v1/orders: 100 paise (rupee 1). A product priced below
 *  it is a typo in the catalogue, not a caller mistake, and fails loudly
 *  here rather than being handed to Razorpay to reject less clearly. This is
 *  a GATEWAY constraint, not a catalogue one, which is why it lives here and
 *  not in _shared/products.ts alongside BREAKDOWNS_PER_PROJECT and the like -
 *  Stripe and Paddle have their own floors and neither needs this number. */
const RAZORPAY_MIN_AMOUNT_PAISE = 100;

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

  // A missing key is a DEPLOY mistake, not a caller mistake - same code and
  // shape stripe-checkout uses, so the client can treat "payments are not
  // configured yet" identically for either gateway rather than special
  // casing which provider is missing its secret.
  if (!KEY_ID || !KEY_SECRET) {
    console.error("razorpay-order: RAZORPAY_KEY_ID / RAZORPAY_KEY_SECRET not set");
    return new Response(
      JSON.stringify({ error: "Payments are not configured yet.", code: "not_configured" }),
      { status: 503, headers },
    );
  }

  // 1. Identity. No JWT, no order.
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

  // 2. Product -> price. The only thing the client influences is WHICH
  // product; the amount, currency and credit count all come from the
  // catalogue.
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

  // 2b. THE REFUSAL. See the file header: Razorpay's Orders API cannot sell
  // a recurring product. Refusing here, loudly, is the honest answer -
  // silently treating it as a one-time charge would take the FULL price
  // once and then never renew, which under-delivers every month after the
  // first without ever looking like an error to anybody.
  if (product.kind !== "one_time") {
    console.error(`razorpay-order: refused a ${product.kind} product (${product.key}) - Orders API is one-time only`);
    return new Response(
      JSON.stringify({
        error: "This product is not available through this payment method yet.",
        code: "not_configured",
      }),
      { status: 503, headers },
    );
  }

  // Belt and braces against a typo in the catalogue itself.
  if (product.amountCents < RAZORPAY_MIN_AMOUNT_PAISE) {
    console.error(`razorpay-order: product ${product.key} is below the ${RAZORPAY_MIN_AMOUNT_PAISE} paise floor`);
    return new Response(
      JSON.stringify({ error: "Payments are not configured yet.", code: "not_configured" }),
      { status: 503, headers },
    );
  }

  const admin = createClient(SUPABASE_URL, SERVICE, { auth: { persistSession: false } });

  // 3. Rate limit, same helper and namespace the other paid endpoints share.
  // Order creation is cheap for us and free for the caller, which is exactly
  // the shape of thing that gets hammered.
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

  // 3b. A suspended account cannot start a new purchase. Checked HERE and
  // not in razorpay-verify/razorpay-webhook, for the same reason
  // stripe-checkout gives: refusing at order time means a suspended user
  // never reaches Razorpay's checkout modal, so there is never a captured
  // payment for a booted account that the grant path has to decide about.
  // Money that was never taken never needs reconciling.
  if (await isSuspended(admin, user.id)) {
    return new Response(
      JSON.stringify({
        error: "This account has been suspended. If you think that's a mistake, email us.",
        code: "suspended",
      }),
      { status: 403, headers },
    );
  }

  // 4. Create the order at Razorpay.
  //
  // `receipt` is our own reference, max 40 chars, and it is what makes a
  // payment traceable back to a person in the Razorpay dashboard without
  // putting an email in their system. The user id is a uuid (36 chars), so
  // it is truncated and paired with the product key; the authoritative link
  // is `notes` below (read back by razorpay-verify and razorpay-webhook via
  // fetchRazorpayOrder), not this string.
  const receipt = `${product.key.slice(0, 4)}_${user.id.replace(/-/g, "").slice(0, 24)}`;
  const basic = btoa(`${KEY_ID}:${KEY_SECRET}`);

  let res: Response;
  try {
    res = await fetch(RAZORPAY_ORDERS_API, {
      method: "POST",
      headers: {
        "Authorization": `Basic ${basic}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        amount: product.amountCents,
        currency: product.currency,
        receipt,
        // THE authoritative record of who bought what. Echoed back on
        // GET /v1/orders/:id, which is how razorpay-verify and
        // razorpay-webhook both resolve the buyer and the product - see
        // _shared/razorpay.ts's fetchRazorpayOrder. Keep it to ids; notes
        // are not a private field.
        notes: { user_id: user.id, product_key: product.key },
      }),
    });
  } catch (e) {
    console.error("razorpay-order: fetch failed", e);
    return new Response(
      JSON.stringify({ error: "Could not reach the payment provider. Try again." }),
      { status: 502, headers },
    );
  }

  if (res.status === 401) {
    // Their API rejecting OUR credentials. Never surface this as "your card
    // was declined" - it is our deploy that is wrong.
    console.error("razorpay-order: Razorpay rejected our key (401)");
    return new Response(
      JSON.stringify({ error: "Payments are misconfigured. We have been told." }),
      { status: 500, headers },
    );
  }
  if (!res.ok) {
    const body = await res.text().catch(() => "");
    console.error(`razorpay-order: Razorpay ${res.status}: ${body.slice(0, 400)}`);
    return new Response(
      JSON.stringify({ error: "Could not start the payment. Try again." }),
      { status: 500, headers },
    );
  }

  const order = await res.json() as { id?: string; amount?: number; currency?: string };
  if (!order.id) {
    console.error("razorpay-order: Razorpay returned no order id");
    return new Response(
      JSON.stringify({ error: "Could not start the payment. Try again." }),
      { status: 500, headers },
    );
  }

  // 5. Log that a checkout STARTED. Analytics only, not a ledger row - see
  // the file header for why a `purchases` row cannot be written here.
  // Non-fatal: the order already exists at Razorpay either way, and this is
  // the same trade-off stripe-checkout makes for `checkout_started`.
  try {
    await admin.from("events").insert({
      user_id: user.id,
      name: "checkout_started",
      props: {
        provider: "razorpay",
        order_id: order.id,
        product: product.key,
        credits: product.credits,
        amount_cents: product.amountCents,
        currency: product.currency,
      },
    });
  } catch {
    /* analytics is non-fatal */
  }

  // The key id is public by design - it is what the checkout modal needs.
  // The secret is not here and never will be.
  return new Response(
    JSON.stringify({
      order_id: order.id,
      amount: order.amount ?? product.amountCents,
      currency: order.currency ?? product.currency,
      key_id: KEY_ID,
      label: product.label,
    }),
    { status: 200, headers },
  );
});

// ============================================================================
// OWNER SETUP
//
//   supabase secrets set RAZORPAY_KEY_ID='rzp_...'
//   supabase secrets set RAZORPAY_KEY_SECRET='...'
//   supabase functions deploy razorpay-order
//
// NO --no-verify-jwt here - this is called by the app with a real Supabase
// session, unlike razorpay-webhook.
//
// See razorpay-webhook/index.ts for the webhook setup (RAZORPAY_WEBHOOK_SECRET,
// the dashboard destination, and the events to subscribe to) and
// _shared/products.ts for why this pair currently has nothing INR-priced to
// sell: the live catalogue is USD-only (pro_monthly, bundle_5), and a
// `one_time` product priced in INR needs to be added there before this
// function can create an order anyone in India would actually be charged
// correctly for. Everything in this file is already driven off whatever the
// catalogue says, so no code here changes when that happens.
// ============================================================================
