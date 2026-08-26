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
  INVOICE_NEEDS_ATTENTION_EVENTS,
} from '../../supabase/functions/_shared/razorpay.ts';

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

describe('readInvoicePaidEvent: recorded, never granted (see razorpay-webhook\'s header)', () => {
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
    });
  });

  it('is subscribed but flagged for a human, never granted against: see the file header', () => {
    expect(INVOICE_NEEDS_ATTENTION_EVENTS).toEqual(['invoice.paid']);
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
