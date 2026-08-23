// Razorpay Standard Checkout, client side.
//
// PAUSED, NOT REMOVED, 2026-08-24. `startCheckout` has no caller right now.
// ui/ProCta.tsx went back to a willingness-to-pay probe (owner's call, taken
// with the revenue consequence stated to him explicitly) and no longer opens
// a plans modal or calls this function. Everything below is left intact and
// exercised by nothing.
//
// The `pro_purchased`, `pro_payment_failed` and `pro_payment_unverified`
// analytics events also went dark with it — they used to fire from
// ProCta.tsx's `buy()` on the three outcomes of a call to `startCheckout`.
// Those event names are not declared anywhere as constants (they were plain
// string literals at the call site), so this note is the only record of them
// while they are unreachable. A gap in `events` for these three names starting
// 2026-08-24 is this change, not a broken pipe.
//
// TO SELL AGAIN: restore ProCta.tsx's plans UI and its `buy()` function (git
// history has it, see the commit that added this paused-probe state) so it
// calls `startCheckout` and re-fires those three events on the result. One
// commit, nothing here needs to change.
//
// The browser's job here is small on purpose: ask the server for an order, hand
// the modal the id it returns, and hand whatever the modal gives back to the
// server for verification. It never sees a price it can change and never
// decides whether a payment counted. Both of those live in the edge functions
// (supabase/functions/razorpay-order and razorpay-verify).
//
// checkout.js is loaded ON DEMAND, not from index.html. Two reasons, and the
// second one matters more:
//   - Clapper works offline. A blocking third-party script in the shell would
//     be a network dependency on the one screen that must load on a farmhouse
//     with no signal.
//   - Nobody who never opens the Pro sheet should be shipped a payment SDK.
// It is also the only third-party script in the app, so it is worth it being
// visible in one file rather than in the HTML.

import { supabase } from './supabase';
import { FunctionsHttpError } from '@supabase/supabase-js';

const CHECKOUT_SRC = 'https://checkout.razorpay.com/v1/checkout.js';

/** Matches the keys in supabase/functions/_shared/plans.ts. The price is NOT
 *  here — the server owns it, and the modal shows what the server charged. */
export type PlanKey = 'pro_monthly' | 'pro_yearly';

export type PayResult =
  | { ok: true; proUntil?: string }
  /** The user closed the modal. Not an error, and must not be shown as one. */
  | { ok: false; reason: 'dismissed' }
  | { ok: false; reason: 'signin' }
  | { ok: false; reason: 'network' }
  /** Razorpay reported the payment itself failed (card declined etc). */
  | { ok: false; reason: 'failed'; message: string }
  /** Paid, but the signature did not check out, or the grant did not land.
   *  These are NOT the same as 'failed' — money may have moved. */
  | { ok: false; reason: 'unverified'; message: string };

interface OrderResponse {
  order_id: string;
  amount: number;
  currency: string;
  key_id: string;
  label: string;
}

interface RazorpaySuccess {
  razorpay_order_id: string;
  razorpay_payment_id: string;
  razorpay_signature: string;
}

// The bits of the global the modal installs. Typed narrowly rather than `any`
// so a change in their SDK shows up as a type error instead of undefined.
interface RazorpayInstance {
  open(): void;
  on(event: 'payment.failed', handler: (r: { error?: { description?: string } }) => void): void;
}
declare global {
  interface Window {
    Razorpay?: new (options: Record<string, unknown>) => RazorpayInstance;
  }
}

let scriptPromise: Promise<boolean> | null = null;

/** Load checkout.js once. Resolves false when it cannot be fetched — offline,
 *  or blocked by a content blocker, which is common enough to handle rather
 *  than let it hang. */
function loadCheckout(): Promise<boolean> {
  if (window.Razorpay) return Promise.resolve(true);
  if (scriptPromise) return scriptPromise;
  scriptPromise = new Promise<boolean>((resolve) => {
    const el = document.createElement('script');
    el.src = CHECKOUT_SRC;
    el.async = true;
    el.onload = () => resolve(!!window.Razorpay);
    el.onerror = () => {
      // Let a later attempt retry rather than caching the failure forever: the
      // usual cause is a dropped connection, and the usual fix is to try again.
      scriptPromise = null;
      resolve(false);
    };
    document.head.appendChild(el);
  });
  return scriptPromise;
}

/**
 * Run the whole purchase. Resolves once the payment is verified server-side,
 * or with the reason it did not happen.
 *
 * `prefill.email` only autofills the modal's field — it is cosmetic. The
 * account that gets Pro is the one on the JWT, decided server-side.
 */
export async function startCheckout(plan: PlanKey, prefillEmail?: string): Promise<PayResult> {
  // 1. Order, from our server.
  let order: OrderResponse;
  try {
    const { data, error } = await supabase.functions.invoke<OrderResponse>('razorpay-order', {
      body: { plan },
    });
    if (error || !data) {
      if (error instanceof FunctionsHttpError && error.context?.status === 401) {
        return { ok: false, reason: 'signin' };
      }
      return { ok: false, reason: 'network' };
    }
    order = data;
  } catch {
    return { ok: false, reason: 'network' };
  }

  // 2. The modal.
  const ready = await loadCheckout();
  if (!ready || !window.Razorpay) return { ok: false, reason: 'network' };

  const outcome = await new Promise<RazorpaySuccess | { dismissed: true } | { failed: string }>(
    (resolve) => {
      // Guard against both handlers firing — Razorpay calls ondismiss after a
      // payment.failed in some flows, and the first answer is the true one.
      let settled = false;
      const settle = (v: RazorpaySuccess | { dismissed: true } | { failed: string }) => {
        if (settled) return;
        settled = true;
        resolve(v);
      };

      const rzp = new window.Razorpay!({
        key: order.key_id,
        order_id: order.order_id,
        amount: order.amount,
        currency: order.currency,
        name: 'Clapper',
        description: order.label,
        prefill: prefillEmail ? { email: prefillEmail } : undefined,
        theme: { color: '#0b4650' }, // --m-accent, the app's own day accent
        handler: (r: RazorpaySuccess) => settle(r),
        modal: { ondismiss: () => settle({ dismissed: true }) },
      });

      rzp.on('payment.failed', (r) => {
        settle({ failed: r?.error?.description || 'The payment did not go through.' });
      });

      rzp.open();
    },
  );

  if ('dismissed' in outcome) return { ok: false, reason: 'dismissed' };
  if ('failed' in outcome) return { ok: false, reason: 'failed', message: outcome.failed };

  // 3. Verify. Until this returns ok, nothing has been bought as far as the app
  // is concerned, no matter what the modal said.
  try {
    const { data, error } = await supabase.functions.invoke<{
      verified?: boolean;
      granted?: boolean;
      proUntil?: string;
      error?: string;
    }>('razorpay-verify', {
      body: {
        razorpay_order_id: outcome.razorpay_order_id,
        razorpay_payment_id: outcome.razorpay_payment_id,
        razorpay_signature: outcome.razorpay_signature,
      },
    });

    if (error || !data?.verified) {
      return {
        ok: false,
        reason: 'unverified',
        message:
          'We could not confirm that payment. If money left your account, email us and we will sort it out.',
      };
    }
    if (data.granted === false) {
      return {
        ok: false,
        reason: 'unverified',
        message:
          'Payment went through but Pro did not switch on. We can see it — email us and it will be fixed.',
      };
    }
    return { ok: true, proUntil: data.proUntil };
  } catch {
    return {
      ok: false,
      reason: 'unverified',
      message:
        'We could not confirm that payment. If money left your account, email us and we will sort it out.',
    };
  }
}
