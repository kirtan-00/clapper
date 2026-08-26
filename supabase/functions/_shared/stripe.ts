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

/** The two events subscribed to. See the essay above before changing this. */
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
