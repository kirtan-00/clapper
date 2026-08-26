import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { createClient } from "jsr:@supabase/supabase-js@2";
import { cors } from "../_shared/cors.ts";
import { getProduct, priceEnvName } from "../_shared/products.ts";
import { isSuspended } from "../_shared/suspension.ts";

// Stripe: create a Checkout Session. Step one of two. The browser cannot do
// this, because it needs the secret key, which never leaves this function.
//
// THE POSTURE IS INHERITED FROM razorpay-order, DELIBERATELY. That file is the
// house standard for taking money and its header is worth reading. The three
// rules it established, restated because they matter more than anything else
// in this file:
//
//   1. THE AMOUNT IS NOT IN THE REQUEST. The client sends a PRODUCT KEY. The
//      price lives in _shared/products.ts and the Stripe price id lives in an
//      environment variable. There is no code path here that reads a number
//      out of the body, which is why the body is also REJECTED OUTRIGHT if it
//      carries one: a request shape with an `amount` field in it is a request
//      shape that will eventually be edited in devtools, and the honest time
//      to say no is before that field ever means anything.
//   2. SIGNED IN ONLY. What is being sold is a row keyed to a user. Without a
//      user there is nothing to attach it to and no way for the payer to ever
//      get it back. Unlike export-gate, this has no anonymous path.
//   3. NO npm SDK. `stripe-node` is Node-only. This is Deno, so it calls the
//      REST API with fetch and form encoding, which is all that SDK does here.
//
// ONE ENDPOINT, TWO CHECKOUT MODES, CHOSEN FROM THE CATALOGUE, NEVER FROM THE
// CLIENT. The client sends a product key ("pro_monthly" or "bundle_5"); this
// function looks that key up in products.ts, and `product.kind` - not
// anything in the request body - decides `mode: "payment"` vs
// `mode: "subscription"`. "mode" is in FORBIDDEN_BODY_FIELDS for exactly the
// same reason "amount" is: a field naming what should happen to your money is
// a field that gets edited in devtools, and the fix is to never read it.
//
// WHAT THIS FUNCTION IS RESPONSIBLE FOR THAT NOTHING ELSE CAN FIX. The webhook
// grants credits to whoever it can attribute a payment to, and for each mode
// that means a different field:
//   payment        client_reference_id / metadata.product_key on the SESSION
//   subscription   metadata.user_id / metadata.product_key on the
//                  SUBSCRIPTION (subscription_data[metadata][...]) - an
//                  Invoice has no client_reference_id of its own, and Stripe
//                  copies a subscription's metadata onto every invoice it
//                  generates, which is what invoice.paid reads.
// Both are set on every session created here regardless of mode - the ones
// the current mode does not need are simply unused - and the session-level
// ones are ASSERTED on Stripe's own response before the URL is handed to the
// browser: a session created without them would let a payment succeed with
// no account attached. subscription_data is NOT re-asserted here, because
// Stripe does not echo it back on session creation - a malformed
// subscription_data parameter fails the CREATE call itself (a 4xx below),
// which this function already treats as "could not start the payment".
//
// SECRETS: STRIPE_SECRET_KEY, STRIPE_PRICE_PRO_MONTHLY, STRIPE_PRICE_BUNDLE_5,
// and optionally STRIPE_MANAGED_PAYMENTS (see the long note below).

const STRIPE_SESSIONS_API = "https://api.stripe.com/v1/checkout/sessions";

// WHERE THE BUYER COMES BACK TO.
//
// These are QUERY STRINGS ON THE APP'S OWN INDEX, not paths, and that is not
// laziness. The app is a hash-free SPA whose entire router (src/ui/nav.ts) is
// four in-memory stacks: it does not read the URL at all, and it is served as
// static files from /app/ on GitHub Pages with no SPA fallback and no
// 404.html. A pretty path like /app/purchase-complete would therefore be a
// genuine 404 served by the host before any JavaScript ran. `/app/` with a
// query always resolves, always boots the app, and leaves a marker the client
// reads and then strips from the URL.
//
// {CHECKOUT_SESSION_ID} is a Stripe placeholder, substituted by them on the
// redirect. It is not a secret and it is not proof of payment: the app uses it
// only to say "we have seen this", and the grant comes from the webhook.
const APP_URL = "https://clapper.in/app/";
const SUCCESS_URL = `${APP_URL}?checkout=success&session_id={CHECKOUT_SESSION_ID}`;
const CANCEL_URL = `${APP_URL}?checkout=cancelled`;

/** Fields that must never appear in a request body here. Named individually so
 *  the refusal is specific and testable rather than a shrug about extra keys. */
const FORBIDDEN_BODY_FIELDS = [
  "amount",
  "amount_total",
  "unit_amount",
  "price",
  "price_id",
  "currency",
  "credits",
  "quantity",
  "user_id",
  "client_reference_id",
  // Whether this is a one-time payment or a subscription is a property of
  // the PRODUCT (products.ts), never of the request. See the header.
  "mode",
];

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
  const API_KEY = Deno.env.get("STRIPE_SECRET_KEY");

  // A missing key is a DEPLOY mistake, not a caller mistake, and the client
  // treats this exact code as "selling is not switched on yet" and falls back
  // to the interest probe rather than showing an error.
  if (!API_KEY) {
    console.error("stripe-checkout: STRIPE_SECRET_KEY not set");
    return new Response(
      JSON.stringify({ error: "Payments are not configured yet.", code: "not_configured" }),
      { status: 503, headers },
    );
  }

  // 1. Identity. No JWT, no session.
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

  // 2. Body. Product key only.
  let payload: Record<string, unknown>;
  try {
    payload = await req.json();
  } catch {
    return new Response(JSON.stringify({ error: "Bad JSON" }), { status: 400, headers });
  }

  // THE REFUSAL. A body that names a price or an amount is not a body this
  // endpoint knows how to be careful with, so it is not answered at all. This
  // is stricter than ignoring the field, on purpose: ignoring is invisible,
  // and a client that thinks it is setting the price should be told loudly
  // that it is not, while the code that would have read it does not exist.
  for (const field of FORBIDDEN_BODY_FIELDS) {
    if (field in payload) {
      console.error(`stripe-checkout: refused a body carrying "${field}" from ${user.id}`);
      return new Response(
        JSON.stringify({
          error: "The price is set by the server. Send a product key only.",
          code: "price_not_yours",
        }),
        { status: 400, headers },
      );
    }
  }

  const product = getProduct(payload.product);
  if (!product) {
    return new Response(
      JSON.stringify({ error: "Unknown product", code: "unknown_product" }),
      { status: 400, headers },
    );
  }

  // 3. Key to price id. The catalogue names the env var; the env var holds the
  // id. Neither the id nor the amount is ever taken from the caller.
  const envName = priceEnvName(product.key, "STRIPE");
  const priceId = envName ? Deno.env.get(envName) : undefined;
  if (!priceId) {
    console.error(`stripe-checkout: ${envName ?? "price env"} not set for ${product.key}`);
    return new Response(
      JSON.stringify({ error: "Payments are not configured yet.", code: "not_configured" }),
      { status: 503, headers },
    );
  }

  const admin = createClient(SUPABASE_URL, SERVICE, { auth: { persistSession: false } });

  // 4. Rate limit, same helper and same namespace shape the other paid
  // endpoints use. Creating a session is free for the caller and costs us an
  // API call to Stripe, which is exactly the shape of thing that gets hammered.
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

  // 5. A suspended account cannot start a purchase. Checked HERE and not in
  // the webhook, for the reason razorpay-order gave: refusing at session time
  // means a suspended user never reaches a checkout page, so there is never a
  // paid transaction for a booted account that the webhook has to decide about.
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

  // 6. A second, concurrent subscription is refused before it can be created.
  // Stripe would happily create it and bill the account twice a month; the
  // first-month bonus guard in the migration stops that second subscription
  // paying out the intro bonus again, but nothing stops it charging real
  // money unless it is caught here.
  //
  // Fails OPEN if the column is not there (the entitlements migration is not
  // applied yet) - same posture the old introductory-price check used. The
  // consequence of guessing wrong in that window is one avoidable support
  // email about a double charge; the consequence of failing closed would be
  // refusing every subscription purchase until a migration lands.
  if (product.kind === "subscription") {
    const { data: profile, error: profErr } = await admin
      .from("profiles")
      .select("subscription_status")
      .eq("user_id", user.id)
      .maybeSingle();
    const status = profile?.subscription_status as string | null | undefined;
    if (profErr) {
      console.error("stripe-checkout: could not read subscription_status, duplicate-subscription check skipped", profErr);
    } else if (status === "active" || status === "trialing" || status === "past_due") {
      return new Response(
        JSON.stringify({
          error: "You already have a Clapper Pro subscription. Manage it from your account, not a new checkout.",
          code: "already_subscribed",
        }),
        { status: 409, headers },
      );
    }
  }

  // 7. Create the session.
  //
  // Form encoded, because that is what Stripe's REST API takes. `line_items`
  // is one item, quantity one: nothing here sells baskets, and a quantity the
  // caller could choose is another number in the request that decides what
  // gets granted.
  //
  // MODE COMES FROM THE PRODUCT, NEVER FROM THE REQUEST. See the file header.
  const mode = product.kind === "subscription" ? "subscription" : "payment";

  const form = new URLSearchParams();
  form.set("mode", mode);
  form.set("line_items[0][price]", priceId);
  form.set("line_items[0][quantity]", "1");
  form.set("success_url", SUCCESS_URL);
  form.set("cancel_url", CANCEL_URL);
  // BOTH of these, deliberately, on every session regardless of mode.
  // client_reference_id is Stripe's own field for
  // it and is what the webhook prefers; metadata.user_id is the belt to that
  // brace, because a session that loses the account is a payment nobody can
  // attribute. metadata.product_key is what saves the webhook an API call.
  form.set("client_reference_id", user.id);
  form.set("metadata[user_id]", user.id);
  form.set("metadata[product_key]", product.key);
  // subscription_data.metadata is what invoice.paid actually reads (see
  // _shared/stripe.ts): Stripe copies a subscription's own metadata onto
  // every invoice it generates, and an Invoice has no client_reference_id of
  // its own to fall back to. Session-level metadata above is set too, but it
  // is the SESSION's metadata, not the subscription's, and invoice.paid never
  // sees it.
  if (mode === "subscription") {
    form.set("subscription_data[metadata][user_id]", user.id);
    form.set("subscription_data[metadata][product_key]", product.key);
  }
  // submit_type left unset: Stripe's own default ("auto") already picks
  // "Buy" for payment mode and "Subscribe" for subscription mode, which is
  // correct for both without this function knowing the wording.

  // MANAGED PAYMENTS: read the docs, decided OFF by default, switchable
  // without a code change.
  //
  // The owner's pasted snippet carried `managed_payments: { enabled: true }`,
  // and it is the single most consequential line in it, because Managed
  // Payments IS Stripe's merchant of record product: with it on, Stripe
  // becomes the seller and handles sales tax, VAT and GST in 80+ countries,
  // plus fraud, disputes and transaction-level support. That is precisely the
  // property that was given up by moving off Paddle.
  //
  // It is off by default anyway, for a reason that is not a technical
  // preference: Stripe's eligibility page lists the supported BUSINESS
  // LOCATIONS, and India is not among them (North America is CA and US, Asia
  // Pacific is AU, HK, JP and SG). It also requires activating Managed
  // Payments in the dashboard, accepting its own terms of service, an eligible
  // digital-goods tax code on every product, and API version 2025-03-31.basil
  // or later. Sending `managed_payments[enabled]=true` from an account that
  // has not done all that is an API error on every purchase.
  //
  // So it is an environment flag rather than a hardcoded value or an omission:
  // if the owner ever sells through an eligible entity, one secret turns it on
  // and the tax liability moves back off him, with no deploy of this file.
  if ((Deno.env.get("STRIPE_MANAGED_PAYMENTS") ?? "").toLowerCase() === "true") {
    form.set("managed_payments[enabled]", "true");
  }

  let res: Response;
  try {
    res = await fetch(STRIPE_SESSIONS_API, {
      method: "POST",
      headers: {
        "Authorization": `Bearer ${API_KEY}`,
        "Content-Type": "application/x-www-form-urlencoded",
      },
      body: form.toString(),
    });
  } catch (e) {
    console.error("stripe-checkout: fetch failed", e);
    return new Response(
      JSON.stringify({ error: "Could not reach the payment provider. Try again." }),
      { status: 502, headers },
    );
  }

  if (res.status === 401) {
    // Their API rejecting OUR key. Never surface this as anything the buyer
    // did wrong: it is our deploy that is broken.
    console.error("stripe-checkout: Stripe rejected our key (401)");
    return new Response(
      JSON.stringify({ error: "Payments are misconfigured. We have been told." }),
      { status: 500, headers },
    );
  }
  if (!res.ok) {
    const body = await res.text().catch(() => "");
    console.error(`stripe-checkout: Stripe ${res.status}: ${body.slice(0, 400)}`);
    return new Response(
      JSON.stringify({ error: "Could not start the payment. Try again." }),
      { status: 500, headers },
    );
  }

  const session = await res.json() as {
    id?: string;
    url?: string;
    mode?: string;
    client_reference_id?: string | null;
    metadata?: Record<string, string> | null;
  };

  // 8. THE ASSERTION. Read back off Stripe's own response, not off what we
  // meant to send. Only what the response actually echoes is checked -
  // Stripe does not return `subscription_data` on session creation, so the
  // subscription metadata cannot be re-verified here. That is not a gap: a
  // malformed `subscription_data[metadata]` parameter fails the CREATE call
  // itself, which is already handled above as a non-2xx and never reaches
  // this point. A session missing what IS checked is a payment the webhook
  // would record as `user_unknown` (one-time) or would sync no status for
  // (subscription), so nobody is sent to it. Refusing here costs one failed
  // tap; not refusing costs somebody their money and a support email.
  const missing: string[] = [];
  if (!session.id) missing.push("id");
  if (!session.url) missing.push("url");
  if (session.client_reference_id !== user.id) missing.push("client_reference_id");
  if (session.metadata?.product_key !== product.key) missing.push("metadata.product_key");
  if (session.mode && session.mode !== mode) missing.push(`mode=${session.mode}`);
  if (missing.length) {
    console.error(
      `stripe-checkout: REFUSING an unattributable session for ${user.id}: ${missing.join(", ")}`,
    );
    return new Response(
      JSON.stringify({ error: "Could not start the payment. Try again." }),
      { status: 500, headers },
    );
  }

  // 9. Record that a checkout was STARTED, as an analytics event and NOT as a
  // row in `purchases`.
  //
  // WHY NOT A LEDGER ROW, WHICH IS THE OBVIOUS THING TO DO. `purchases` has a
  // unique index on (provider, provider_txn_id) and the transaction id for a
  // Stripe purchase is the checkout session id. A row written here would
  // therefore own `cs_...` before the webhook ever arrives, the webhook's own
  // insert would hit that index and be silently ignored (it is an untargeted
  // ON CONFLICT DO NOTHING), its claim would then find no row for its event
  // id, it would answer "duplicate", AND THE CREDITS WOULD NEVER BE GRANTED.
  // Every single purchase would fail, quietly, with a 200 back to Stripe.
  //
  // The invariant is worth keeping anyway: a row in `purchases` means money
  // moved. An abandoned checkout is not money, and the dashboard says so out
  // loud rather than hedging every number with "or they closed the tab".
  // Abandoned checkouts are counted in the Money panel from these events
  // instead, which needs no schema and cannot break a grant.
  try {
    await admin.from("events").insert({
      user_id: user.id,
      name: "checkout_started",
      props: {
        provider: "stripe",
        session_id: session.id,
        product: product.key,
        mode,
        // For a subscription, `credits` alone is ambiguous (2 normally, 5 on
        // the first invoice, and which one applies is account state this
        // function never reads). Both numbers are logged instead of guessing.
        credits: product.kind === "one_time" ? product.credits : undefined,
        renewal_credits: product.kind === "subscription" ? product.credits : undefined,
        intro_credits: product.introCredits,
        amount_cents: product.amountCents,
        currency: product.currency,
      },
    });
  } catch {
    /* analytics is non-fatal, and the session already exists at Stripe */
  }

  return new Response(
    JSON.stringify({ url: session.url, session_id: session.id, product: product.key }),
    { status: 200, headers },
  );
});

// ============================================================================
// OWNER SETUP: see supabase/functions/stripe-webhook/index.ts for the full
// list. This function needs, additionally to the webhook's:
//
//   supabase secrets set STRIPE_SECRET_KEY='sk_...'
//   supabase functions deploy stripe-checkout
//
// Note: NO --no-verify-jwt here. The opposite of the webhook: this one is
// called by the app with a real Supabase session, and the platform's own JWT
// gate is a free extra lock in front of the check this function does itself.
//
// OPTIONAL, and worth reading the long comment above before setting:
//   supabase secrets set STRIPE_MANAGED_PAYMENTS='true'
// Only if the Stripe account is eligible (India is not a supported business
// location today) and Managed Payments has been activated in the dashboard.
// ============================================================================
