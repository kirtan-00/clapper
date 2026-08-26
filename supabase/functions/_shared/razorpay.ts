// Razorpay payload readers, the client-handshake message, and the ONE
// identity builder both grant paths key off. Gateway specific on purpose,
// unlike _shared/entitlements.ts: everything here is Razorpay's own field
// names and Razorpay's own HTTP API, read from docs 2026-08-27 (see the
// function headers for which page), never from memory.
//
// NO DENO API, NO jsr IMPORTS. `fetch`, `AbortController` and `setTimeout`
// are all Web platform globals, present in Deno and in the vitest/node
// environment the same way _shared/stripe.ts's pure readers are - so this
// file can be imported straight into the test suite the way
// src/net/stripe.webhook.test.ts already imports stripe.ts, and the
// signature/identity logic can be checked against hand computed fixtures
// rather than against itself.
//
// THE ONE IDENTITY BOTH GRANT PATHS SHARE. razorpay-verify (the browser
// handshake) and razorpay-webhook (the authoritative path) describe the SAME
// money in two different requests, and _shared/entitlements.ts only refuses
// a double grant if both requests build the IDENTICAL (provider, eventId)
// pair. If verify built its own string here and the webhook built a
// different one there, the purchases claim would never collide and the
// bug this whole file exists to fix - two deliveries, one payment, two
// grants - would come back through the side door. So there is exactly one
// function that turns a payment id into an identity, and both edge
// functions call it instead of composing the fields themselves.
//
// WHY THE IDENTITY IS THE PAYMENT ID AND NOTHING ELSE. Razorpay's webhook
// payload carries no delivery-scoped event id the way Stripe's does
// (evt_...) - confirmed against razorpay.com/docs/webhooks/payloads/payments/
// 2026-08-27, whose payment.captured example payload's only top-level
// fields are entity, account_id, event, contains, payload, created_at. A
// retried delivery of the SAME event carries the SAME payment id, which is
// itself globally unique and immutable once captured, so it is a perfectly
// good idempotency key on its own: no event-type prefix is needed because
// this app only ever grants on ONE event (payment.captured - see
// PAYMENT_GRANT_EVENTS below), so a payment id can never collide across two
// DIFFERENT grant-eligible events the way it could if order.paid were also
// wired to grant.

export interface RazorpayIdentity {
  provider: "razorpay";
  /** Half the primary key in `purchases`. The Razorpay payment id (pay_...). */
  eventId: string;
  /** The unique index half. Same value as eventId here - see the file header
   *  for why one id can honestly serve both roles for this gateway. */
  providerTxnId: string;
}

export function identityForPayment(paymentId: string): RazorpayIdentity {
  return { provider: "razorpay", eventId: paymentId, providerTxnId: paymentId };
}

// ---------------------------------------------------------------------------
// The client handshake message.
//
// Confirmed against the razorpay-node SDK's own source
// (razorpay-utils/index.js, read 2026-08-27): the verification helper builds
// `orderId + '|' + paymentId` and signs it with HMAC-SHA256 under the API
// KEY SECRET (never the webhook secret - that is a different secret over a
// different message, see _shared/webhook.ts's Razorpay section). This is the
// one part of the pre-existing razorpay-verify code the audit found already
// correct; it is pulled out here only so it cannot drift from what the tests
// check against a hand computed fixture.
// ---------------------------------------------------------------------------

export function handshakeMessage(orderId: string, paymentId: string): string {
  return `${orderId}|${paymentId}`;
}

// ---------------------------------------------------------------------------
// Webhook payload readers.
//
// Shape confirmed against razorpay.com/docs/webhooks/payloads/payments/,
// read 2026-08-27:
//
//   { entity: "event", account_id, event: "payment.captured",
//     contains: ["payment"],
//     payload: { payment: { entity: { id, order_id, status, amount,
//                                      currency, notes, ... } } },
//     created_at }
// ---------------------------------------------------------------------------

function str(v: unknown, max = 200): string | null {
  return typeof v === "string" && v.length > 0 && v.length <= max ? v : null;
}

function asRecord(v: unknown): Record<string, unknown> | null {
  return v && typeof v === "object" && !Array.isArray(v) ? (v as Record<string, unknown>) : null;
}

export function peekRazorpayEvent(payload: unknown): string | null {
  const obj = asRecord(payload);
  return obj ? str(obj.event, 100) : null;
}

/** Grants a credit. Everything else that could plausibly arrive on this
 *  endpoint is a status update or a failure, never a second way to describe
 *  the same money - see PAYMENT_NOTED_EVENTS. */
export const PAYMENT_GRANT_EVENTS = ["payment.captured"];

/** Recorded as analytics, never as a `purchases` row: neither of these is
 *  money that landed. `order.paid` in particular fires for the SAME money as
 *  `payment.captured` on a single-payment order - subscribing to both and
 *  granting on both would be exactly the dual-event double grant Paddle's
 *  transaction.paid/transaction.completed pair already taught this codebase
 *  to refuse (see purchases_txn_idx in the entitlements migration). Granting
 *  on payment.captured only sidesteps it entirely rather than relying on the
 *  unique index to catch a second grant path after the fact. */
export const PAYMENT_NOTED_EVENTS = ["payment.failed", "order.paid"];

export interface PaymentEventRead {
  eventType: string;
  paymentId: string;
  orderId: string;
  status: string | null;
  /** Paise, straight off Razorpay - never used as a gate, ledger only. */
  amountPaise: number | null;
  currency: string | null;
  /** Whatever notes the payment entity itself carries. Often empty even when
   *  the ORDER has notes - Razorpay does not document that order notes are
   *  copied onto the payment, so this is read defensively and the caller
   *  falls back to fetching the order (fetchRazorpayOrder) rather than
   *  assuming either way. */
  notes: Record<string, string>;
}

/** Razorpay represents an empty notes object as `[]` and a populated one as
 *  `{k: v}` - confirmed by the fetch-order example response, whose `notes`
 *  field is literally `[]` on an order with none set. Reading `[]` as a
 *  record rather than special-casing it would silently produce `{}` from
 *  Object.entries anyway, but the Array.isArray guard makes that explicit
 *  instead of incidental. */
export function normalizeNotes(raw: unknown): Record<string, string> {
  if (raw === null || raw === undefined || Array.isArray(raw) || typeof raw !== "object") return {};
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(raw as Record<string, unknown>)) {
    if (typeof v === "string") out[k] = v;
  }
  return out;
}

export function readPaymentEvent(payload: unknown): PaymentEventRead | null {
  const top = asRecord(payload);
  const eventType = top ? str(top.event, 100) : null;
  if (!top || !eventType) return null;

  const payment = asRecord(asRecord(top.payload)?.payment);
  const entity = asRecord(payment?.entity);
  if (!entity) return null;

  const paymentId = str(entity.id, 64);
  const orderId = str(entity.order_id, 64);
  if (!paymentId || !orderId) return null;

  const amountPaise = typeof entity.amount === "number" && Number.isFinite(entity.amount)
    ? entity.amount
    : null;

  return {
    eventType,
    paymentId,
    orderId,
    status: str(entity.status, 40),
    amountPaise,
    currency: str(entity.currency, 8),
    notes: normalizeNotes(entity.notes),
  };
}

// ---------------------------------------------------------------------------
// Fetching an order back off Razorpay.
//
// WHY THIS EXISTS. Neither razorpay-order nor this pair writes a `purchases`
// row at ORDER-creation time (see razorpay-order/index.ts's header for why -
// the short version is the same reason stripe-checkout does not: a row
// keyed to the transaction id before the grant path's own insert would let
// that insert's untargeted ON CONFLICT DO NOTHING silently swallow every
// real grant). So neither razorpay-verify nor razorpay-webhook has a local
// row to read the buyer and the product back off. Razorpay itself is the
// only place left holding that information - in the `notes` the order was
// created with - and GET /v1/orders/:id is how both paths read it back,
// under a bounded timeout so a slow or hanging call cannot itself become the
// failure (same posture as stripe-webhook's LINE_ITEM_TIMEOUT_MS).
//
// status "paid" IS THE SETTLEMENT CHECK, confirmed against
// razorpay.com/docs/api/orders/fetch-with-id/ 2026-08-27: "paid" means "the
// successful capture of the payment" and an order KEEPS that status "even if
// the payment associated with the order is refunded" - so this is a durable
// settlement fact, not a live balance, exactly the property a grant decision
// needs.
// ---------------------------------------------------------------------------

export interface RazorpayOrder {
  id: string;
  status: string;
  amount: number;
  currency: string;
  notes: Record<string, string>;
}

export type FetchOrderResult =
  | { ok: true; order: RazorpayOrder }
  | { ok: false; reason: "http_error" | "network_error" | "bad_response"; detail: string };

export async function fetchRazorpayOrder(
  orderId: string,
  keyId: string,
  keySecret: string,
  timeoutMs: number,
): Promise<FetchOrderResult> {
  const basic = btoa(`${keyId}:${keySecret}`);
  let res: Response;
  try {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      res = await fetch(`https://api.razorpay.com/v1/orders/${encodeURIComponent(orderId)}`, {
        headers: { Authorization: `Basic ${basic}` },
        signal: controller.signal,
      });
    } finally {
      clearTimeout(timer);
    }
  } catch (e) {
    return { ok: false, reason: "network_error", detail: String(e).slice(0, 200) };
  }
  if (!res.ok) {
    const body = await res.text().catch(() => "");
    return { ok: false, reason: "http_error", detail: `${res.status}: ${body.slice(0, 300)}` };
  }
  let json: unknown;
  try {
    json = await res.json();
  } catch {
    return { ok: false, reason: "bad_response", detail: "not JSON" };
  }
  const obj = asRecord(json);
  const id = obj ? str(obj.id, 64) : null;
  const status = obj ? str(obj.status, 40) : null;
  const amount = obj && typeof obj.amount === "number" ? obj.amount : null;
  const currency = obj ? str(obj.currency, 8) : null;
  if (!id || !status || amount === null || !currency) {
    return { ok: false, reason: "bad_response", detail: "missing id/status/amount/currency" };
  }
  return {
    ok: true,
    order: { id, status, amount, currency, notes: normalizeNotes(obj?.notes) },
  };
}
