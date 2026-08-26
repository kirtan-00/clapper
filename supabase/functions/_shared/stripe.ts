// Reading a Stripe Checkout Session off a webhook payload. PURE: no Deno API,
// no network, no imports, so the test suite exercises the real thing rather
// than a paraphrase of it.
//
// WHICH EVENTS GRANT, AND WHY IT IS TWO OF THEM.
//
// The instinct is to subscribe to exactly one event so that one payment cannot
// be counted twice. For Stripe that instinct is wrong, and their own
// fulfilment guide says so: `checkout.session.completed` and
// `checkout.session.async_payment_succeeded` are not two descriptions of the
// same moment.
//
//   checkout.session.completed          the customer finished checkout. For a
//                                       card that means the money is captured
//                                       and payment_status is `paid`. For a
//                                       DELAYED method (ACH debit, bank
//                                       transfer) it fires with payment_status
//                                       `unpaid`, because the funds have not
//                                       arrived yet.
//   checkout.session.async_payment_
//   succeeded                           the delayed payment later cleared.
//
// Subscribe to only the first and a bank transfer buys nothing, forever.
// Subscribe to only the second and every card payment buys nothing, forever.
//
// So both are subscribed, and THE MONEY QUESTION IS ASKED OF payment_status,
// not of the event name. Nothing is granted while a session is `unpaid`. That
// is the check that makes two events safe, and it is why an unpaid session
// writes no purchases row at all: if it did, the unique index on the
// transaction id would then block the async_payment_succeeded event that
// arrives when the money actually lands, and the customer would pay and get
// nothing. A row in `purchases` means money moved. An unpaid session is not
// money, it is a promise.
//
// For a card, the normal case, only `completed` ever fires. The second
// subscription costs nothing and covers a payment method the owner may enable
// later without remembering to come back here.

/** The two events subscribed to. See the essay above before changing this.
 *
 *  NEITHER OF THESE GRANTS A SUBSCRIPTION CREDIT, EVEN WHEN mode IS
 *  "subscription". See the essay further down, above readInvoiceEvent: the
 *  first invoice of a new subscription and this event describe the SAME
 *  money, and the rule this file already lives by is one event per payment.
 *  invoice.paid is the one that grants, for the first invoice and every
 *  renewal alike, so a checkout.session.completed for a subscription is
 *  read only far enough to log it and is never handed to
 *  applyCreditPurchase. */
export const CHECKOUT_GRANT_EVENTS = [
  "checkout.session.completed",
  "checkout.session.async_payment_succeeded",
];

/** Recorded, never granted on. A delayed payment that failed is worth a log
 *  line: it is the other end of an `unpaid` session. */
export const CHECKOUT_NOTED_EVENTS = ["checkout.session.async_payment_failed"];

export interface CheckoutRead {
  eventId: string;
  eventType: string;
  sessionId: string | null;
  /** `payment` for the one-time purchases this app sells. */
  mode: string | null;
  /** `paid`, `unpaid` or `no_payment_required`. */
  paymentStatus: string | null;
  /** Whether the money is actually there. The ONLY thing that authorises a
   *  grant. `no_payment_required` counts: that is a 100 percent discount, which
   *  is a deliberate act by the owner, not a missing payment. */
  moneyIsIn: boolean;
  /** From client_reference_id, falling back to metadata.user_id. Validated as
   *  a uuid, so a junk value reads as absent rather than as an account. */
  userId: string | null;
  /** From metadata.product_key. Null means the caller must fall back to
   *  looking the line items up through the API. */
  productKey: string | null;
  /** Clamped to 1..100. */
  quantity: number;
  /** Minor units, as charged. NOT the catalogue price: currency conversion,
   *  and now sales tax, both live between the two. Ledger only. */
  amountTotal: number | null;
  currency: string | null;
  paymentIntentId: string | null;
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function str(v: unknown, max = 200): string | null {
  return typeof v === "string" && v.length > 0 && v.length <= max ? v : null;
}

function int(v: unknown): number | null {
  if (typeof v === "number" && Number.isFinite(v)) return Math.round(v);
  if (typeof v === "string" && /^[0-9]+$/.test(v)) return Number(v);
  return null;
}

/**
 * Pull everything worth knowing out of an event envelope. Returns null when
 * the envelope is not a Stripe event at all.
 *
 * NOTHING HERE DECIDES HOW MANY CREDITS ANYTHING IS WORTH. The product key is
 * read, the catalogue is consulted elsewhere. A metadata field saying
 * `credits: 500` would be ignored, because metadata is a string bag and the
 * price list is the only thing allowed to answer that question.
 */
export function readCheckoutEvent(payload: unknown): CheckoutRead | null {
  if (!payload || typeof payload !== "object") return null;
  const evt = payload as Record<string, unknown>;

  const eventId = str(evt.id, 120);
  const eventType = str(evt.type, 120);
  if (!eventId || !eventType) return null;

  const data = (evt.data && typeof evt.data === "object") ? (evt.data as Record<string, unknown>) : {};
  const obj = (data.object && typeof data.object === "object")
    ? (data.object as Record<string, unknown>)
    : {};

  const metadata = (obj.metadata && typeof obj.metadata === "object" && !Array.isArray(obj.metadata))
    ? (obj.metadata as Record<string, unknown>)
    : {};

  // client_reference_id is Stripe's own field for exactly this, so it wins.
  // metadata.user_id is the fallback for a session created by something that
  // used the generic bag instead. Both are written server-side when the
  // session is created, from the signed-in session, never typed by a buyer.
  const refId = str(obj.client_reference_id, 200);
  const metaUser = str(metadata.user_id, 200);
  const candidate = refId && UUID_RE.test(refId)
    ? refId
    : metaUser && UUID_RE.test(metaUser)
    ? metaUser
    : null;

  const paymentStatus = str(obj.payment_status, 40);

  const qty = int(metadata.quantity);
  const quantity = qty !== null && qty >= 1 && qty <= 100 ? qty : 1;

  // A payment_intent may arrive as an id string or as an expanded object.
  const pi = obj.payment_intent;
  const paymentIntentId = typeof pi === "string"
    ? str(pi, 120)
    : (pi && typeof pi === "object" ? str((pi as Record<string, unknown>).id, 120) : null);

  return {
    eventId,
    eventType,
    sessionId: str(obj.id, 120),
    mode: str(obj.mode, 40),
    paymentStatus,
    // Stripe's own fulfilment sample checks `!= 'unpaid'` rather than
    // `== 'paid'`, so that a fully discounted order still gets fulfilled.
    moneyIsIn: paymentStatus !== null && paymentStatus !== "unpaid",
    userId: candidate,
    productKey: str(metadata.product_key, 60),
    quantity,
    amountTotal: int(obj.amount_total),
    currency: str(obj.currency, 10),
    paymentIntentId,
  };
}

// ---------------------------------------------------------------------------
// Subscriptions
//
// WHY invoice.paid, READ FROM docs.stripe.com/billing/subscriptions/webhooks
// AND docs.stripe.com/api/invoices/object, 2026-08-26, not from memory:
//
//   "invoice.paid: Sent when the invoice is successfully paid. You can
//    provision access to your product when you receive this event and the
//    subscription status is active."
//
// and, in the same page's own walkthrough of a renewal:
//
//   "Your site receives an invoice.paid event... Your application updates
//    the customer's access expiry date..."
//
// That is Stripe's own answer to "which event signals a paid renewal",
// stated for exactly this purpose. It is also the ONLY event this file
// subscribes to for subscription money, on purpose: checkout.session.completed
// (mode=subscription) and invoice.paid on that subscription's FIRST invoice
// describe the SAME payment, and granting on both would be exactly the
// double-grant this file already refuses to do for two Paddle event names
// describing one transaction. So checkout.session.completed for a
// subscription is read only far enough to log it (see CHECKOUT_GRANT_EVENTS
// above) and invoice.paid is what actually grants, for that first invoice
// and every renewal after it alike.
//
// billing_reason, from the Invoice object docs, is what tells a first invoice
// from a renewal:
//
//   subscription_create   a new subscription was created (the first invoice)
//   subscription_cycle    a subscription advanced into a new period (a
//                          renewal - this is the one that "silently stops
//                          delivering in month two" if nobody subscribes to
//                          it)
//
// Every other value (subscription_update, subscription_threshold, the
// legacy `subscription`, `manual`) is not something this app sells and is
// refused rather than guessed at: see applySubscriptionCredit in
// entitlements.ts, which records it as needs-attention rather than granting.
//
// WHO PAID. An Invoice has no client_reference_id (that field belongs to
// Checkout Session only) and its own `customer` field is a Stripe customer
// id, not this app's account id - there is no table mapping one to the
// other, and there does not need to be. Instead, the Checkout Session that
// starts a subscription writes `subscription_data.metadata.user_id` /
// `.product_key` (see stripe-checkout/index.ts), and Stripe copies a
// subscription's metadata onto every invoice it generates via
// `parent.subscription_details.metadata` (API version 2025-03-31.basil and
// later; docs.stripe.com/api/invoices/object, "the invoice's
// subscription_details.metadata attribute always contains the subscription's
// metadata at the time of invoice creation"). Read defensively across THREE
// shapes rather than asserting one: this app has never received a live
// invoice payload, and a webhook that 500s on an unrecognised nesting is
// worse than one that tries a second and third place to look.
//
//   1. obj.parent.subscription_details.metadata   (basil and later)
//   2. obj.subscription_details.metadata           (pre-basil top-level shape)
//   3. obj.metadata                                (belt and braces: an
//                                                   invoice-level metadata
//                                                   field, in case a future
//                                                   API version or a manual
//                                                   invoice edit ever puts it
//                                                   there directly)
//
// WHAT WAS BOUGHT. Same three-shape caution for the subscription id, and
// metadata.product_key is preferred for the product exactly as it is for
// Checkout (see readCheckoutEvent above). Unlike Checkout, an invoice's line
// items ARE already in the webhook payload - no expand, no API call - so a
// price id is also read off `lines.data[0].price.id` (or the newer
// `lines.data[0].pricing.price_details.price`) as a fallback the webhook can
// resolve through productForPriceId without ever calling Stripe.

export interface InvoiceRead {
  eventId: string;
  eventType: string;
  invoiceId: string | null;
  subscriptionId: string | null;
  /** null means "not a subscription invoice, or the field was absent" -
   *  treated as unrecognised, never as a renewal by default. */
  billingReason: string | null;
  /** obj.paid === true OR obj.status === "paid". Belt and braces, same
   *  reasoning as moneyIsIn above: the event NAME says "paid", the field is
   *  checked anyway. */
  paid: boolean;
  userId: string | null;
  productKey: string | null;
  /** Only used when metadata carried no product_key. The webhook resolves
   *  this through productForPriceId; this file stays gateway-price-table
   *  agnostic. */
  linePriceId: string | null;
  amountPaid: number | null;
  currency: string | null;
}

function asRecord(v: unknown): Record<string, unknown> | null {
  return v && typeof v === "object" && !Array.isArray(v) ? (v as Record<string, unknown>) : null;
}

/** metadata off an invoice, trying the three shapes described above, in
 *  order. The first one that is actually an object wins; an empty object is
 *  a valid "no metadata was set" and is still returned, not skipped, so a
 *  caller sees `{}` rather than falling through to a less accurate shape. */
function invoiceMetadata(obj: Record<string, unknown>): Record<string, unknown> {
  const parent = asRecord(obj.parent);
  const parentSd = parent ? asRecord(parent.subscription_details) : null;
  if (parentSd && asRecord(parentSd.metadata)) return asRecord(parentSd.metadata)!;

  const topSd = asRecord(obj.subscription_details);
  if (topSd && asRecord(topSd.metadata)) return asRecord(topSd.metadata)!;

  return asRecord(obj.metadata) ?? {};
}

/** The subscription id, same shape-liberal search as the metadata above. Can
 *  arrive as a bare string id or an expanded object with `.id`. */
function invoiceSubscriptionId(obj: Record<string, unknown>): string | null {
  const fromField = (v: unknown): string | null =>
    typeof v === "string" ? str(v, 120) : (asRecord(v) ? str(asRecord(v)!.id, 120) : null);

  const parent = asRecord(obj.parent);
  const parentSd = parent ? asRecord(parent.subscription_details) : null;
  const fromParent = parentSd ? fromField(parentSd.subscription) : null;
  if (fromParent) return fromParent;

  const topSd = asRecord(obj.subscription_details);
  const fromTop = topSd ? fromField(topSd.subscription) : null;
  if (fromTop) return fromTop;

  // Oldest shape of all: `subscription` directly on the invoice.
  return fromField(obj.subscription);
}

function invoiceLinePriceId(obj: Record<string, unknown>): string | null {
  const lines = asRecord(obj.lines);
  const data = lines && Array.isArray(lines.data) ? lines.data : [];
  const first = asRecord(data[0]);
  if (!first) return null;

  const price = asRecord(first.price);
  if (price) {
    const id = str(price.id, 200);
    if (id) return id;
  }
  // Newer line-item shape seen in some API versions.
  const pricing = asRecord(first.pricing);
  const priceDetails = pricing ? asRecord(pricing.price_details) : null;
  const fromPricing = priceDetails ? str(priceDetails.price, 200) : null;
  return fromPricing;
}

/** Pull everything worth knowing out of an invoice event envelope. Returns
 *  null when the envelope is not a Stripe event at all. Same non-negotiable
 *  as readCheckoutEvent: NOTHING HERE DECIDES HOW MANY CREDITS ANYTHING IS
 *  WORTH. The catalogue in products.ts is the only thing allowed to answer
 *  that, from productKey / linePriceId, never from an amount on this object. */
export function readInvoiceEvent(payload: unknown): InvoiceRead | null {
  if (!payload || typeof payload !== "object") return null;
  const evt = payload as Record<string, unknown>;

  const eventId = str(evt.id, 120);
  const eventType = str(evt.type, 120);
  if (!eventId || !eventType) return null;

  const data = asRecord(evt.data);
  const obj = data ? asRecord(data.object) : null;
  if (!obj) {
    return {
      eventId,
      eventType,
      invoiceId: null,
      subscriptionId: null,
      billingReason: null,
      paid: false,
      userId: null,
      productKey: null,
      linePriceId: null,
      amountPaid: null,
      currency: null,
    };
  }

  const metadata = invoiceMetadata(obj);
  const metaUser = str(metadata.user_id, 200);
  const userId = metaUser && UUID_RE.test(metaUser) ? metaUser : null;

  const paidField = obj.paid;
  const status = str(obj.status, 40);
  const paid = paidField === true || status === "paid";

  return {
    eventId,
    eventType,
    invoiceId: str(obj.id, 120),
    subscriptionId: invoiceSubscriptionId(obj),
    billingReason: str(obj.billing_reason, 60),
    paid,
    userId,
    productKey: str(metadata.product_key, 60),
    linePriceId: invoiceLinePriceId(obj),
    amountPaid: int(obj.amount_paid),
    currency: str(obj.currency, 10),
  };
}

/** invoice.paid is the only thing that grants. invoice.payment_failed is
 *  recorded (it is useful context next to a subscription that stops
 *  renewing) but never treated as money. */
export const INVOICE_GRANT_EVENTS = ["invoice.paid"];
export const INVOICE_NOTED_EVENTS = ["invoice.payment_failed"];

// ---------------------------------------------------------------------------
// Subscription status mirror
//
// customer.subscription.created / .updated / .deleted carry the Subscription
// object directly - unlike an Invoice, its `metadata` is a plain top-level
// field (this is the metadata Stripe copies onto invoices; here it is read
// at the source). Nothing here grants or revokes a credit: these three
// events only keep profiles.subscription_status / subscription_id in sync
// for the dashboard. See the migration and stripe-webhook/index.ts for why
// that write is best-effort and never touches project_credits or
// project_entitlements.
//
// .created IS SUBSCRIBED TO, not just .updated and .deleted: a brand new
// subscription that nothing ever changes about (no plan change, no failed
// payment) would otherwise show as "never subscribed" in the dashboard right
// up until its first renewal, which is a month of a paying customer looking
// unpaid.

export const SUBSCRIPTION_STATUS_EVENTS = [
  "customer.subscription.created",
  "customer.subscription.updated",
  "customer.subscription.deleted",
];

export interface SubscriptionStatusRead {
  eventId: string;
  eventType: string;
  subscriptionId: string | null;
  /** Stripe's own Subscription.status: active, trialing, past_due, canceled,
   *  unpaid, incomplete, incomplete_expired, paused. Mirrored as-is, no
   *  translation, so a status Stripe adds later still shows up honestly
   *  rather than being coerced into "unknown". */
  status: string | null;
  userId: string | null;
  productKey: string | null;
  /** Best-effort renewal date. Two known shapes: a top-level field on older
   *  API versions, a per-item field on newer ones. Display only - nothing
   *  gates on it. */
  currentPeriodEnd: number | null;
}

export function readSubscriptionStatusEvent(payload: unknown): SubscriptionStatusRead | null {
  if (!payload || typeof payload !== "object") return null;
  const evt = payload as Record<string, unknown>;

  const eventId = str(evt.id, 120);
  const eventType = str(evt.type, 120);
  if (!eventId || !eventType) return null;

  const data = asRecord(evt.data);
  const obj = data ? asRecord(data.object) : null;
  if (!obj) {
    return {
      eventId,
      eventType,
      subscriptionId: null,
      status: null,
      userId: null,
      productKey: null,
      currentPeriodEnd: null,
    };
  }

  const metadata = asRecord(obj.metadata) ?? {};
  const metaUser = str(metadata.user_id, 200);
  const userId = metaUser && UUID_RE.test(metaUser) ? metaUser : null;

  // Newer API versions moved current_period_end from the subscription itself
  // to its first item; older ones kept it top-level. Both are tried; neither
  // is asserted correct, because this field is display-only.
  const items = asRecord(obj.items);
  const itemsData = items && Array.isArray(items.data) ? items.data : [];
  const firstItem = asRecord(itemsData[0]);
  const currentPeriodEnd = int(obj.current_period_end) ?? (firstItem ? int(firstItem.current_period_end) : null);

  return {
    eventId,
    eventType,
    subscriptionId: str(obj.id, 120),
    status: str(obj.status, 40),
    userId,
    productKey: str(metadata.product_key, 60),
    currentPeriodEnd,
  };
}
