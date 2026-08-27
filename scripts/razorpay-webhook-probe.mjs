// Replay a signed `order.paid` at the deployed razorpay-webhook, the same way
// scripts/stripe-webhook-probe.mjs does for Stripe. Written 2026-08-27 while
// diagnosing the first REAL live payment (pay_TUiU14TLnFR8BJ, UPI, 100 paise,
// captured) that moved money and granted nothing.
//
// WHAT THIS BISECTS, and what it deliberately cannot. It signs the body with
// the secret in credentials.md - the same string that was pushed to Supabase
// as RAZORPAY_WEBHOOK_SECRET. So a 200 + `granted` proves:
//
//   our function's signature check, its parser, the catalogue lookup, the
//   entitlement grant and the ledger write are all correct, AND the secret
//   the FUNCTION holds matches the one in credentials.md
//
// It proves NOTHING about the secret the Razorpay DASHBOARD holds, because
// this probe never goes near Razorpay. If this passes and a real delivery
// still granted nothing, the mismatch is dashboard-side and the fix is to
// re-enter the credentials.md value there - not to touch Supabase.
//
// Usage:  node scripts/razorpay-webhook-probe.mjs [order_id] [payment_id] [user_id]
// Defaults replay the live ₹1 test order. Safe to re-run: the webhook keys
// idempotency off the ORDER id, so a second run answers `duplicate`, which is
// itself a useful thing to see.

import crypto from 'node:crypto';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const here = dirname(fileURLToPath(import.meta.url));
const creds = readFileSync(join(here, '..', 'credentials.md'), 'utf8');
const match = creds.match(/^RAZORPAY_WEBHOOK_SECRET=(.+)$/m);
if (!match) {
  console.error('RAZORPAY_WEBHOOK_SECRET not found in credentials.md');
  process.exit(1);
}
const SECRET = match[1].trim();

const ORDER_ID = process.argv[2] || 'order_TUXjSYJgCe4Od5';
const PAYMENT_ID = process.argv[3] || 'pay_TUiU14TLnFR8BJ';
const USER_ID = process.argv[4] || '97a3a15a-67b8-46e2-93a1-60d850c57456';
const URL = 'https://sqqdivfgdfaztfzrzkhu.supabase.co/functions/v1/razorpay-webhook';

// Shaped to match a real Razorpay order.paid delivery. The reader only needs
// payload.order.entity, but the payment entity is included because a real
// delivery always carries it and a probe that is narrower than the real thing
// can pass while the real thing fails.
const body = JSON.stringify({
  entity: 'event',
  event: 'order.paid',
  contains: ['payment', 'order'],
  payload: {
    payment: {
      entity: {
        id: PAYMENT_ID,
        entity: 'payment',
        amount: 100,
        currency: 'INR',
        status: 'captured',
        order_id: ORDER_ID,
        method: 'upi',
        captured: true,
      },
    },
    order: {
      entity: {
        id: ORDER_ID,
        entity: 'order',
        amount: 100,
        amount_paid: 100,
        amount_due: 0,
        currency: 'INR',
        receipt: 'cred_97a3a15a67b846e293a160d8',
        status: 'paid',
        attempts: 1,
        notes: { user_id: USER_ID, product_key: 'credit_1' },
      },
    },
  },
  created_at: 1787816770,
});

// Razorpay signs the RAW BODY with the webhook secret - a different secret and
// a different message from the client-side handshake, which signs
// `order_id|payment_id` with the KEY secret. Confusing the two is the single
// most common Razorpay integration bug and _shared/webhook.ts says so at
// length.
const signature = crypto.createHmac('sha256', SECRET).update(body).digest('hex');

const res = await fetch(URL, {
  method: 'POST',
  headers: { 'Content-Type': 'application/json', 'X-Razorpay-Signature': signature },
  body,
});

console.log(`HTTP ${res.status}`);
console.log(await res.text());
