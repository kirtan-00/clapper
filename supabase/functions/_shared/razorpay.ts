import { getProduct, type Product } from "./products.ts";

// Razorpay payload readers, the client-handshake message, and the ONE
// identity builder both grant paths key off. Gateway specific on purpose,
// unlike _shared/entitlements.ts: everything here is Razorpay's own field
// names and Razorpay's own HTTP API, read from docs 2026-08-27 (see the
// function headers for which page), never from memory - AND corrected once
// already the same day against the owner's own live dashboard, which is why
// the grant event below is order.paid and not the payment.captured most
// Razorpay tutorials reach for first. See the note above ORDER_GRANT_EVENTS.
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
// different one there, the purchases claim would never collide and the bug
// this whole file exists to fix - two deliveries, one payment, two grants -
// would come back through the side door. So there is exactly one function
// that turns an order id into an identity, and both edge functions call it
// instead of composing the fields themselves.

export interface RazorpayIdentity {
  provider: "razorpay";
  /** Half the primary key in `purchases`. The Razorpay ORDER id (order_...),
   *  not the payment id - see the note above ORDER_GRANT_EVENTS for why an
   *  order is the unit of idempotency for this gateway. */
  eventId: string;
  /** The unique index half. Same value as eventId here - one order, one
   *  grant, so nothing else needs to be able to catch a second description
   *  of the same money the way it would if two different event types both
   *  granted (see purchases_txn_idx's own comment in the migration). */
  providerTxnId: string;
}

export function identityForOrder(orderId: string): RazorpayIdentity {
  return { provider: "razorpay", eventId: orderId, providerTxnId: orderId };
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

function str(v: unknown, max = 200): string | null {
  return typeof v === "string" && v.length > 0 && v.length <= max ? v : null;
}

function asRecord(v: unknown): Record<string, unknown> | null {
  return v && typeof v === "object" && !Array.isArray(v) ? (v as Record<string, unknown>) : null;
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

/**
 * Resolve notes.product_key to a product this pair is actually allowed to
 * sell - one call, used identically by razorpay-verify and
 * razorpay-webhook, so the guard cannot drift between the two the way a
 * copy-pasted `if` could.
 *
 * THE kind CHECK IS NOT OPTIONAL. razorpay-order refuses to CREATE an order
 * for a `subscription`-kind product (Razorpay's Orders API cannot sell one),
 * but nothing stops an order being created by hand in the Razorpay
 * dashboard, or by a future code path, with notes.product_key set to
 * `pro_monthly` - and if this function returned that product anyway, a
 * one-time payment would grant six SUBSCRIPTION credits, the wrong number
 * for money that was never going to recur. Same posture stripe-webhook
 * takes on its checkout.session.completed path (`fromMetadata.kind ===
 * "one_time"`) - mirrored here rather than re-derived, because the failure
 * mode is identical: a product key that resolves but belongs to the wrong
 * kind of sale is not "close enough", it is `unknown_product` grants zero,
 * exactly as if the key had not resolved at all.
 */
export function resolveOneTimeProduct(productKey: unknown): Product | null {
  const product = getProduct(productKey);
  return product && product.kind === "one_time" ? product : null;
}

export function peekRazorpayEvent(payload: unknown): string | null {
  const obj = asRecord(payload);
  return obj ? str(obj.event, 100) : null;
}

// ---------------------------------------------------------------------------
// order.paid - the one-off grant event.
//
// NOT payment.captured, which is what the task's own brief and most
// Razorpay tutorials reach for first. The owner's live dashboard subscribes
// order.paid instead, and confirmed why against the Stripe file already in
// this repo: payment.captured can fire MORE THAN ONCE for a single order
// under partial or multiple payment attempts, which is exactly the
// double-grant hazard checkout.session.completed vs invoice.paid was already
// solved for on the Stripe side (see stripe-webhook/index.ts's file header,
// "1. CHECKOUT SESSIONS"). order.paid fires exactly once, when the order's
// amount_due reaches zero, which is a strictly better idempotency anchor for
// a single-payment order than a payment event that isn't 1:1 with it.
//
// Shape confirmed against razorpay.com/docs/webhooks/payloads/orders/, read
// 2026-08-27:
//
//   { event: "order.paid", contains: ["payment", "order"],
//     payload: { payment: { entity: {...} }, order: { entity: {
//       id, amount, amount_paid, amount_due, currency, receipt, status,
//       notes, created_at } } },
//     created_at }
//
// notes IS the order's own notes here, in the payload, no extra API call
// needed - unlike razorpay-verify, which only ever receives an order id from
// the browser and has to fetch the order back (see fetchRazorpayOrder).
// ---------------------------------------------------------------------------

export const ORDER_GRANT_EVENTS = ["order.paid"];

/** Subscribed on the dashboard and describes real money, so it must never
 *  fall through to a silent 200-ignore - but see razorpay-webhook/index.ts
 *  for why this is recorded as needs-attention rather than granted: this
 *  pair has no subscription checkout (razorpay-order refuses `subscription`
 *  kind products outright) and Razorpay's own docs give no verified,
 *  documented way to tell a subscription's FIRST invoice from a renewal the
 *  way Stripe's billing_reason does - guessing that distinction would risk
 *  exactly the under-grant bug #4 was about, on the one field this pair
 *  cannot verify. */
export const INVOICE_NEEDS_ATTENTION_EVENTS = ["invoice.paid"];

export interface OrderEntity {
  id: string;
  status: string;
  /** Paise, straight off Razorpay - never used as a gate, ledger only. */
  amount: number;
  currency: string;
  notes: Record<string, string>;
}

/** Shared by the webhook (reading payload.order.entity straight off the
 *  delivery) and fetchRazorpayOrder (reading the same shape back off
 *  GET /v1/orders/:id) - one parser, so the two cannot drift on which
 *  fields are required. */
function readOrderEntity(raw: unknown): OrderEntity | null {
  const obj = asRecord(raw);
  if (!obj) return null;
  const id = str(obj.id, 64);
  const status = str(obj.status, 40);
  const amount = typeof obj.amount === "number" && Number.isFinite(obj.amount) ? obj.amount : null;
  const currency = str(obj.currency, 8);
  if (!id || !status || amount === null || !currency) return null;
  return { id, status, amount, currency, notes: normalizeNotes(obj.notes) };
}

export interface OrderPaidRead {
  eventType: string;
  order: OrderEntity;
  /** The settling payment's id, when present, for the ledger's
   *  provider metadata only - never part of the idempotency key (see
   *  identityForOrder's comment for why the ORDER id is that key here). */
  paymentId: string | null;
}

export function readOrderPaidEvent(payload: unknown): OrderPaidRead | null {
  const top = asRecord(payload);
  const eventType = top ? str(top.event, 100) : null;
  if (!top || !eventType) return null;

  const orderEntity = asRecord(asRecord(top.payload)?.order)?.entity;
  const order = readOrderEntity(orderEntity);
  if (!order) return null;

  const paymentEntity = asRecord(asRecord(asRecord(top.payload)?.payment)?.entity);
  const paymentId = paymentEntity ? str(paymentEntity.id, 64) : null;

  return { eventType, order, paymentId };
}

// ---------------------------------------------------------------------------
// invoice.paid - read only far enough to log it. See
// INVOICE_NEEDS_ATTENTION_EVENTS above for why this pair does not grant
// against it. Fields are read defensively: razorpay.com's own Invoices
// webhook page (read 2026-08-27) gives an example payload for a STANDALONE
// invoice (type "invoice", no subscription_id), not a subscription billing
// cycle, so which fields a subscription's invoice.paid actually carries is
// not confirmed. Nothing below is trusted for anything but a log line.
// ---------------------------------------------------------------------------

export interface InvoicePaidRead {
  eventType: string;
  invoiceId: string | null;
  status: string | null;
  subscriptionId: string | null;
  amountPaid: number | null;
  currency: string | null;
  notes: Record<string, string>;
}

export function readInvoicePaidEvent(payload: unknown): InvoicePaidRead | null {
  const top = asRecord(payload);
  const eventType = top ? str(top.event, 100) : null;
  if (!top || !eventType) return null;

  const entity = asRecord(asRecord(top.payload)?.invoice)?.entity;
  const obj = asRecord(entity) ?? {};

  return {
    eventType,
    invoiceId: str(obj.id, 64),
    status: str(obj.status, 40),
    subscriptionId: str(obj.subscription_id, 64),
    amountPaid: typeof obj.amount_paid === "number" ? obj.amount_paid : null,
    currency: str(obj.currency, 8),
    notes: normalizeNotes(obj.notes),
  };
}

// ---------------------------------------------------------------------------
// Fetching an order back off Razorpay.
//
// WHY THIS EXISTS. razorpay-verify only ever receives an order id, a payment
// id and a signature from the browser - never the order's own notes, which
// is where the buyer and the product live (see razorpay-order/index.ts's
// header for why no local row is written at order-creation time to read
// those back from instead). GET /v1/orders/:id is how the buyer and the
// product get read back, under a bounded timeout so a slow or hanging call
// cannot itself become the failure (same posture as stripe-webhook's
// LINE_ITEM_TIMEOUT_MS). The webhook does NOT need this - order.paid already
// carries payload.order.entity.notes directly, see readOrderPaidEvent above.
//
// status "paid" IS THE SETTLEMENT CHECK, confirmed against
// razorpay.com/docs/api/orders/fetch-with-id/ 2026-08-27: "paid" means "the
// successful capture of the payment" and an order KEEPS that status "even if
// the payment associated with the order is refunded" - so this is a durable
// settlement fact, not a live balance, exactly the property a grant decision
// needs, and it is the same field and the same value order.paid's own
// payload carries (see the order.paid example: `"status": "paid"`).
// ---------------------------------------------------------------------------

export type FetchOrderResult =
  | { ok: true; order: OrderEntity }
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
  const order = readOrderEntity(json);
  if (!order) return { ok: false, reason: "bad_response", detail: "missing id/status/amount/currency" };
  return { ok: true, order };
}

// ---------------------------------------------------------------------------
// subscription.charged - the RECURRING grant event. Added 2026-08-27, when
// subscriptions were actually wired; before that this file said in as many
// words that Razorpay gave "no verified, documented way to tell a
// subscription's FIRST invoice from a renewal the way Stripe's
// billing_reason does". That claim was true of `invoice.paid`, which is why
// INVOICE_NEEDS_ATTENTION_EVENTS still records and never grants. It is NOT
// true of subscription.charged, which carries the subscription entity and
// therefore `paid_count`: the number of successful charges INCLUDING this
// one. paid_count === 1 is a first charge by definition, and anything above
// it is a renewal. That is the missing field, and it is why the grant lives
// on this event and not on the invoice.
//
// WHY NOT invoice.paid, given a subscription cycle emits BOTH. That is
// precisely the reason. Razorpay sends invoice.paid AND subscription.charged
// for the same money on every cycle, so granting on both would pay out twice
// for one charge - the same double-grant shape stripe-webhook solved by
// granting on invoice.paid and never on payment_intent events. Exactly one of
// the pair may grant. subscription.charged is the one that can tell first
// from renewal, so it wins, and invoice.paid stays record-only forever.
//
// IDEMPOTENCY KEYS OFF THE PAYMENT ID, not the subscription id. A
// subscription id is stable for the life of the subscription and repeats on
// every single cycle, so keying on it would let the second month dedupe
// against the first and silently grant nothing for money that really moved.
// The payment id is unique per charge, which is what "one grant per charge"
// actually means.
//
// Shape confirmed against razorpay.com/docs/webhooks/payloads/subscriptions/:
//
//   { event: "subscription.charged", contains: ["subscription", "payment"],
//     payload: { subscription: { entity: {
//         id, plan_id, status, paid_count, notes, ... } },
//       payment: { entity: { id, amount, currency, status, ... } } },
//     created_at }
// ---------------------------------------------------------------------------

export const SUBSCRIPTION_GRANT_EVENTS = ["subscription.charged"];

/**
 * The mirror of resolveOneTimeProduct, and it refuses for the same reason.
 * A `one_time` key arriving on a subscription charge is not "close enough":
 * it would grant a permanent credit pack on a recurring charge, forever, on
 * every cycle. Wrong kind is `unknown_product`, exactly as if the key had
 * not resolved at all.
 */
export function resolveSubscriptionProduct(productKey: unknown): Product | null {
  const product = getProduct(productKey);
  return product && product.kind === "subscription" ? product : null;
}

export interface SubscriptionChargedRead {
  eventType: string;
  subscriptionId: string;
  planId: string | null;
  status: string | null;
  /** Successful charges so far INCLUDING this one. 1 means first charge.
   *  Null when Razorpay did not send it, which is NOT treated as 1 - see
   *  billingReasonForPaidCount. */
  paidCount: number | null;
  notes: Record<string, string>;
  paymentId: string | null;
  amount: number | null;
  currency: string | null;
}

export function readSubscriptionChargedEvent(payload: unknown): SubscriptionChargedRead | null {
  const top = asRecord(payload);
  const eventType = top ? str(top.event, 100) : null;
  if (!top || !eventType) return null;

  const sub = asRecord(asRecord(asRecord(top.payload)?.subscription)?.entity);
  const subscriptionId = sub ? str(sub.id, 64) : null;
  if (!sub || !subscriptionId) return null;

  const pay = asRecord(asRecord(asRecord(top.payload)?.payment)?.entity);

  const rawCount = sub.paid_count;
  const paidCount = typeof rawCount === "number" && Number.isFinite(rawCount) ? rawCount : null;

  return {
    eventType,
    subscriptionId,
    planId: str(sub.plan_id, 64),
    status: str(sub.status, 40),
    paidCount,
    notes: normalizeNotes(sub.notes),
    paymentId: pay ? str(pay.id, 64) : null,
    amount: pay && typeof pay.amount === "number" ? pay.amount : null,
    currency: pay ? str(pay.currency, 8) : null,
  };
}

/**
 * Map Razorpay's paid_count onto the billing reason applySubscriptionCredit
 * already understands, so BOTH gateways grant through one code path and the
 * intro-bonus rule cannot drift between them.
 *
 * A MISSING paid_count RETURNS NULL, NOT "subscription_cycle". Null makes
 * applySubscriptionCredit record the charge as needs-attention and grant
 * nothing, which is the safe direction: a human reconciles one row. Defaulting
 * to "cycle" would silently under-grant a first charge that was owed intro
 * credits, and defaulting to "create" would re-grant the intro bonus on every
 * renewal. Neither guess is recoverable without reading the money back out of
 * somebody's account.
 */
export function billingReasonForPaidCount(paidCount: number | null): string | null {
  if (paidCount === null) return null;
  return paidCount <= 1 ? "subscription_create" : "subscription_cycle";
}

/** Idempotency identity for one subscription charge. Keyed on the PAYMENT
 *  id (see the section header for why the subscription id would be wrong),
 *  falling back to a composite only when Razorpay sends no payment entity at
 *  all - a shape its docs do not describe, but a missing key would make
 *  applySubscriptionCredit answer store_error and lose the record entirely. */
export function identityForSubscriptionCharge(
  subscriptionId: string,
  paymentId: string | null,
  paidCount: number | null,
): RazorpayIdentity {
  const txn = paymentId ?? `${subscriptionId}:${paidCount ?? "unknown"}`;
  return { provider: "razorpay", eventId: txn, providerTxnId: txn };
}
