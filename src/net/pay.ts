// UN-PARKED 2026-08-27. Razorpay is a SECOND provider, INR, alongside
// Stripe/Paddle in USD - see supabase/functions/razorpay-order/index.ts's
// header for the fuller story of why the PARKED framing this file carried
// (written 2026-08-26, for a plan that changed the next day) no longer
// applies.
//
// REBUILT around the new server contract. The old version of this file sent
// `{ plan: 'pro_monthly' | 'pro_yearly' }` to razorpay-order and read
// `proUntil` back off razorpay-verify - both artifacts of the time-based
// `profiles.is_pro` / `pro_until` model. The server now sells PRODUCTS from
// _shared/products.ts (a project-credit catalogue, not a plan-key one) and
// grants CREDITS, not a renewed expiry date, so `startCheckout` takes a
// product key and `PayResult` reports a credit grant. See
// razorpay-verify/index.ts's header for what "verified" now means when the
// grant path is a claim against `purchases` rather than a status column.
//
// The browser's job here is still small on purpose: ask the server for an
// order, hand the modal the id it returns, and hand whatever the modal gives
// back to the server for verification. It never sees a price it can change
// and never decides whether a payment counted. Both of those live in the
// edge functions (supabase/functions/razorpay-order and razorpay-verify).
//
// checkout.js is loaded ON DEMAND, not from index.html. Two reasons, and the
// second one matters more:
//   - Clapper works offline. A blocking third-party script in the shell would
//     be a network dependency on the one screen that must load on a farmhouse
//     with no signal.
//   - Nobody who never opens a buy button should be shipped a payment SDK.
// It is also the only third-party script in the app, so it is worth it being
// visible in one file rather than in the HTML.

import { supabase } from './supabase';
import { FunctionsHttpError } from '@supabase/supabase-js';

const CHECKOUT_SRC = 'https://checkout.razorpay.com/v1/checkout.js';

export type PayResult =
  /** Verified AND granted: `credits` new credits, `balance` the account's
   *  total afterwards. */
  | { ok: true; credits: number; balance: number | null }
  /** The user closed the modal. Not an error, and must not be shown as one. */
  | { ok: false; reason: 'dismissed' }
  | { ok: false; reason: 'signin' }
  /** razorpay-order answered `not_configured` - selling is not switched on
   *  for this product/deployment. Distinct from 'network' so a caller can
   *  fall back to an interest probe instead of a retry prompt. */
  | { ok: false; reason: 'not_configured' }
  | { ok: false; reason: 'network' }
  /** Razorpay reported the payment itself failed (card declined etc). */
  | { ok: false; reason: 'failed'; message: string }
  /** Paid, but the signature did not check out, or the grant did not land.
   *  These are NOT the same as 'failed' - money may have moved. */
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

/** Load checkout.js once. Resolves false when it cannot be fetched, offline
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
 * Run the whole purchase for one PRODUCT (a key from
 * supabase/functions/_shared/products.ts, e.g. `bundle_5`). Resolves once
 * the payment is verified and applied server-side, or with the reason it
 * did not happen.
 *
 * `prefill.email` only autofills the modal's field, it is cosmetic. The
 * account that gets credited is the one on the JWT, decided server-side.
 */
export async function startCheckout(productKey: string, prefillEmail?: string): Promise<PayResult> {
  // 1. Order, from our server.
  let order: OrderResponse;
  try {
    const { data, error } = await supabase.functions.invoke<OrderResponse>('razorpay-order', {
      body: { product: productKey },
    });
    if (error || !data) {
      if (error instanceof FunctionsHttpError) {
        const status = error.context?.status;
        if (status === 401) return { ok: false, reason: 'signin' };
        if (status === 503) return { ok: false, reason: 'not_configured' };
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
      // Guard against both handlers firing: Razorpay calls ondismiss after a
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

  // 3. Verify. Until this returns granted, nothing has been bought as far as
  // the app is concerned, no matter what the modal said.
  try {
    const { data, error } = await supabase.functions.invoke<{
      verified?: boolean;
      granted?: number | false;
      balance?: number | null;
      alreadyProcessed?: boolean;
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
    if (data.alreadyProcessed) {
      // The webhook (or a retried tap) already won this grant. Not a
      // failure - the credits are on the account either way, this call just
      // was not the one that put them there.
      return { ok: true, credits: 0, balance: null };
    }
    if (typeof data.granted !== 'number') {
      return {
        ok: false,
        reason: 'unverified',
        message: data.error ??
          'Payment went through but we could not apply it automatically. Email us and we will sort it out.',
      };
    }
    return { ok: true, credits: data.granted, balance: data.balance ?? null };
  } catch {
    return {
      ok: false,
      reason: 'unverified',
      message:
        'We could not confirm that payment. If money left your account, email us and we will sort it out.',
    };
  }
}

// ===========================================================================
// SUBSCRIPTIONS. Added 2026-08-27 alongside supabase/functions/razorpay-
// subscription. Read startCheckout above first: everything up to the modal is
// the same shape, and only the last third genuinely differs.
//
// WHY THERE IS NO CLIENT-SIDE VERIFY STEP HERE, unlike the one-off path.
// Razorpay's subscription handshake signs `payment_id|subscription_id` - note
// the REVERSED order against an order's `order_id|payment_id` - and even a
// correct check of it would only prove a payment happened. It could not say
// whether this was a first charge or a renewal, and that distinction decides
// how many credits are owed. Only `subscription.charged` carries paid_count,
// so the webhook is not merely the durable grant path here, it is the ONLY
// path that can compute the right answer. Adding a browser-side grant would
// mean a second implementation of the same decision, in the place least able
// to make it.
//
// SO THIS POLLS. The modal closes, the webhook lands a second or two later,
// and this watches the account's own credit balance until it moves. That is
// slower than the one-off path by design, and it is honest: the number it
// reports is one the server has already written down, never an optimistic
// guess. If nothing lands inside the window below, that is a REAL anomaly -
// money moved and the grant did not - so it resolves 'unverified' with the
// same wording the one-off path uses, which tells the person to email us
// rather than pretending either outcome.
// ===========================================================================

interface SubscriptionResponse {
  subscription_id: string;
  amount: number;
  currency: string;
  key_id: string;
  label: string;
}

/** How long to wait for the webhook's grant before calling it an anomaly.
 *  Razorpay delivers subscription.charged within a couple of seconds in
 *  practice; 30s is generous enough that a slow delivery is not reported as
 *  a failure, and short enough that somebody is not left staring at a
 *  spinner if the webhook is genuinely broken. */
const GRANT_WAIT_MS = 30_000;
const GRANT_POLL_MS = 1_500;

/** Read the account's own credit balance. Null when signed out or the row is
 *  unreadable - the caller treats null as "cannot tell", never as zero. */
async function readCredits(): Promise<number | null> {
  try {
    const { data, error } = await supabase
      .from('profiles')
      .select('project_credits')
      .maybeSingle();
    if (error || !data) return null;
    const n = (data as { project_credits: number | null }).project_credits;
    return typeof n === 'number' ? n : null;
  } catch {
    return null;
  }
}

/**
 * Subscribe to a recurring PRODUCT (a `subscription`-kind key from
 * supabase/functions/_shared/products.ts: `pro_monthly` or `studio_plus`).
 * Resolves once the first charge's credits are visible on the account, or
 * with the reason it did not happen.
 *
 * Same `PayResult` union as startCheckout, deliberately: a caller should not
 * have to branch on which kind of thing was bought to know how it went.
 */
export async function startSubscription(productKey: string, prefillEmail?: string): Promise<PayResult> {
  // 0. The balance BEFORE any money moves. This is what makes the poll below
  // meaningful: without a baseline, an account that already had credits
  // would look granted the instant the first read came back.
  const before = await readCredits();

  // 1. Subscription, from our server.
  let sub: SubscriptionResponse;
  try {
    const { data, error } = await supabase.functions.invoke<SubscriptionResponse>('razorpay-subscription', {
      body: { product: productKey },
    });
    if (error || !data) {
      if (error instanceof FunctionsHttpError) {
        const status = error.context?.status;
        if (status === 401) return { ok: false, reason: 'signin' };
        if (status === 503) return { ok: false, reason: 'not_configured' };
      }
      return { ok: false, reason: 'network' };
    }
    sub = data;
  } catch {
    return { ok: false, reason: 'network' };
  }

  // 2. The modal. `subscription_id` where a one-off passes `order_id`; that
  // one field is the whole difference on this side.
  const ready = await loadCheckout();
  if (!ready || !window.Razorpay) return { ok: false, reason: 'network' };

  const outcome = await new Promise<'paid' | 'dismissed' | { failed: string }>((resolve) => {
    let settled = false;
    const settle = (v: 'paid' | 'dismissed' | { failed: string }) => {
      if (settled) return;
      settled = true;
      resolve(v);
    };

    const rzp = new window.Razorpay!({
      key: sub.key_id,
      subscription_id: sub.subscription_id,
      name: 'Clapper',
      description: sub.label,
      prefill: prefillEmail ? { email: prefillEmail } : undefined,
      theme: { color: '#0b4650' }, // --m-accent, the app's own day accent
      // The handshake fields are deliberately ignored - see the section
      // header for why verifying them here would not answer the question
      // that actually matters.
      handler: () => settle('paid'),
      modal: { ondismiss: () => settle('dismissed') },
    });

    rzp.on('payment.failed', (r) => {
      settle({ failed: r?.error?.description || 'The payment did not go through.' });
    });

    rzp.open();
  });

  if (outcome === 'dismissed') return { ok: false, reason: 'dismissed' };
  if (typeof outcome === 'object') return { ok: false, reason: 'failed', message: outcome.failed };

  // 3. Wait for the webhook's grant to become visible.
  const deadline = Date.now() + GRANT_WAIT_MS;
  while (Date.now() < deadline) {
    await new Promise((r) => setTimeout(r, GRANT_POLL_MS));
    const now = await readCredits();
    // `before` null means we could not read a baseline, so any readable
    // non-zero balance is the best evidence available. `now` null means we
    // still cannot read: keep waiting rather than concluding anything.
    if (now === null) continue;
    if (before === null ? now > 0 : now > before) {
      return { ok: true, credits: before === null ? now : now - before, balance: now };
    }
  }

  return {
    ok: false,
    reason: 'unverified',
    message:
      'The payment went through but the credits have not landed yet. Email us and we will sort it out.',
  };
}
