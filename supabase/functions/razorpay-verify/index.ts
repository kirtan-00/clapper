import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { createClient } from "jsr:@supabase/supabase-js@2";
import { cors } from "../_shared/cors.ts";
import { hmacSha256Hex, timingSafeEqualHex } from "../_shared/webhook.ts";
import { supabaseEntitlementStore } from "../_shared/store.ts";
import { applyCreditPurchase, type CreditPurchase, type GrantOutcome } from "../_shared/entitlements.ts";
import {
  fetchRazorpayOrder,
  handshakeMessage,
  identityForOrder,
  resolveOneTimeProduct,
} from "../_shared/razorpay.ts";

// UN-PARKED 2026-08-27, and REBUILT around the same claim-based grant
// razorpay-webhook uses, not the old profiles.is_pro/pro_until model this
// file used to write. Read razorpay-order/index.ts's header first for the
// posture, and razorpay-webhook/index.ts's header for why order.paid, not
// payment.captured, is the event this file's grant now has to agree with.
//
// THIS IS A FAST PATH, NOT THE AUTHORITATIVE ONE. razorpay-webhook is. This
// function exists so the browser gets an immediate answer ("you now have 5
// more credits") instead of waiting on Razorpay to redeliver its own
// webhook, which is not instant. Both paths build the IDENTICAL identity
// for the same order (_shared/razorpay.ts's identityForOrder, keyed on the
// ORDER id) and both call the same applyCreditPurchase, so whichever of the
// two gets here first wins the grant and the other is answered `duplicate` -
// see _shared/entitlements.ts's own header for why that is safe under
// concurrency and not a race. If the webhook secret is ever unset or the
// dashboard destination is ever removed, this file is what stands between a
// buyer and a purchase that grants nothing - which is exactly the GAP the
// original audit found in the version of this file that existed before the
// rebuild, except now it is at least idempotent, ownership-checked, and
// catalogue-driven instead of trusting a local `payments` row.
//
// THE SIGNATURE IS THE WHOLE POINT. The browser tells us "this payment
// succeeded". The browser is not to be believed - it is trivially scripted.
// What makes the claim true is that Razorpay signed `order_id|payment_id`
// with our KEY SECRET, which only they and this function know. If the HMAC
// does not match, the answer is no, regardless of how convincing the rest of
// the payload looks.
//
// THE HANDSHAKE SIGNATURE PROVES AUTHENTICITY, NOT SETTLEMENT. Auto-capture
// makes the two coincide almost always, but "signed by Razorpay" and "the
// money is actually captured" are two different facts, and only the second
// one is worth a grant. So a verified signature is followed by fetching the
// ORDER back from Razorpay (fetchRazorpayOrder) and requiring status
// "paid" before anything is granted - the same check razorpay-webhook makes
// off order.paid's own payload, just fetched instead of delivered.
//
// Web Crypto rather than Node's `crypto.createHmac`, for the same reason
// razorpay-order uses fetch instead of the SDK: this is Deno. The primitives
// (hmacSha256Hex, timingSafeEqualHex) live in _shared/webhook.ts because they
// are the same arithmetic the webhook signature check uses - a different
// secret and a different message, never the same call, but no reason to
// duplicate the HMAC and the constant-time compare a second time.

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
    console.error("razorpay-verify: RAZORPAY_KEY_ID / RAZORPAY_KEY_SECRET not set");
    return new Response(
      JSON.stringify({ error: "Payments are not configured yet.", code: "not_configured" }),
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

  // NOT checking is_suspended here, on purpose - same reasoning the previous
  // version of this file gave: razorpay-order already refuses to create an
  // order for a suspended account, so a real payment reaching this function
  // from a suspended caller should be near impossible. If one arrives
  // anyway, real money may already have moved at Razorpay's end, and
  // refusing the grant here would recreate the exact "paid, granted
  // nothing" failure this whole pair exists to avoid. A suspended account's
  // export-gate and breakdown checks read is_suspended before they read
  // anything credits related, so granting credits here does not hand back
  // any access while suspended - it just sits there until an admin lifts it.

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
  const logEvent = async (name: string, userId: string | null, props: Record<string, unknown>) => {
    try {
      await admin.from("events").insert({ user_id: userId, name, props });
    } catch {
      /* analytics is non-fatal */
    }
  };

  // 3. THE HANDSHAKE CHECK.
  const expected = await hmacSha256Hex(handshakeMessage(orderId, paymentId), KEY_SECRET);
  if (!timingSafeEqualHex(expected, signature)) {
    // BUG #2, FIXED. The previous version of this file wrote
    // `status: 'signature_failed'` to the `payments` row for THIS order id
    // UNCONDITIONALLY - no check that the row belonged to the caller, no
    // check that it even existed yet. Since order_id is attacker-supplied
    // (it is one of the three fields this endpoint reads straight from the
    // request body), the owner of an already-PAID order could resubmit its
    // real order_id with a garbage signature and flip that row's state,
    // corrupting a ledger a human would later trust to reconcile against.
    // The fix here is not a status guard on the write - it is that there is
    // NOTHING TO WRITE. This pair no longer keeps a row keyed on the order
    // id that a failed handshake could reach: `purchases` only ever gets a
    // row from `recordPurchase`, called a few lines below, and a failed
    // signature never reaches that call. A mismatch produces an analytics
    // event only - `logEvent` is fire-and-forget, keyed to nothing an
    // attacker chose to write over, and read by nobody as evidence a
    // payment happened. Grant nothing, corrupt nothing.
    await logEvent("razorpay_signature_mismatch", user.id, { order_id: orderId, payment_id: paymentId });
    console.error(`razorpay-verify: signature mismatch on order ${orderId} from ${user.id}`);
    return new Response(
      JSON.stringify({ error: "Payment could not be verified.", verified: false }),
      { status: 400, headers },
    );
  }

  // 4. Read the order back off Razorpay - who it belongs to, what it was
  // for, and whether the money is actually in. See the file header for why
  // the handshake alone proves authenticity but not settlement.
  const ORDER_FETCH_TIMEOUT_MS = 5000;
  const fetched = await fetchRazorpayOrder(orderId, KEY_ID, KEY_SECRET, ORDER_FETCH_TIMEOUT_MS);
  if (!fetched.ok) {
    console.error(`razorpay-verify: could not fetch order ${orderId}: ${fetched.reason} ${fetched.detail}`);
    return new Response(
      JSON.stringify({ error: "Could not verify right now. Try again.", verified: false }),
      { status: 500, headers },
    );
  }
  const order = fetched.order;

  if (order.status !== "paid") {
    // Signed, but not settled - captured status will follow shortly in the
    // normal case, or this was never really paid in an abnormal one. Either
    // way, refusing rather than guessing: the webhook grants it the moment
    // order.paid actually fires, and a retry of this same call a few
    // seconds later will see "paid" and succeed.
    return new Response(
      JSON.stringify({
        error: "Payment is still settling. Give it a moment and check again.",
        verified: true,
        granted: false,
      }),
      { status: 202, headers },
    );
  }

  // 5. OWNERSHIP. A valid signature for somebody else's order is still a
  // valid signature - it just might not be yours. Refusing here, rather than
  // granting to whoever the order's own notes name, means an order id
  // leaked or guessed by another account cannot be used to trigger THAT
  // account's grant either: if it is not the caller's order, this call does
  // nothing, and the real buyer still gets their credits from the webhook
  // regardless of who else calls verify with their order id.
  const orderUserId = order.notes.user_id;
  if (!orderUserId || orderUserId !== user.id) {
    console.error(`razorpay-verify: order ${orderId} does not belong to ${user.id}`);
    return new Response(
      JSON.stringify({ error: "That payment does not belong to this account.", verified: false }),
      { status: 400, headers },
    );
  }

  // 6. WHAT WAS BOUGHT. THE CREDIT COUNT COMES FROM THE CATALOGUE - never
  // from notes, never from the amount paid. A product key that is not (or
  // is no longer) in _shared/products.ts resolves to `null` here, and
  // applyCreditPurchase below records the purchase with ZERO credits and a
  // `needs_attention` status rather than falling back to any default. BUG
  // #4, FIXED: the previous version of this file fell back to 31 grant days
  // when a plan key was not found in the old plans.ts table, which for a
  // yearly plan under-granted eleven months of what was paid for. There is
  // no fallback number anywhere in this file any more - only a catalogue
  // lookup that is null or isn't. resolveOneTimeProduct also refuses a
  // `subscription`-kind key - see its own comment in _shared/razorpay.ts.
  const product = resolveOneTimeProduct(order.notes.product_key);

  const store = supabaseEntitlementStore(admin, logEvent);
  const identity = identityForOrder(orderId);
  const purchase: CreditPurchase = {
    provider: identity.provider,
    eventId: identity.eventId,
    userId: user.id,
    productKey: product ? product.key : null,
    credits: product ? product.credits : 0,
    amountCents: order.amount,
    currency: order.currency,
    providerTxnId: identity.providerTxnId,
    occurredAt: null,
  };

  // 7. THE CLAIM. BUG #1, FIXED. The previous version of this file read the
  // row's status, checked it, then wrote a new status - three separate
  // steps with a gap between them, so two concurrent calls (this endpoint
  // firing twice from a flaky network retry, or this endpoint racing the
  // webhook) could both read the pre-grant state and both extend the grant.
  // applyCreditPurchase does not read then write: recordPurchase's insert
  // tolerates a duplicate row by construction (ON CONFLICT DO NOTHING, no
  // target columns, so it catches BOTH the primary key on (provider,
  // eventId) and purchases_txn_idx on (provider, providerTxnId) - see
  // _shared/store.ts's own comment on why no conflict target is named), and
  // claimPurchase is a single conditional UPDATE guarded by
  // `status = 'received'` in the WHERE clause. Exactly one caller - this
  // endpoint or the webhook, whichever arrives first - can ever move a row
  // out of `received`, and the other gets back `duplicate` and grants
  // nothing more. Let the insert (or the claim) fail to win the race, rather
  // than reading a row and trusting what it said a moment ago.
  const outcome = await applyCreditPurchase(store, purchase);
  return outcomeResponse(outcome, headers);
});

/** `headers` is the SAME cors(origin)-plus-Content-Type object the main
 *  handler built at the top of the request - not a fresh
 *  `{ "Content-Type": ... }` literal. This function is reached only from a
 *  browser (see the file header: this is a fast path called by pay.ts), and
 *  a response missing Access-Control-Allow-Origin is one the browser
 *  refuses to hand back to the caller at all - supabase.functions.invoke
 *  would then reject even a fully successful grant, and pay.ts's catch
 *  block would show "we could not confirm that payment" for a payment that
 *  in fact landed. Passing the closure's own headers through is what keeps
 *  a 200 here actually reaching the code that asked for it. */
function outcomeResponse(outcome: GrantOutcome, headers: HeadersInit): Response {
  switch (outcome.status) {
    case "granted":
      return new Response(
        JSON.stringify({ verified: true, granted: outcome.credits, balance: outcome.balance }),
        { status: 200, headers },
      );

    case "duplicate":
      // The correct answer whether this is a retried tap or the webhook
      // already won the race - either way the buyer already has their
      // credits.
      return new Response(
        JSON.stringify({ verified: true, alreadyProcessed: true }),
        { status: 200, headers },
      );

    case "unknown_product":
    case "no_user":
      // BUG #3 and #4's shared shape: recorded, granted nothing, needs a
      // human. Still `verified: true` - the payment DID go through, and
      // telling the buyer it failed when their money moved would be a worse
      // lie than telling them it needs a look.
      return new Response(
        JSON.stringify({
          error: "Payment went through but we could not apply it automatically. Email us and we will sort it out.",
          verified: true,
          granted: false,
        }),
        { status: 200, headers },
      );

    case "grant_failed":
    case "store_error":
      // BUG #3's other half. The money is taken and the grant did not land -
      // or, for store_error, the record of the purchase itself failed to
      // write, which is the swallowed-insert bug this file used to have.
      // NEITHER is swallowed any more: both are a loud console line (server
      // side, findable) and a 500 with an honest message (client side,
      // actionable) rather than a quiet catch that leaves the buyer thinking
      // nothing happened. The claim in _shared/entitlements.ts means a retry
      // of this same call - or the webhook arriving independently - cannot
      // double grant even if the credits actually landed just before this
      // particular write failed.
      return new Response(
        JSON.stringify({
          error: "Payment went through but we could not switch your credits on. We can see it, email us and it will be fixed.",
          verified: true,
          granted: false,
        }),
        { status: 500, headers },
      );
  }
}

// ============================================================================
// OWNER SETUP: see supabase/functions/razorpay-order/index.ts and
// razorpay-webhook/index.ts. This function needs the same RAZORPAY_KEY_ID
// and RAZORPAY_KEY_SECRET razorpay-order already reads (used here to sign
// the handshake AND to fetch the order back), and none of the webhook's
// setup - it is called by the app with a real Supabase session, so it keeps
// the platform's own JWT gate rather than --no-verify-jwt.
//
//   supabase functions deploy razorpay-verify
// ============================================================================
