import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { createClient } from "jsr:@supabase/supabase-js@2";
import { verifyPaddleWebhook } from "../_shared/webhook.ts";
import { productForPriceId } from "../_shared/products.ts";
import {
  applyCreditPurchase,
  type CreditPurchase,
  type EntitlementStore,
} from "../_shared/entitlements.ts";

// Paddle webhook. The ONLY path that turns money into credits.
//
// WHY A WEBHOOK IS THE PRIMARY PATH AND NOT A BACKSTOP. The previous design
// granted on the browser's return from the checkout modal. On a phone, on a
// set, with one bar of signal, "the browser comes back and tells us" is a
// coin flip: the tab gets closed, the phone dies, the tunnel drops between the
// gateway taking the money and the callback landing. Every one of those is a
// payment that succeeded and a person who got nothing, and nobody finds out.
// The webhook is server to server, retried by Paddle for three days, and does
// not care whether the buyer's phone survived the transaction.
//
// VERIFY JWT MUST BE OFF FOR THIS FUNCTION. Paddle is not a Supabase user and
// has no anon key to send:
//
//   supabase functions deploy paddle-webhook --no-verify-jwt
//
// Which means THE SIGNATURE CHECK IS THE AUTHENTICATION. There is no second
// gate behind it. Everything it protects is in _shared/webhook.ts, hashed over
// the exact raw bytes of the body, compared in constant time.
//
// NO CORS. This is server to server. A browser has no business calling it, and
// _shared/cors.ts is deliberately not imported: sending an allow-origin header
// here would only advertise the endpoint to a page that cannot use it anyway.
//
// ANSWER FAST. Paddle wants HTTP 200 within five seconds or the delivery
// counts as failed. The work below is one insert, one conditional update, one
// RPC and two best-effort writes; nothing calls out to another service.
//
// SECRETS (owner sets, never in this repo):
//   PADDLE_WEBHOOK_SECRET   the notification destination's key, pdl_ntfset_...
//   PADDLE_PRICE_INTRO_5    price id for the 5 USD / 5 projects introductory buy
//   PADDLE_PRICE_CREDIT_1   price id for the 3 USD / 1 project standing buy

const PROVIDER = "paddle";

/** The one event we grant on. See below for why it is not two. */
const GRANT_EVENT = "transaction.completed";

/** Recorded, never granted on. Kept in the log because a failed payment
 *  followed by a successful one is a normal sequence, not an anomaly. */
const NOTED_EVENTS = ["transaction.payment_failed", "transaction.past_due"];

interface PaddleEnvelope {
  event_id?: unknown;
  event_type?: unknown;
  occurred_at?: unknown;
  notification_id?: unknown;
  data?: {
    id?: unknown;
    currency_code?: unknown;
    custom_data?: Record<string, unknown> | null;
    items?: { quantity?: unknown; price?: { id?: unknown } | null }[];
    details?: { totals?: { grand_total?: unknown } | null } | null;
  };
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function asString(v: unknown, max = 200): string | null {
  return typeof v === "string" && v.length > 0 && v.length <= max ? v : null;
}

/** Paddle sends money totals as decimal STRINGS in the smallest unit of the
 *  charged currency ("500"). Anything unparseable is recorded as null rather
 *  than as a zero that would read as a free purchase in the ledger. */
function asMinorUnits(v: unknown): number | null {
  if (typeof v === "number" && Number.isFinite(v)) return Math.round(v);
  if (typeof v !== "string" || !/^[0-9]+(\.[0-9]+)?$/.test(v)) return null;
  const n = Number(v);
  return Number.isFinite(n) ? Math.round(n) : null;
}

Deno.serve(async (req: Request) => {
  const json = (body: unknown, status = 200) =>
    new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });

  if (req.method !== "POST") return json({ error: "POST only" }, 405);

  const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
  const SERVICE = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
  const SECRET = Deno.env.get("PADDLE_WEBHOOK_SECRET");

  // 1. THE RAW BYTES. Read once, hashed as they arrived, parsed from the same
  // buffer afterwards. Never JSON.parse then re-serialise for the hash: key
  // order and unicode escaping do not survive that, and the check would fail
  // on every real delivery while passing in a test.
  const raw = new Uint8Array(await req.arrayBuffer());

  const verdict = await verifyPaddleWebhook(raw, req.headers.get("Paddle-Signature"), SECRET);
  if (!verdict.ok) {
    if (verdict.reason === "no_secret") {
      // A deploy mistake, not a caller mistake. 503 so Paddle retries it: the
      // owner has three days to set the secret before the event is lost.
      console.error("paddle-webhook: PADDLE_WEBHOOK_SECRET not set");
      return json({ error: "not configured" }, 503);
    }
    // Everything else is unauthenticated. 401, no detail, no retry wanted.
    console.error(`paddle-webhook: signature rejected (${verdict.reason})`);
    return json({ error: "bad signature" }, 401);
  }

  // 2. Only now is the body worth reading.
  let evt: PaddleEnvelope;
  try {
    evt = JSON.parse(new TextDecoder().decode(raw)) as PaddleEnvelope;
  } catch {
    // Signed by Paddle and not JSON should be impossible. 400 rather than 500:
    // retrying it will produce the same bytes.
    console.error("paddle-webhook: signed body was not JSON");
    return json({ error: "bad body" }, 400);
  }

  const eventId = asString(evt.event_id, 120);
  const eventType = asString(evt.event_type, 120);
  if (!eventId || !eventType) return json({ error: "missing event id or type" }, 400);

  const admin = createClient(SUPABASE_URL, SERVICE, { auth: { persistSession: false } });

  const logEvent = async (name: string, userId: string | null, props: Record<string, unknown>) => {
    try {
      await admin.from("events").insert({ user_id: userId, name, props });
    } catch {
      /* analytics is non-fatal */
    }
  };

  // 3. Events we are not here for. 200, always: Paddle disables a destination
  // that keeps failing, and "I do not handle subscription.updated" is not a
  // failure. Answering 500 to an event type we will never handle would retry
  // it sixty times and then take the endpoint down with it.
  if (eventType !== GRANT_EVENT) {
    if (NOTED_EVENTS.indexOf(eventType) !== -1) {
      await logEvent("payment_event", null, {
        provider: PROVIDER,
        event_id: eventId,
        event_type: eventType,
        txn_id: asString(evt.data?.id, 120),
      });
    }
    return json({ ok: true, ignored: eventType });
  }

  // WHY transaction.completed AND NOT transaction.paid AS WELL.
  // Paddle's docs are explicit that these are two events describing the same
  // money: `transaction.paid` fires when the payment is captured, then Paddle
  // does its own processing (fees, invoice numbers) and fires
  // `transaction.completed`. They carry DIFFERENT event ids. Since the
  // idempotency key here is the event id, subscribing to both would grant
  // twice for one purchase - the exact failure this whole file exists to
  // prevent. So: subscribe to `transaction.completed` only.
  //
  // That decision is enforced twice, because a subscription is a checkbox in
  // somebody else's dashboard and this code cannot see it: the unique index
  // purchases_txn_idx (see the entitlements migration) makes a second event
  // for the same transaction unable to insert at all, so if both boxes ever
  // get ticked the second one is recorded as a duplicate and grants nothing.
  //
  // The cost of choosing `completed` over `paid` is a delay of seconds. The
  // cost of choosing both is paying out twice.

  const data = evt.data ?? {};
  const txnId = asString(data.id, 120);
  const currency = asString(data.currency_code, 10);
  const amountCents = asMinorUnits(data.details?.totals?.grand_total);
  const occurredAt = asString(evt.occurred_at, 40);

  // 4. WHOSE ACCOUNT. `custom_data.user_id` is put on the transaction when the
  // checkout is opened, server-side, from the signed-in session. It is not a
  // field the buyer can type. If it is missing or malformed the purchase is
  // recorded as `user_unknown` and surfaces in the dashboard rather than being
  // guessed at from an email address.
  const rawUserId = data.custom_data && typeof data.custom_data === "object"
    ? (data.custom_data as Record<string, unknown>).user_id
    : null;
  const userId = typeof rawUserId === "string" && UUID_RE.test(rawUserId) ? rawUserId : null;

  // 5. WHAT WAS BOUGHT. From the PRICE ID, never from the amount: Paddle is a
  // merchant of record, so the buyer was charged in their own currency with
  // their own tax and the total will not match the catalogue. An amount check
  // here would refuse to deliver to everybody outside the US.
  let credits = 0;
  let productKey: string | null = null;
  const unknownPrices: string[] = [];
  for (const item of Array.isArray(data.items) ? data.items : []) {
    const priceId = asString(item?.price?.id, 120);
    const product = productForPriceId(priceId, (n) => Deno.env.get(n));
    if (!product) {
      if (priceId) unknownPrices.push(priceId);
      continue;
    }
    const qtyRaw = typeof item?.quantity === "number" ? item.quantity : 1;
    const qty = Number.isInteger(qtyRaw) && qtyRaw > 0 && qtyRaw <= 100 ? qtyRaw : 1;
    credits += product.credits * qty;
    // A mixed basket is recorded honestly rather than labelled as whichever
    // line happened to be last.
    productKey = productKey === null || productKey === product.key ? product.key : "mixed";
  }
  if (unknownPrices.length) {
    // Not fatal on its own: the resolvable lines are still granted, because
    // refusing a whole purchase over one unrecognised line would punish the
    // buyer for our configuration. It IS loud.
    console.error(`paddle-webhook: unmapped price id(s) ${unknownPrices.join(",")}`);
    await logEvent("purchase_unmapped_price", userId, {
      provider: PROVIDER,
      event_id: eventId,
      txn_id: txnId,
      price_ids: unknownPrices.slice(0, 5),
    });
  }

  const purchase: CreditPurchase = {
    provider: PROVIDER,
    eventId,
    userId,
    productKey: credits > 0 ? productKey : null,
    credits,
    amountCents,
    currency,
    providerTxnId: txnId,
    occurredAt,
  };

  // 6. The store. This is the ONLY Paddle-shaped code that touches the
  // database, and it is deliberately thin: the decisions live in
  // _shared/entitlements.ts so that a second gateway makes the same ones.
  const store: EntitlementStore = {
    async recordPurchase(p, status) {
      // ON CONFLICT DO NOTHING with NO TARGET COLUMNS, which is the whole
      // point: an untargeted DO NOTHING covers EVERY unique constraint on the
      // table, so the primary key catches a retry of the same event AND
      // purchases_txn_idx catches a second event for the same transaction.
      // Naming a conflict target here would make the second case a raised
      // 23505 instead, which would answer 500 and be retried sixty times.
      // Neither conflict is an error; both mean "already known", and the claim
      // below is what decides whether this delivery does the work.
      const { error } = await admin.from("purchases").upsert({
        provider: p.provider,
        provider_event_id: p.eventId,
        user_id: p.userId,
        provider_txn_id: p.providerTxnId,
        product_key: p.productKey,
        credits: p.credits,
        amount_cents: p.amountCents,
        currency: p.currency,
        status,
        occurred_at: p.occurredAt,
      }, { ignoreDuplicates: true });
      // 23505 belt and braces: if a PostgREST version ever does target the
      // primary key anyway, a unique violation still means "already known".
      if (error && (error as { code?: string }).code === "23505") return {};
      return { error: error ? String(error.message ?? error) : undefined };
    },

    async claimPurchase(provider, eventId) {
      // THE GUARD IS IN THE WHERE CLAUSE. One statement, no read first. Two
      // concurrent deliveries of the same event both run this; exactly one
      // gets a row back and exactly one grants.
      const { data: rows, error } = await admin
        .from("purchases")
        .update({ status: "granting", updated_at: new Date().toISOString() })
        .eq("provider", provider)
        .eq("provider_event_id", eventId)
        .eq("status", "received")
        .select("user_id, credits");
      if (error) return { claimed: null, error: String(error.message ?? error) };
      const row = (rows ?? [])[0] as { user_id: string | null; credits: number } | undefined;
      return { claimed: row ? { userId: row.user_id, credits: row.credits } : null };
    },

    async addCredits(userId, credits) {
      const { data: balance, error } = await admin.rpc("grant_project_credits", {
        p_user: userId,
        p_credits: credits,
      });
      if (error) return { balance: null, error: String(error.message ?? error) };
      // -1 is the RPC's "no such profile". Null balance is what
      // applyCreditPurchase reads as a failed grant.
      return { balance: typeof balance === "number" && balance >= 0 ? balance : null };
    },

    async finishPurchase(provider, eventId, status, note) {
      const now = new Date().toISOString();
      const patch: Record<string, unknown> = { status, updated_at: now, note: note ?? null };
      if (status === "granted") patch.granted_at = now;
      const { error } = await admin
        .from("purchases")
        .update(patch)
        .eq("provider", provider)
        .eq("provider_event_id", eventId);
      return { error: error ? String(error.message ?? error) : undefined };
    },

    logEvent: (name, uid, props) => logEvent(name, uid, props),
  };

  const outcome = await applyCreditPurchase(store, purchase);

  switch (outcome.status) {
    case "granted":
      console.log(
        `paddle-webhook: granted ${outcome.credits} credit(s) to ${userId} (${eventId}), balance ${outcome.balance}`,
      );
      return json({ ok: true, granted: outcome.credits, balance: outcome.balance });

    case "duplicate":
      // The correct answer to a retry. 200, so Paddle stops retrying.
      return json({ ok: true, duplicate: true });

    case "no_user":
    case "unknown_product":
      // Recorded, granted nothing, needs a human. STILL A 200: retrying will
      // produce exactly the same answer sixty times and then get the endpoint
      // disabled, which would cost the NEXT customer as well as this one. The
      // dashboard reconciliation panel is where this becomes visible.
      console.error(`paddle-webhook: ${outcome.status} for event ${eventId} txn ${txnId}`);
      return json({ ok: true, needs_attention: outcome.status });

    case "grant_failed":
    case "store_error":
      // Money moved and nothing was granted, for a reason that might not
      // repeat (a database blip). 500 asks Paddle to try again, and the claim
      // above means the retry cannot double grant.
      console.error(`paddle-webhook: ${outcome.status} for event ${eventId}: ${outcome.error}`);
      return json({ error: "could not apply purchase" }, 500);
  }
});

// ============================================================================
// OWNER SETUP
//
// 1. Paddle > Developer tools > Notifications > New destination
//      Notification type : URL
//      URL               : https://<project-ref>.supabase.co/functions/v1/paddle-webhook
//      Events            : transaction.completed        <- this one only
//                          transaction.payment_failed   <- optional, logged only
//    Copy the endpoint secret key (pdl_ntfset_...) shown at creation. Paddle
//    does not show it again.
//
//    Do NOT also tick transaction.paid. See the long comment above.
//
// 2. supabase secrets set PADDLE_WEBHOOK_SECRET='pdl_ntfset_...'
//    supabase secrets set PADDLE_PRICE_INTRO_5='pri_...'
//    supabase secrets set PADDLE_PRICE_CREDIT_1='pri_...'
//
// 3. supabase functions deploy paddle-webhook --no-verify-jwt
//
// 4. Apply supabase/migrations/20260826170000_entitlements.sql first. Without
//    it `purchases` does not exist and every delivery answers 500, which is
//    recoverable (Paddle retries for three days) but pointless.
//
// Sandbox and live are separate Paddle accounts with separate price ids and
// separate secrets. The names above are the same in both; what changes is the
// value, which is why no price id is hardcoded anywhere in this repo.
//
// The per-project shot division cap (2, BREAKDOWNS_PER_PROJECT in
// _shared/products.ts) is enforced in `breakdown`, not here.
// ============================================================================
