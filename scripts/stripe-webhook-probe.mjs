#!/usr/bin/env node
// Fires SIGNED synthetic events at the deployed Stripe webhook and prints what
// it answers. Four cases, and each one pins a different promise:
//
//   valid sig, one-off bundle    -> the grant path runs
//   valid sig, subscription mode -> 200 and NO grant. That session and the
//                                   subscription's first invoice.paid are the
//                                   same money; granting on both double-grants
//   TAMPERED signature           -> 400. The signature IS the authentication
//                                   here, verify_jwt is off for this function
//   valid sig, 10 minutes old    -> 400. Replay window enforced
//
// It reads the signing secret out of the gitignored credentials.md and never
// prints it. Test mode only - do not point this at a live endpoint.
//
// Usage:
//   node scripts/stripe-webhook-probe.mjs ./credentials.md

import { createHmac } from 'node:crypto';
import { readFileSync } from 'node:fs';

const creds = readFileSync(process.argv[2], 'utf8');
const secret = creds.match(/STRIPE_WEBHOOK_SECRET=(\S+)/)?.[1];
if (!secret) throw new Error('no webhook secret found');

// Each run needs its own event id: the purchases primary key is
// (provider, provider_event_id), so re-running with a fixed id would be
// recorded as a duplicate and grant nothing, which reads as a pass.
const RUN = process.argv[4] || String(Math.floor(Math.random() * 1e9));
const USER_ID = process.argv[3] || '00000000-0000-0000-0000-000000000000';
const URL_ = 'https://sqqdivfgdfaztfzrzkhu.supabase.co/functions/v1/stripe-webhook';

async function send(label, body, { skew = 0, tamper = false } = {}) {
  const raw = JSON.stringify(body);
  const t = Math.floor(Date.now() / 1000) + skew;
  let sig = createHmac('sha256', secret).update(`${t}.${raw}`).digest('hex');
  if (tamper) sig = sig.replace(/^./, (c) => (c === 'a' ? 'b' : 'a'));
  const res = await fetch(URL_, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'Stripe-Signature': `t=${t},v1=${sig}` },
    body: raw,
  });
  const text = await res.text();
  console.log(`${label.padEnd(34)} HTTP ${res.status}  ${text.slice(0, 160)}`);
}

const session = (mode, price) => ({
  id: 'evt_synthetic_' + RUN,
  type: 'checkout.session.completed',
  data: { object: {
    id: 'cs_test_synthetic_' + RUN,
    mode,
    payment_status: 'paid',
    amount_total: mode === 'payment' ? 2000 : 500,
    currency: 'usd',
    // A REAL user id, taken from argv. The all-zeros placeholder that used to
    // sit here made every run return 500: purchases.user_id carries a foreign
    // key to auth.users, so a user that does not exist fails the insert and
    // looks exactly like a broken grant path. A test whose failure mode is
    // indistinguishable from the bug it is meant to catch is worse than none.
    client_reference_id: USER_ID,
    // WHAT WAS BOUGHT. The real stripe-checkout endpoint stamps this when it
    // creates the session, and readCheckoutEvent reads it first, falling back
    // to matching the price id against the configured env secrets. Omitting it
    // here made the webhook answer 200 with needs_attention:"unknown_product":
    // recorded, zero credits granted. That is the correct defensive behaviour
    // for a price the catalogue does not know, and it is also exactly what an
    // incomplete test payload produces, so the probe has to send it.
    metadata: { product_key: mode === 'payment' ? 'bundle_5' : 'pro_monthly' },
    customer: 'cus_synthetic',
    subscription: mode === 'subscription' ? 'sub_synthetic' : null,
    line_items: { data: [{ price: { id: price }, quantity: 1 } ] },
  } },
});

const BUNDLE = 'price_1U8jbXGsqJI9pBl6gxRHephE';
const SUBS = 'price_1U8h9eGsqJI9pBl6yPnC5b5d';

await send('valid sig, one-off bundle', session('payment', BUNDLE));
await send('valid sig, subscription mode', session('subscription', SUBS));
await send('TAMPERED signature', session('payment', BUNDLE), { tamper: true });
await send('valid sig but 10 min old', session('payment', BUNDLE), { skew: -600 });
