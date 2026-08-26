import { describe, it, expect } from 'vitest';
import { verifyStripeWebhook, parseStripeSignature } from '../../supabase/functions/_shared/webhook.ts';
import {
  CHECKOUT_GRANT_EVENTS,
  readCheckoutEvent,
} from '../../supabase/functions/_shared/stripe.ts';

// The signature check is the ONLY authentication on the Stripe webhook: that
// function runs with verify_jwt off, because Stripe is not a Supabase user.
// Wrong in the permissive direction means anybody who finds the URL can grant
// themselves credits by POSTing JSON.
//
// THE FIXTURE IS HAND COMPUTED, OUTSIDE THE CODE UNDER TEST, with node crypto:
//
//   crypto.createHmac('sha256', SECRET).update(TS + '.' + RAW_BODY).digest('hex')
//
// Deriving "expected" from the same crypto.subtle helper the verifier uses
// would be circular: the pair would agree with each other while both being
// wrong about what Stripe sends.
//
// SECRET IS FAKE. Shaped like a real whsec_ key, never was one.

const SECRET = 'whsec_fixture_secret_do_not_use';
const TS = 1767225600;

// Deliberately not canonical: one space after the first colon, and a é
// written as an escape. Parsing and re-serialising this produces different
// bytes, which is what makes the raw-bytes assertion below mean something.
const RAW_BODY =
  '{"id":"evt_1Qtest", "type":"checkout.session.completed","data":{"object":{"id":"cs_test_a1","object":"checkout.session","mode":"payment","payment_status":"paid","client_reference_id":"11111111-1111-4111-8111-111111111111","amount_total":500,"currency":"usd","metadata":{"product_key":"credits_intro_5","note":"caf\\u00e9"}}}}';

const V1 = '13e4960a1b1c26016bbfd273eccb2760dd7295cb33f0bf686244e741756dc908';
const V1_RESERIALISED = '8fc3ead97981335673c83f230f3f7f02b2d5a38fe6c12152817c84c32c057fd0';

const bytes = (s: string) => new TextEncoder().encode(s);
const NOW_MS = TS * 1000;
const header = `t=${TS},v1=${V1}`;

describe('parseStripeSignature', () => {
  it('reads the documented header shape', () => {
    expect(parseStripeSignature(header)).toEqual({ ts: TS, v1: [V1] });
  });

  it('DISCARDS the v0 scheme entirely', () => {
    // Stripe deliberately sends a fake v0 signature on test events, and their
    // docs say to ignore every scheme that is not v1 to prevent a downgrade
    // attack. v0 must not even reach the compare.
    const p = parseStripeSignature(`t=${TS},v1=${V1},v0=${'f'.repeat(64)}`);
    expect(p).toEqual({ ts: TS, v1: [V1] });
  });

  it('rejects a header carrying only a v0', () => {
    expect(parseStripeSignature(`t=${TS},v0=${V1}`)).toBeNull();
  });

  it('keeps every v1, because a secret roll leaves two active for a day', () => {
    const other = 'a'.repeat(64);
    expect(parseStripeSignature(`t=${TS},v1=${other},v1=${V1}`)?.v1).toEqual([other, V1]);
  });

  it('refuses anything malformed rather than half reading it', () => {
    expect(parseStripeSignature(null)).toBeNull();
    expect(parseStripeSignature('')).toBeNull();
    expect(parseStripeSignature(`v1=${V1}`)).toBeNull();
    expect(parseStripeSignature(`t=${TS}`)).toBeNull();
    expect(parseStripeSignature(`t=nope,v1=${V1}`)).toBeNull();
    expect(parseStripeSignature(`t=${TS},v1=zz`)).toBeNull();
  });
});

describe('verifyStripeWebhook', () => {
  it('accepts the fixture', async () => {
    expect(await verifyStripeWebhook(bytes(RAW_BODY), header, SECRET, { nowMs: NOW_MS }))
      .toEqual({ ok: true, ts: TS });
  });

  it('REJECTS the re-serialised body, proving the raw bytes are what is hashed', async () => {
    const reserialised = JSON.stringify(JSON.parse(RAW_BODY));
    expect(reserialised).not.toBe(RAW_BODY);
    expect(await verifyStripeWebhook(bytes(reserialised), header, SECRET, { nowMs: NOW_MS }))
      .toEqual({ ok: false, reason: 'mismatch' });

    // The re-serialised form has a perfectly good digest of its own. An
    // implementation that hashed it would have looked fine in a test.
    const wrong = `t=${TS},v1=${V1_RESERIALISED}`;
    expect((await verifyStripeWebhook(bytes(reserialised), wrong, SECRET, { nowMs: NOW_MS })).ok).toBe(true);
  });

  it('rejects a tampered body, a wrong secret and a wrong timestamp', async () => {
    const tampered = RAW_BODY.replace('"amount_total":500', '"amount_total":1');
    expect((await verifyStripeWebhook(bytes(tampered), header, SECRET, { nowMs: NOW_MS })).ok).toBe(false);
    expect((await verifyStripeWebhook(bytes(RAW_BODY), header, SECRET + 'x', { nowMs: NOW_MS })).ok).toBe(false);
    // The timestamp is inside the signed payload, so changing it in the header
    // invalidates the signature as well as failing the recency check.
    const shifted = `t=${TS + 1},v1=${V1}`;
    expect((await verifyStripeWebhook(bytes(RAW_BODY), shifted, SECRET, { nowMs: NOW_MS })).ok).toBe(false);
  });

  it('rejects a replay outside the five minute window, in both directions', async () => {
    expect(await verifyStripeWebhook(bytes(RAW_BODY), header, SECRET, { nowMs: NOW_MS + 3600_000 }))
      .toEqual({ ok: false, reason: 'stale' });
    expect(await verifyStripeWebhook(bytes(RAW_BODY), header, SECRET, { nowMs: NOW_MS - 3600_000 }))
      .toEqual({ ok: false, reason: 'stale' });
  });

  it('refuses to let a zero tolerance switch the recency check off', async () => {
    // Stripe's docs warn about this in bold: zero does not mean strict, it
    // disables the check. A caller passing 0 gets the default instead.
    const stillFresh = await verifyStripeWebhook(bytes(RAW_BODY), header, SECRET, {
      nowMs: NOW_MS + 60_000,
      toleranceSecs: 0,
    });
    expect(stillFresh.ok).toBe(true);
    const stale = await verifyStripeWebhook(bytes(RAW_BODY), header, SECRET, {
      nowMs: NOW_MS + 3600_000,
      toleranceSecs: 0,
    });
    expect(stale).toEqual({ ok: false, reason: 'stale' });
  });

  it('will not verify anything at all when the secret is missing', async () => {
    for (const missing of [undefined, null, '']) {
      expect(await verifyStripeWebhook(bytes(RAW_BODY), header, missing, { nowMs: NOW_MS }))
        .toEqual({ ok: false, reason: 'no_secret' });
    }
  });

  it('accepts when one of several rotated v1 values matches', async () => {
    const rotating = `t=${TS},v1=${'b'.repeat(64)},v1=${V1}`;
    expect((await verifyStripeWebhook(bytes(RAW_BODY), rotating, SECRET, { nowMs: NOW_MS })).ok).toBe(true);
  });
});

describe('readCheckoutEvent', () => {
  const parse = () => readCheckoutEvent(JSON.parse(RAW_BODY));

  it('reads the account, the product and the money off the fixture', () => {
    const r = parse()!;
    expect(r.eventId).toBe('evt_1Qtest');
    expect(r.eventType).toBe('checkout.session.completed');
    expect(r.sessionId).toBe('cs_test_a1');
    expect(r.mode).toBe('payment');
    expect(r.userId).toBe('11111111-1111-4111-8111-111111111111');
    expect(r.productKey).toBe('credits_intro_5');
    expect(r.amountTotal).toBe(500);
    expect(r.currency).toBe('usd');
    expect(r.moneyIsIn).toBe(true);
  });

  const session = (over: Record<string, unknown>) => ({
    id: 'evt_x',
    type: 'checkout.session.completed',
    data: { object: { id: 'cs_x', mode: 'payment', payment_status: 'paid', ...over } },
  });

  it('does NOT treat an unpaid session as money', () => {
    // The whole reason two events are subscribed to. A delayed payment method
    // completes the session before the funds arrive.
    expect(readCheckoutEvent(session({ payment_status: 'unpaid' }))!.moneyIsIn).toBe(false);
    expect(readCheckoutEvent(session({ payment_status: 'paid' }))!.moneyIsIn).toBe(true);
    // A fully discounted order is a deliberate act, not a missing payment.
    expect(readCheckoutEvent(session({ payment_status: 'no_payment_required' }))!.moneyIsIn).toBe(true);
    // No status at all is not money either.
    expect(readCheckoutEvent(session({ payment_status: null }))!.moneyIsIn).toBe(false);
  });

  it('takes the account from client_reference_id, falling back to metadata', () => {
    const uid = '22222222-2222-4222-8222-222222222222';
    expect(readCheckoutEvent(session({ client_reference_id: uid }))!.userId).toBe(uid);
    expect(readCheckoutEvent(session({ metadata: { user_id: uid } }))!.userId).toBe(uid);
    // client_reference_id wins when both are present and valid.
    const other = '33333333-3333-4333-8333-333333333333';
    expect(readCheckoutEvent(session({ client_reference_id: uid, metadata: { user_id: other } }))!.userId)
      .toBe(uid);
  });

  it('reads a junk account id as ABSENT rather than as an account', () => {
    // A non-uuid must not become a user id that some later query then treats
    // as real. Absent means the purchase is recorded as user_unknown and a
    // human looks at it.
    for (const junk of ['not-a-uuid', '', '11111111-1111-4111-8111', 42, null, {}]) {
      expect(readCheckoutEvent(session({ client_reference_id: junk }))!.userId).toBeNull();
    }
  });

  it('clamps quantity and never reads a credit count out of metadata', () => {
    expect(readCheckoutEvent(session({ metadata: { quantity: '3' } }))!.quantity).toBe(3);
    expect(readCheckoutEvent(session({ metadata: { quantity: '0' } }))!.quantity).toBe(1);
    expect(readCheckoutEvent(session({ metadata: { quantity: '9999' } }))!.quantity).toBe(1);
    expect(readCheckoutEvent(session({ metadata: { quantity: 'lots' } }))!.quantity).toBe(1);
    // There is no `credits` field on the read at all: the catalogue is the
    // only thing allowed to say what a product is worth.
    expect('credits' in readCheckoutEvent(session({ metadata: { credits: 500 } }))!).toBe(false);
  });

  it('handles payment_intent as an id or as an expanded object', () => {
    expect(readCheckoutEvent(session({ payment_intent: 'pi_1' }))!.paymentIntentId).toBe('pi_1');
    expect(readCheckoutEvent(session({ payment_intent: { id: 'pi_2' } }))!.paymentIntentId).toBe('pi_2');
    expect(readCheckoutEvent(session({}))!.paymentIntentId).toBeNull();
  });

  it('returns null for anything that is not an event envelope', () => {
    expect(readCheckoutEvent(null)).toBeNull();
    expect(readCheckoutEvent('{}')).toBeNull();
    expect(readCheckoutEvent({ id: 'evt_x' })).toBeNull();
    expect(readCheckoutEvent({ type: 'checkout.session.completed' })).toBeNull();
  });

  it('subscribes to both grant events and no more', () => {
    expect(CHECKOUT_GRANT_EVENTS).toEqual([
      'checkout.session.completed',
      'checkout.session.async_payment_succeeded',
    ]);
  });
});
