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
  id: 'evt_synthetic_1',
  type: 'checkout.session.completed',
  data: { object: {
    id: 'cs_test_synthetic_1',
    mode,
    payment_status: 'paid',
    amount_total: mode === 'payment' ? 2000 : 500,
    currency: 'usd',
    client_reference_id: '00000000-0000-0000-0000-000000000000',
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
