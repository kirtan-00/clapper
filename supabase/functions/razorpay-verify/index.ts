import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { createClient } from "jsr:@supabase/supabase-js@2";
import { cors } from "../_shared/cors.ts";
import { getPlan } from "../_shared/plans.ts";

// Razorpay: verify a payment. Step two of two, and the only step that decides
// whether anybody actually gets anything.
//
// THE SIGNATURE IS THE WHOLE POINT. The browser tells us "this payment
// succeeded". The browser is not to be believed — it is trivially scripted.
// What makes the claim true is that Razorpay signed `order_id|payment_id` with
// our key secret, which only they and this function know. If the HMAC does not
// match, the answer is no, regardless of how convincing the rest of the payload
// looks.
//
// Web Crypto rather than Node's `crypto.createHmac`, for the same reason
// razorpay-order uses fetch instead of the SDK: this is Deno.

/** Constant-time compare. A plain === on a signature leaks, one byte at a time,
 *  how much of a guess was right — that is a real attack on a real HMAC, and
 *  the cost of doing it properly is four lines. */
function timingSafeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

async function hmacSha256Hex(message: string, secret: string): Promise<string> {
  const key = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const sig = await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(message));
  return [...new Uint8Array(sig)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

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
  const KEY_SECRET = Deno.env.get("RAZORPAY_KEY_SECRET");

  if (!KEY_SECRET) {
    console.error("razorpay-verify: RAZORPAY_KEY_SECRET not set");
    return new Response(
      JSON.stringify({ error: "Payments are not configured on this deployment." }),
      { status: 503, headers },
    );
  }

  // 1. Identity. The grant lands on a user, so there has to be one.
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

  // 2. All three fields, or nothing.
  let payload: {
    razorpay_order_id?: unknown;
    razorpay_payment_id?: unknown;
    razorpay_signature?: unknown;
  };
  try {
    payload = await req.json();
  } catch {
    return new Response(JSON.stringify({ error: "Bad JSON" }), { status: 400, headers });
  }
  const orderId = typeof payload.razorpay_order_id === "string" ? payload.razorpay_order_id : "";
  const paymentId = typeof payload.razorpay_payment_id === "string" ? payload.razorpay_payment_id : "";
  const signature = typeof payload.razorpay_signature === "string" ? payload.razorpay_signature : "";
  if (!orderId || !paymentId || !signature) {
    return new Response(
      JSON.stringify({ error: "Missing payment fields", verified: false }),
      { status: 400, headers },
    );
  }

  const admin = createClient(SUPABASE_URL, SERVICE, { auth: { persistSession: false } });

  // 3. The order must be one WE created, for THIS user. Without this check a
  // signature is still valid — it just might be someone else's valid payment,
  // replayed to attach their money to your account.
  const { data: row, error: rowErr } = await admin
    .from("payments")
    .select("order_id, user_id, plan, status")
    .eq("order_id", orderId)
    .maybeSingle();

  if (rowErr) {
    console.error("razorpay-verify: payments lookup failed", rowErr);
    return new Response(
      JSON.stringify({ error: "Could not verify right now. Try again.", verified: false }),
      { status: 500, headers },
    );
  }
  if (!row || row.user_id !== user.id) {
    console.error(`razorpay-verify: order ${orderId} not found for user ${user.id}`);
    return new Response(
      JSON.stringify({ error: "That payment does not belong to this account.", verified: false }),
      { status: 400, headers },
    );
  }

  // 4. THE CHECK.
  const expected = await hmacSha256Hex(`${orderId}|${paymentId}`, KEY_SECRET);
  if (!timingSafeEqual(expected, signature)) {
    // Record the failure and grant NOTHING. A mismatch is either a bug or an
    // attempt; either way it must never reach the is_pro write below.
    await admin.from("payments")
      .update({ status: "signature_failed", payment_id: paymentId, updated_at: new Date().toISOString() })
      .eq("order_id", orderId);
    console.error(`razorpay-verify: signature mismatch on order ${orderId}`);
    return new Response(
      JSON.stringify({ error: "Payment could not be verified.", verified: false }),
      { status: 400, headers },
    );
  }

  // 5. Verified. Idempotent from here: a double-submitted callback must not
  // extend the grant twice, so an already-paid row short-circuits.
  if (row.status === "paid") {
    return new Response(
      JSON.stringify({ verified: true, alreadyProcessed: true }),
      { status: 200, headers },
    );
  }

  const plan = getPlan(row.plan);
  const now = new Date();
  const grantDays = plan?.grantDays ?? 31;

  // Extend from whichever is later: now, or an existing unexpired grant. Buying
  // a second month in week three should add a month, not reset to one.
  const { data: profile } = await admin
    .from("profiles")
    .select("pro_until")
    .eq("user_id", user.id)
    .maybeSingle();
  const existing = profile?.pro_until ? new Date(profile.pro_until) : null;
  const base = existing && existing > now ? existing : now;
  const proUntil = new Date(base.getTime() + grantDays * 24 * 60 * 60 * 1000);

  const { error: grantErr } = await admin
    .from("profiles")
    .update({ is_pro: true, pro_until: proUntil.toISOString() })
    .eq("user_id", user.id);

  if (grantErr) {
    // The money is taken and the grant failed. Record it loudly — this is the
    // one failure in the flow that costs a real person real money and must be
    // findable in the logs and in the table.
    console.error(`razorpay-verify: PAID BUT NOT GRANTED for ${user.id} order ${orderId}`, grantErr);
    await admin.from("payments")
      .update({ status: "paid_grant_failed", payment_id: paymentId, updated_at: now.toISOString() })
      .eq("order_id", orderId);
    return new Response(
      JSON.stringify({
        error: "Payment went through but we could not switch Pro on. We can see it — email us and it will be fixed.",
        verified: true,
        granted: false,
      }),
      { status: 500, headers },
    );
  }

  await admin.from("payments")
    .update({ status: "paid", payment_id: paymentId, paid_at: now.toISOString(), updated_at: now.toISOString() })
    .eq("order_id", orderId);

  return new Response(
    JSON.stringify({ verified: true, granted: true, proUntil: proUntil.toISOString() }),
    { status: 200, headers },
  );
});
