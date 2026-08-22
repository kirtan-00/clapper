import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { createClient } from "jsr:@supabase/supabase-js@2";
import { cors } from "../_shared/cors.ts";
import { getPlan, MIN_AMOUNT_PAISE } from "../_shared/plans.ts";

// Razorpay: create an order. Step one of two — the browser cannot do this,
// because it needs the key SECRET, which never leaves this function.
//
// WHY NO npm SDK. The `razorpay` package is Node-only (it wants `crypto` and
// `https` from Node core). Edge functions are Deno, so this calls the REST API
// with fetch and HTTP Basic auth, which is all that SDK does for this endpoint
// anyway. Verification (razorpay-verify) uses Web Crypto for the same reason.
//
// SIGNED IN ONLY. There is no point taking money from a session with no account
// attached: the thing being sold is a flag on `profiles`, and without a user id
// there is nothing to set it on and no way for the payer to ever get it back.
// Unlike export-gate, which deliberately serves signed-out callers, this refuses.
//
// THE AMOUNT IS NOT IN THE REQUEST. See _shared/plans.ts. The client sends a
// plan key; the price is looked up here. This is the whole security posture of
// the endpoint and it is why the request body has no `amount` field to trust.

const RAZORPAY_API = "https://api.razorpay.com/v1/orders";

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

  // A missing key is a DEPLOY mistake, not a caller mistake. Say so distinctly
  // rather than returning a generic 500 that looks like Razorpay was down.
  if (!KEY_ID || !KEY_SECRET) {
    console.error("razorpay-order: RAZORPAY_KEY_ID / RAZORPAY_KEY_SECRET not set");
    return new Response(
      JSON.stringify({ error: "Payments are not configured on this deployment." }),
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

  // 2. Plan -> price. The only number the client influences is WHICH plan.
  let payload: { plan?: unknown };
  try {
    payload = await req.json();
  } catch {
    return new Response(JSON.stringify({ error: "Bad JSON" }), { status: 400, headers });
  }
  const plan = getPlan(payload.plan);
  if (!plan) {
    return new Response(JSON.stringify({ error: "Unknown plan" }), { status: 400, headers });
  }
  // Belt and braces against a typo in the price list itself.
  if (plan.amount < MIN_AMOUNT_PAISE) {
    console.error(`razorpay-order: plan ${plan.key} is below the ${MIN_AMOUNT_PAISE} paise floor`);
    return new Response(
      JSON.stringify({ error: "Payments are not configured on this deployment." }),
      { status: 503, headers },
    );
  }

  const admin = createClient(SUPABASE_URL, SERVICE, { auth: { persistSession: false } });

  // 3. Rate limit, same helper the other functions use. Order creation is cheap
  // for us and free for the caller, which is exactly the shape of thing that
  // gets hammered.
  const { data: rateOk, error: rateErr } = await admin.rpc("rate_limit_check", {
    p_key: "pay:" + user.id,
    p_window_secs: 60,
    p_max: 10,
  });
  if (rateErr || rateOk === false) {
    return new Response(
      JSON.stringify({ error: "Too fast — give it a moment and try again." }),
      { status: 429, headers },
    );
  }

  // 3b. A suspended account cannot start a new purchase. This is deliberately
  // checked here and not in razorpay-verify: refusing at ORDER time means a
  // suspended user never gets as far as Razorpay's checkout modal, so there is
  // no HMAC-verified payment sitting in `payments` for a booted account that
  // razorpay-verify would then have to decide whether to grant against. Money
  // that was never taken never needs reconciling.
  const { data: profile } = await admin
    .from("profiles")
    .select("is_suspended")
    .eq("user_id", user.id)
    .maybeSingle();
  if (profile?.is_suspended === true) {
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
  // putting an email in their system. The user id is a uuid (36 chars), so it
  // is truncated and paired with the plan; the authoritative link is the
  // payments row written by razorpay-verify, not this string.
  const receipt = `${plan.key.slice(0, 4)}_${user.id.replace(/-/g, "").slice(0, 24)}`;
  const basic = btoa(`${KEY_ID}:${KEY_SECRET}`);

  let res: Response;
  try {
    res = await fetch(RAZORPAY_API, {
      method: "POST",
      headers: {
        "Authorization": `Basic ${basic}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        amount: plan.amount,
        currency: plan.currency,
        receipt,
        // Echoed back to us on the webhook and visible in the dashboard. Keep
        // it to ids — notes are not a private field.
        notes: { user_id: user.id, plan: plan.key },
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
    // was declined" — it is our deploy that is wrong.
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

  // 5. Record the attempt BEFORE the modal opens, so a payment that succeeds at
  // Razorpay but never reaches our verify endpoint (browser closed, network
  // dropped mid-callback) is still reconcilable against the dashboard rather
  // than being money we have no row for.
  const { error: insErr } = await admin.from("payments").insert({
    order_id: order.id,
    user_id: user.id,
    plan: plan.key,
    amount: plan.amount,
    currency: plan.currency,
    status: "created",
  });
  if (insErr) {
    // Do NOT fail the request. The order exists at Razorpay either way, and
    // refusing here would leave an orphan order AND block a paying customer.
    console.error("razorpay-order: could not record attempt", insErr);
  }

  // The key id is public by design — it is what the checkout modal needs. The
  // secret is not here and never will be.
  return new Response(
    JSON.stringify({
      order_id: order.id,
      amount: order.amount ?? plan.amount,
      currency: order.currency ?? plan.currency,
      key_id: KEY_ID,
      label: plan.label,
    }),
    { status: 200, headers },
  );
});
