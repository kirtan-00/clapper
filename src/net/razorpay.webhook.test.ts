import { describe, it, expect } from 'vitest';
import {
  hmacSha256Hex,
  timingSafeEqualHex,
  verifyRazorpayWebhook,
} from '../../supabase/functions/_shared/webhook.ts';
import {
  handshakeMessage,
  identityForOrder,
  normalizeNotes,
  peekRazorpayEvent,
  readInvoicePaidEvent,
  readOrderPaidEvent,
  ORDER_GRANT_EVENTS,
  INVOICE_PAID_EVENTS,
  SUBSCRIPTION_GRANT_EVENTS,
  readSubscriptionChargedEvent,
  billingReasonForPaidCount,
  resolveSubscriptionProduct,
  identityForSubscriptionCharge,
} from '../../supabase/functions/_shared/razorpay.ts';
import {
  applySubscriptionCredit,
  type EntitlementStore,
  type CreditPurchase,
  type SubscriptionInvoiceGrant,
} from '../../supabase/functions/_shared/entitlements.ts';

// The webhook signature is the ONLY authentication on razorpay-webhook (it
// runs with verify_jwt off, same as stripe-webhook), and the handshake
// signature is what stands between a scripted browser callback and a real
// credit grant in razorpay-verify. Both are checked here against fixtures
// computed OUTSIDE this code, with node's own crypto: deriving "expected"
// from the same crypto.subtle helper under test would be circular.

const WEBHOOK_SECRET = 'whsec_test_fixture_do_not_use';

// A realistic order.paid delivery: INR 699 (69900 paise, the task's own
// worked example), notes carrying the buyer and the product key exactly as
// razorpay-order writes them.
const ORDER_PAID_BODY =
  '{"entity":"event","event":"order.paid","contains":["payment","order"],' +
  '"payload":{"order":{"entity":{"id":"order_fixture01","status":"paid",' +
  '"amount":69900,"currency":"INR",' +
  '"notes":{"user_id":"11111111-1111-4111-8111-111111111111","product_key":"credit_1"}}}},' +
  '"created_at":1767225600}';

/** HMAC-SHA256(ORDER_PAID_BODY, WEBHOOK_SECRET) per node crypto:
 *  crypto.createHmac('sha256', WEBHOOK_SECRET).update(ORDER_PAID_BODY).digest('hex') */
const ORDER_PAID_SIGNATURE = 'fc5c6031a3ff13ada87e1fa5d65c79f93bb6ab872be8a6226394d96b7f7cc693';

const bytes = (s: string) => new TextEncoder().encode(s);

describe('verifyRazorpayWebhook', () => {
  it('accepts a signature computed outside this code', async () => {
    const result = await verifyRazorpayWebhook(bytes(ORDER_PAID_BODY), ORDER_PAID_SIGNATURE, WEBHOOK_SECRET);
    expect(result).toEqual({ ok: true });
  });

  it('accepts the header in either case (hex is case-insensitive)', async () => {
    const result = await verifyRazorpayWebhook(
      bytes(ORDER_PAID_BODY),
      ORDER_PAID_SIGNATURE.toUpperCase(),
      WEBHOOK_SECRET,
    );
    expect(result).toEqual({ ok: true });
  });

  it('REJECTS a tampered body, one byte changed anywhere breaks the digest', async () => {
    const tampered = ORDER_PAID_BODY.replace('"amount":69900', '"amount":69901');
    const result = await verifyRazorpayWebhook(bytes(tampered), ORDER_PAID_SIGNATURE, WEBHOOK_SECRET);
    expect(result).toEqual({ ok: false, reason: 'mismatch' });
  });

  it('REJECTS a tampered signature, flipping one hex character must not verify', async () => {
    const tamperedSig = 'e' + ORDER_PAID_SIGNATURE.slice(1); // first char flipped
    const result = await verifyRazorpayWebhook(bytes(ORDER_PAID_BODY), tamperedSig, WEBHOOK_SECRET);
    expect(result).toEqual({ ok: false, reason: 'mismatch' });
  });

  it('REJECTS the right body/signature pair under the WRONG secret', async () => {
    const result = await verifyRazorpayWebhook(bytes(ORDER_PAID_BODY), ORDER_PAID_SIGNATURE, 'a_completely_different_secret');
    expect(result).toEqual({ ok: false, reason: 'mismatch' });
  });

  it('refuses a malformed header rather than compare against garbage', async () => {
    expect(await verifyRazorpayWebhook(bytes(ORDER_PAID_BODY), 'not-hex-at-all', WEBHOOK_SECRET))
      .toEqual({ ok: false, reason: 'malformed_header' });
    expect(await verifyRazorpayWebhook(bytes(ORDER_PAID_BODY), ORDER_PAID_SIGNATURE.slice(0, 63), WEBHOOK_SECRET))
      .toEqual({ ok: false, reason: 'malformed_header' });
    expect(await verifyRazorpayWebhook(bytes(ORDER_PAID_BODY), null, WEBHOOK_SECRET))
      .toEqual({ ok: false, reason: 'malformed_header' });
  });

  it('will not verify anything at all when the secret is missing, the clean not_configured case', async () => {
    const result = await verifyRazorpayWebhook(bytes(ORDER_PAID_BODY), ORDER_PAID_SIGNATURE, undefined);
    expect(result).toEqual({ ok: false, reason: 'no_secret' });
  });
});

describe('the client handshake (order_id|payment_id, KEY SECRET: a different message and a different secret from the webhook)', () => {
  const KEY_SECRET = 'rzp_test_secret_fixture_do_not_use';
  const orderId = 'order_fixture01';
  const paymentId = 'pay_fixture01';

  it('builds exactly `${orderId}|${paymentId}`, confirmed against the razorpay-node SDK source', () => {
    expect(handshakeMessage(orderId, paymentId)).toBe('order_fixture01|pay_fixture01');
  });

  /** HMAC-SHA256('order_fixture01|pay_fixture01', KEY_SECRET) per node crypto:
   *  crypto.createHmac('sha256', KEY_SECRET).update('order_fixture01|pay_fixture01').digest('hex') */
  const EXPECTED = '5aebf524d1637417f8b17dd2a150000b692f601b8fa4f7659cda3b9b074af67f';

  it('accepts a signature computed outside this code', async () => {
    const digest = await hmacSha256Hex(handshakeMessage(orderId, paymentId), KEY_SECRET);
    expect(digest).toBe(EXPECTED);
    expect(timingSafeEqualHex(digest, EXPECTED)).toBe(true);
  });

  it('REJECTS a tampered signature, this is bug #2\'s whole defence: a mismatch here must never reach a write', async () => {
    const digest = await hmacSha256Hex(handshakeMessage(orderId, paymentId), KEY_SECRET);
    const tampered = 'f' + digest.slice(1);
    expect(timingSafeEqualHex(digest, tampered)).toBe(false);
  });

  it('REJECTS the same message under the WRONG secret', async () => {
    const digest = await hmacSha256Hex(handshakeMessage(orderId, paymentId), KEY_SECRET);
    const wrong = await hmacSha256Hex(handshakeMessage(orderId, paymentId), 'not_the_real_key_secret');
    expect(timingSafeEqualHex(digest, wrong)).toBe(false);
  });

  it('a different order id or payment id produces a different signature (no cross-order replay)', async () => {
    const original = await hmacSha256Hex(handshakeMessage(orderId, paymentId), KEY_SECRET);
    const otherOrder = await hmacSha256Hex(handshakeMessage('order_someone_elses', paymentId), KEY_SECRET);
    expect(otherOrder).not.toBe(original);
  });
});

describe('identityForOrder: the ONE identity both razorpay-verify and razorpay-webhook must build identically', () => {
  it('uses the order id for both the primary key half and the unique-index half', () => {
    expect(identityForOrder('order_abc123')).toEqual({
      provider: 'razorpay',
      eventId: 'order_abc123',
      providerTxnId: 'order_abc123',
    });
  });
});

describe('readOrderPaidEvent: the grant path\'s payload reader', () => {
  it('reads the order, the notes and the PAISE AMOUNT UNCHANGED off a real payload shape', () => {
    const read = readOrderPaidEvent(JSON.parse(ORDER_PAID_BODY));
    expect(read).not.toBeNull();
    expect(read!.eventType).toBe('order.paid');
    expect(read!.order.id).toBe('order_fixture01');
    expect(read!.order.status).toBe('paid');
    // THE PAISE CHECK. 699 rupees is 69900 paise (the task's own worked
    // example) and nothing in this reader multiplies, divides or rounds it -
    // what goes in over the wire is exactly what comes out here.
    expect(read!.order.amount).toBe(69900);
    expect(read!.order.currency).toBe('INR');
    expect(read!.order.notes).toEqual({
      user_id: '11111111-1111-4111-8111-111111111111',
      product_key: 'credit_1',
    });
  });

  it('reads the settling payment id when the payload carries one', () => {
    const withPayment = JSON.parse(ORDER_PAID_BODY);
    withPayment.payload.payment = { entity: { id: 'pay_abc123' } };
    const read = readOrderPaidEvent(withPayment);
    expect(read!.paymentId).toBe('pay_abc123');
  });

  it('treats Razorpay\'s empty-notes `[]` as no notes at all, not a crash', () => {
    expect(normalizeNotes([])).toEqual({});
    expect(normalizeNotes(null)).toEqual({});
    expect(normalizeNotes({ user_id: 'u1', extra: 42 })).toEqual({ user_id: 'u1' });
  });

  it('refuses a payload missing the fields a grant needs', () => {
    expect(readOrderPaidEvent({ event: 'order.paid', payload: {} })).toBeNull();
    expect(readOrderPaidEvent('not even an object')).toBeNull();
    expect(readOrderPaidEvent({ payload: { order: { entity: { id: 'order_x' } } } })).toBeNull(); // no `event`
  });

  it('is the one event this pair grants on', () => {
    expect(ORDER_GRANT_EVENTS).toEqual(['order.paid']);
  });
});

describe('readInvoicePaidEvent: a subscription grant path since 2026-08-27 (see razorpay-webhook\'s header)', () => {
  // DELIBERATELY CHANGED, not weakened: this used to assert invoice.paid was
  // never granted against at all. It is now the grant path for a
  // subscription cycle (the owner's live webhook has subscription.charged
  // UNTICKED and cannot tick it through the API), and readInvoicePaidEvent
  // grew a `paymentId` field - the idempotency anchor for that grant - so the
  // exact object this reader returns changed. See the "invoice.paid as a
  // subscription grant" suite below for the actual grant behaviour.
  it('reads what it can without throwing on an unfamiliar invoice shape', () => {
    const payload = {
      event: 'invoice.paid',
      payload: {
        invoice: {
          entity: {
            id: 'inv_fixture01',
            status: 'paid',
            subscription_id: 'sub_fixture01',
            amount_paid: 99900,
            currency: 'INR',
            notes: { user_id: '11111111-1111-4111-8111-111111111111' },
            payment_id: 'pay_fixture01',
          },
        },
      },
    };
    const read = readInvoicePaidEvent(payload);
    expect(read).toEqual({
      eventType: 'invoice.paid',
      invoiceId: 'inv_fixture01',
      status: 'paid',
      subscriptionId: 'sub_fixture01',
      amountPaid: 99900,
      currency: 'INR',
      notes: { user_id: '11111111-1111-4111-8111-111111111111' },
      paymentId: 'pay_fixture01',
    });
  });

  // DELIBERATELY CHANGED: this used to assert invoice.paid was flagged for a
  // human and never granted, full stop. It is now the constant
  // razorpay-webhook/index.ts routes BOTH behaviours through - grant when the
  // invoice carries a subscription_id, record-only when it does not (a
  // standalone invoice this app sells nothing that issues) - so the name and
  // the assertion both changed to match. See INVOICE_PAID_EVENTS's own
  // comment in _shared/razorpay.ts.
  it('is subscribed, and is the constant both invoice.paid behaviours route through', () => {
    expect(INVOICE_PAID_EVENTS).toEqual(['invoice.paid']);
  });
});

describe('peekRazorpayEvent', () => {
  it('reads the event type off the top-level payload', () => {
    expect(peekRazorpayEvent(JSON.parse(ORDER_PAID_BODY))).toBe('order.paid');
  });

  it('returns null for anything that is not a Razorpay event envelope', () => {
    expect(peekRazorpayEvent(null)).toBeNull();
    expect(peekRazorpayEvent([])).toBeNull();
    expect(peekRazorpayEvent({})).toBeNull();
  });
});

// ===========================================================================
// SUBSCRIPTIONS, added 2026-08-27. The distinction these cover is the one
// that decides how much money is owed: a first charge grants introCredits,
// a renewal grants credits, and Razorpay's only signal for which is which is
// paid_count on the subscription entity. Getting it wrong is not a crash, it
// is a silent over- or under-grant, so the boundary is pinned here.
// ===========================================================================

describe('subscription.charged', () => {
  const CHARGED = (paidCount: unknown, productKey = 'pro_monthly') => ({
    entity: 'event',
    event: 'subscription.charged',
    contains: ['subscription', 'payment'],
    payload: {
      subscription: {
        entity: {
          id: 'sub_fixture01',
          plan_id: 'plan_fixture01',
          status: 'active',
          paid_count: paidCount,
          notes: { user_id: '11111111-1111-4111-8111-111111111111', product_key: productKey },
        },
      },
      payment: {
        entity: { id: 'pay_fixture01', amount: 99900, currency: 'INR', status: 'captured' },
      },
    },
    created_at: 1767225600,
  });

  // DELIBERATELY CHANGED: this used to assert invoice.paid could never grant.
  // It now can (see the suite below), so the assertion is narrowed to what is
  // still true - the two constants list different event names, and
  // ORDER_GRANT_EVENTS still owns neither.
  it('is a grant event, and so, now, is invoice.paid - both key off the payment id so neither double-grants the other', () => {
    expect(SUBSCRIPTION_GRANT_EVENTS).toContain('subscription.charged');
    expect(SUBSCRIPTION_GRANT_EVENTS).not.toContain('invoice.paid');
    expect(INVOICE_PAID_EVENTS).toContain('invoice.paid');
    expect(ORDER_GRANT_EVENTS).not.toContain('subscription.charged');
  });

  it('reads the subscription, its notes and the payment', () => {
    const read = readSubscriptionChargedEvent(CHARGED(1));
    expect(read?.subscriptionId).toBe('sub_fixture01');
    expect(read?.paidCount).toBe(1);
    expect(read?.paymentId).toBe('pay_fixture01');
    expect(read?.amount).toBe(99900);
    expect(read?.currency).toBe('INR');
    expect(read?.notes.product_key).toBe('pro_monthly');
    expect(read?.notes.user_id).toBe('11111111-1111-4111-8111-111111111111');
  });

  it('refuses a payload with no subscription entity', () => {
    expect(readSubscriptionChargedEvent({ event: 'subscription.charged', payload: {} })).toBeNull();
    expect(readSubscriptionChargedEvent({ payload: { subscription: { entity: { id: 'x' } } } })).toBeNull();
  });

  it('maps paid_count 1 to a first charge and anything higher to a renewal', () => {
    expect(billingReasonForPaidCount(1)).toBe('subscription_create');
    expect(billingReasonForPaidCount(2)).toBe('subscription_cycle');
    expect(billingReasonForPaidCount(37)).toBe('subscription_cycle');
  });

  it('returns null rather than guessing when paid_count is missing', () => {
    // The whole point: applySubscriptionCredit records an unknown billing
    // reason as needs-attention and grants nothing. Defaulting either way
    // would silently pay out the wrong amount, which is unrecoverable
    // without taking money back out of somebody's account.
    expect(billingReasonForPaidCount(null)).toBeNull();
    expect(readSubscriptionChargedEvent(CHARGED(undefined))?.paidCount).toBeNull();
    expect(readSubscriptionChargedEvent(CHARGED('1'))?.paidCount).toBeNull();
  });

  it('refuses a one_time product key on a recurring charge', () => {
    // A credit pack billed every month forever is the failure this stops.
    expect(resolveSubscriptionProduct('credit_1')).toBeNull();
    expect(resolveSubscriptionProduct('bundle_5')).toBeNull();
    expect(resolveSubscriptionProduct('pro_monthly')?.kind).toBe('subscription');
    expect(resolveSubscriptionProduct('studio_plus')?.kind).toBe('subscription');
    expect(resolveSubscriptionProduct('nonsense')).toBeNull();
  });

  it('keys idempotency on the payment id, never the subscription id', () => {
    // A subscription id repeats on every single cycle. Keying on it would
    // make month two dedupe against month one and grant nothing for money
    // that really moved.
    const first = identityForSubscriptionCharge('sub_fixture01', 'pay_month_one', 1);
    const second = identityForSubscriptionCharge('sub_fixture01', 'pay_month_two', 2);
    expect(first.eventId).toBe('pay_month_one');
    expect(first.providerTxnId).toBe('pay_month_one');
    expect(second.eventId).not.toBe(first.eventId);
  });

  it('still produces a distinct key when no payment entity arrives', () => {
    // A shape Razorpay's docs do not describe, but a missing key would make
    // applySubscriptionCredit answer store_error and lose the record.
    const one = identityForSubscriptionCharge('sub_fixture01', null, 1);
    const two = identityForSubscriptionCharge('sub_fixture01', null, 2);
    expect(one.eventId).toBeTruthy();
    expect(one.eventId).not.toBe(two.eventId);
  });

  it('reads current_end off the subscription entity for the profiles mirror, in ISO, and null when absent', () => {
    // current_end is unix seconds on the wire (razorpay.com's own Subscription
    // entity page, read 2026-08-27) - display only, nothing gates on it (see
    // both entitlements migrations' comments on subscription_current_period_end).
    const withEnd = readSubscriptionChargedEvent(CHARGED(2));
    // CHARGED() carries no current_end, so this pins the "absent" half; the
    // fixture is extended inline below for the "present" half.
    expect(withEnd?.currentEnd).toBeNull();

    const payload = CHARGED(2);
    (payload.payload.subscription.entity as Record<string, unknown>).current_end = 1798761600; // 2027-01-01T00:00:00Z
    const read = readSubscriptionChargedEvent(payload);
    expect(read?.currentEnd).toBe('2027-01-01T00:00:00.000Z');
  });
});

// ===========================================================================
// invoice.paid AS A SUBSCRIPTION GRANT, added 2026-08-27. The owner's live
// webhook has order.paid and invoice.paid ticked, subscription.charged NOT
// ticked and not tickable through the API - so a subscription grant that
// only ever fired on subscription.charged was granting nothing for real
// money already taken. This is the fix: invoice.paid grants when the invoice
// carries a subscription_id, through the exact same identityForSubscription-
// Charge + applySubscriptionCredit path subscription.charged always used, so
// the two events can never double-grant the same charge - see both file
// headers.
//
// The fake store below is a slimmed copy of entitlements.grant.test.ts's own
// fake (same conditional-claim semantics; a fake that just returned the row
// every time would prove nothing about idempotency, per that file's own
// header note) rather than an import - these tests exercise razorpay.ts's
// readers and identityForSubscriptionCharge FIRST, and only reach for a store
// to prove the two payloads collapse onto ONE grant.
// ===========================================================================

interface FakeRow {
  provider: string;
  eventId: string;
  userId: string | null;
  credits: number;
  status: string;
}

function fakeSubscriptionStore() {
  const rows = new Map<string, FakeRow>();
  const balances = new Map<string, number>();
  const introBonusGranted = new Set<string>();
  const key = (provider: string, eventId: string) => `${provider}::${eventId}`;

  const store: EntitlementStore = {
    async recordPurchase(p) {
      const k = key(p.provider, p.eventId);
      if (rows.has(k)) return {};
      rows.set(k, { provider: p.provider, eventId: p.eventId, userId: p.userId, credits: p.credits, status: 'received' });
      return {};
    },
    async claimPurchase(provider, eventId) {
      const row = rows.get(key(provider, eventId));
      if (!row || row.status !== 'received') return { claimed: null };
      row.status = 'granting';
      return { claimed: { userId: row.userId, credits: row.credits } };
    },
    async addCredits(userId, credits) {
      const next = (balances.get(userId) ?? 0) + credits;
      balances.set(userId, next);
      return { balance: next };
    },
    async finishPurchase(provider, eventId, status, _note, credits) {
      const row = rows.get(key(provider, eventId));
      if (row) {
        row.status = status;
        if (typeof credits === 'number') row.credits = credits;
      }
      return {};
    },
    async grantSubscriptionCredits(userId, isFirstInvoice, introCredits, renewalCredits) {
      const bonusApplied = isFirstInvoice && !introBonusGranted.has(userId);
      if (bonusApplied) introBonusGranted.add(userId);
      const credits = bonusApplied ? introCredits : renewalCredits;
      const next = (balances.get(userId) ?? 0) + credits;
      balances.set(userId, next);
      return { credits, bonusApplied, balance: next };
    },
    async logEvent() {},
  };
  return { store, rows, balances };
}

const SUB_USER = '11111111-1111-4111-8111-111111111111';

/** The SubscriptionInvoiceGrant applySubscriptionCredit expects, from an
 *  identity plus the catalogue numbers - exactly the shape both the
 *  subscription.charged and invoice.paid blocks in razorpay-webhook/index.ts
 *  build. `paidCount` here stands in for what fetchRazorpaySubscription
 *  would have returned - these tests exercise the identity/idempotency
 *  contract, not the network call. */
function subInvoiceGrant(
  identity: { eventId: string; providerTxnId: string },
  over?: Partial<SubscriptionInvoiceGrant>,
): SubscriptionInvoiceGrant {
  return {
    provider: 'razorpay',
    eventId: identity.eventId,
    userId: SUB_USER,
    productKey: 'pro_monthly',
    billingReason: 'subscription_cycle',
    introCredits: 5,
    renewalCredits: 2,
    amountCents: 49900,
    currency: 'INR',
    providerTxnId: identity.providerTxnId,
    occurredAt: null,
    ...over,
  };
}

const invoiceWithSubscription = (over?: Record<string, unknown>) => ({
  event: 'invoice.paid',
  payload: {
    invoice: {
      entity: {
        id: 'inv_fixture01',
        status: 'paid',
        subscription_id: 'sub_fixture01',
        amount_paid: 49900,
        currency: 'INR',
        payment_id: 'pay_cycle01',
        ...over,
      },
    },
  },
});

describe('invoice.paid as a subscription grant, added 2026-08-27', () => {
  it('an invoice.paid with a subscription id grants once', async () => {
    const read = readInvoicePaidEvent(invoiceWithSubscription());
    expect(read?.subscriptionId).toBe('sub_fixture01');
    expect(read?.paymentId).toBe('pay_cycle01');

    // paidCount 2 stands in for a fetched subscription's paid_count - a
    // renewal, so this grants renewalCredits (2), not the bonus.
    const identity = identityForSubscriptionCharge('sub_fixture01', read!.paymentId, 2);
    const f = fakeSubscriptionStore();
    const out = await applySubscriptionCredit(f.store, subInvoiceGrant(identity));

    expect(out).toEqual({ status: 'granted', credits: 2, balance: 2 });
    expect(f.balances.get(SUB_USER)).toBe(2);
  });

  it('the same payment id arriving twice grants once', async () => {
    const identity = identityForSubscriptionCharge('sub_fixture01', 'pay_cycle01', 2);
    const f = fakeSubscriptionStore();
    const first = await applySubscriptionCredit(f.store, subInvoiceGrant(identity));
    const second = await applySubscriptionCredit(f.store, subInvoiceGrant(identity));

    expect(first).toEqual({ status: 'granted', credits: 2, balance: 2 });
    expect(second).toEqual({ status: 'duplicate' });
    expect(f.balances.get(SUB_USER)).toBe(2);
  });

  it('an invoice.paid and a subscription.charged for the SAME payment grant once between them', async () => {
    // Two different deliveries, two different event NAMES, describing the
    // same charge - the exact double-grant hazard the owner ticking
    // subscription.charged on the dashboard alongside invoice.paid would
    // create. identityForSubscriptionCharge is the one function both
    // razorpay-webhook blocks call, so it must build the SAME key from both
    // payloads' payment ids.
    const invoiceRead = readInvoicePaidEvent(invoiceWithSubscription());
    const chargedRead = readSubscriptionChargedEvent({
      event: 'subscription.charged',
      payload: {
        subscription: { entity: { id: 'sub_fixture01', status: 'active', paid_count: 2, notes: {} } },
        payment: { entity: { id: 'pay_cycle01', amount: 49900, currency: 'INR' } },
      },
    });

    // Same payment, described two ways.
    expect(invoiceRead?.paymentId).toBe('pay_cycle01');
    expect(chargedRead?.paymentId).toBe('pay_cycle01');

    const fromInvoice = identityForSubscriptionCharge('sub_fixture01', invoiceRead!.paymentId, 2);
    const fromCharged = identityForSubscriptionCharge('sub_fixture01', chargedRead!.paymentId, chargedRead!.paidCount);
    expect(fromInvoice).toEqual(fromCharged);

    const f = fakeSubscriptionStore();
    const a = await applySubscriptionCredit(f.store, subInvoiceGrant(fromInvoice));
    const b = await applySubscriptionCredit(f.store, subInvoiceGrant(fromCharged));

    const statuses = [a.status, b.status].sort();
    expect(statuses).toEqual(['duplicate', 'granted']);
    // Exactly one grant's worth of credit, whichever delivery won the race.
    expect(f.balances.get(SUB_USER)).toBe(2);
  });

  it('an invoice.paid with no subscription id does not grant - the standalone-invoice path, unchanged', () => {
    const read = readInvoicePaidEvent({
      event: 'invoice.paid',
      payload: {
        invoice: {
          entity: { id: 'inv_standalone01', status: 'paid', amount_paid: 10000, currency: 'INR' },
        },
      },
    });
    // No subscription_id: razorpay-webhook's invoice.paid block never calls
    // fetchRazorpaySubscription or applySubscriptionCredit for this shape -
    // it stays on the record-only path this reader has always supported.
    expect(read?.subscriptionId).toBeNull();
  });

  it('falls back to the invoice id, never the subscription id, when the invoice carries no payment_id', () => {
    // The one edge case identityForSubscriptionCharge's own composite
    // fallback is wrong for here: paidCount on this path comes from a fetch
    // made at delivery time, not from the payload, so a retry after another
    // cycle landed would compose a DIFFERENT key for the SAME unresolved
    // charge. The invoice id is stable across retries.
    const read = readInvoicePaidEvent(invoiceWithSubscription({ payment_id: undefined }));
    expect(read?.paymentId).toBeNull();
    expect(read?.invoiceId).toBe('inv_fixture01');
  });
});
