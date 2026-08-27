// Shared shopping logic for the paywall (ProCta.tsx) and the standing
// pricing table (AccountScreen.tsx). One place for "what is for sale, what
// does it cost, what happens when someone taps it" so the two surfaces never
// drift into disagreeing about a price or a button's behaviour.
//
// PRODUCTS COME FROM THE CATALOGUE, NOT FROM HERE. See
// supabase/functions/_shared/products.ts - the amount, the credit count and
// the label are the server's, this file only orders them for display and
// runs the checkout/subscribe call.
//
// TWO CHECKOUT LANES, ONE HANDLER. `credit_1` and `bundle_5` are `one_time`
// and go through `startCheckout` (net/pay.ts) - live today, a real Rs 1
// payment has already granted a real credit through this exact function.
// `pro_monthly` and `studio_plus` are `subscription` and go through
// `startSubscription`, also live now: it polls the account's own credit
// balance after the modal closes (the webhook is the only path that knows
// whether a charge was a first invoice or a renewal, see that function's own
// header), so a subscribe can genuinely take a few seconds longer to settle
// than a one-off buy. The UI must not look stuck while that happens - see
// the "Working…" state below, which stays up for exactly as long as the
// promise takes rather than a fixed guess.
//
// A SUCCESSFUL PAYMENT NEVER INVENTS A BALANCE. Both functions resolve
// `ok:true` only once a real number is confirmed (startCheckout's verify
// step, or startSubscription's poll of the account's own row) - so `credits`
// and `balance` here are always server-said, never client-guessed. See
// useEntitlements.ts's own header for why the refresh has to be a shared,
// re-broadcast thing rather than a local `useState`.

import { useCallback, useEffect, useState } from 'react';
import { useSession } from '../net/auth';
import { startCheckout, startSubscription, readPromoOffer, type PayResult, type PromoOffer } from '../net/pay';
import { track } from '../net/analytics';
import { PRODUCTS, type Product } from '../../supabase/functions/_shared/products';
import { refreshEntitlements } from './useEntitlements';
import * as haptics from './haptics';

/** The four tiers on the standing ladder, cheapest to most committed - the
 *  order PRICE-SHEET.md lists them in. The launch offer (`jumpstart_5`) is
 *  NOT here: it is promo-gated (first ten accounts only) and read separately
 *  through `usePromoOffer`, never assumed available. */
const DISPLAY_ORDER = ['credit_1', 'bundle_5', 'pro_monthly', 'studio_plus'] as const;

export const SELLABLE_PRODUCTS: Product[] = DISPLAY_ORDER
  .map((key) => PRODUCTS[key])
  .filter((p): p is Product => !!p);

export const ONE_TIME_PRODUCTS: Product[] = SELLABLE_PRODUCTS.filter((p) => p.kind === 'one_time');
export const SUBSCRIPTION_PRODUCTS: Product[] = SELLABLE_PRODUCTS.filter((p) => p.kind === 'subscription');

/** "Rs 699" - written out, not a currency symbol. Matches PRICE-SHEET.md's
 *  own voice and sidesteps a rupee glyph a phone's font might not carry
 *  cleanly. amountCents is paise (see products.ts's own note on why one
 *  field name serves both currencies); this divides by 100 once, here. */
export function formatPrice(product: Product): string {
  const major = Math.round(product.amountCents / 100);
  return `Rs ${major.toLocaleString('en-IN')}`;
}

/**
 * Per-project cost, rounded for display. Hardcoded to the exact figures the
 * owner approved (Rs 699 / 480 / 166 / 125) rather than re-derived by one
 * rounding rule, because no single rule (floor, round, ceil) produces all
 * four from the raw amountCents/credits division at once - e.g. 999/6 is
 * exactly 166.5, and the approved figure rounds that DOWN while 2499/20
 * (124.95) rounds UP. Anything not in this table (the launch offer) falls
 * back to a plain rounded division, which has no such ambiguity at Rs 100
 * for 5 credits.
 */
const PER_PROJECT_DISPLAY: Record<string, number> = {
  credit_1: 699,
  bundle_5: 480,
  pro_monthly: 166,
  studio_plus: 125,
};

export function perProjectCost(product: Product): number {
  const fixed = PER_PROJECT_DISPLAY[product.key];
  if (fixed !== undefined) return fixed;
  return Math.round(product.amountCents / product.credits / 100);
}

function creditsWord(n: number): string {
  return `${n} credit${n === 1 ? '' : 's'}`;
}

/** The row's name + what it gets you. Short on purpose - the number that
 *  does the convincing lives in `tierValue`, not here. */
export function tierLabel(product: Product): string {
  if (product.kind === 'subscription') {
    // No trailing "/mo" here - the sticker price in the value column
    // already carries it, and Studio Plus's wider figures (2,499/125
    // against Studio's 999/166) leave less room for the label before it
    // ellipsizes on a 375-390px row.
    const name = product.key === 'studio_plus' ? 'Studio Plus' : 'Studio';
    return `${name}, ${creditsWord(product.credits)}`;
  }
  return `${product.credits} project ${product.credits === 1 ? 'credit' : 'credits'}`;
}

export interface TierValue {
  /** What you pay, and NOTHING else: "Rs 999", "Rs 2,399". Every sticker on
   *  the ladder is now just money, which is the whole fix - see this
   *  function's own header for the alignment bug that forced this shape. */
  sticker: string;
  /** Second line, muted: the qualifier ("once" / "per month") and, when the
   *  tier buys more than one credit, the per-project figure that argues the
   *  ladder - "once, Rs 480 each", "per month, Rs 125 each". Never null:
   *  every row gets at least the qualifier, which is what stops "Free" and
   *  a real price from reading as the same kind of row. */
  detail: string;
}

/**
 * THE ALIGNMENT FIX. Four prices on this screen used to each end their
 * sticker line in a different WORD - "Rs 699 once", "Rs 999/mo" - so even
 * though `ValueStack` right-aligns every line to the same edge, the DIGITS
 * never landed on it: "once" and "/mo" are different widths, so the money
 * itself staggered while the trailing word lined up instead. That is the
 * owner's own "alignment looks bad" complaint, read literally.
 *
 * The fix is not fancier alignment, it is a shorter sticker: this line is
 * money and nothing else, so its last character is ALWAYS a digit, and
 * flex-end therefore always lines up the digits, not whatever word happened
 * to trail them. The qualifier moves to `detail`, sharing a line with the
 * per-project figure that used to stand alone - one number the ladder needs
 * to argue itself, not two lines pretending to be one.
 */
export function tierValue(product: Product): TierValue {
  const sticker = formatPrice(product);
  const qualifier = product.kind === 'subscription' ? 'per month' : 'once';
  if (product.credits <= 1) return { sticker, detail: qualifier };
  return { sticker, detail: `${qualifier}, Rs ${perProjectCost(product)} each` };
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** A few delayed re-reads, not a poll loop that could run forever: the
 *  webhook that beat verify to the grant (see this file's header) is
 *  typically seconds away, not minutes, and a screen nobody is looking at
 *  should not keep hitting the network for a purchase that already
 *  succeeded. If it still has not landed after these, the balance simply
 *  stays what it was until the next natural refresh (a screen revisit
 *  re-fetches on mount - see useEntitlements.ts). */
async function pollForLateGrant(): Promise<void> {
  for (const delay of [1500, 3000, 6000]) {
    await sleep(delay);
    await refreshEntitlements();
  }
}

export type PurchaseStatus = { kind: 'good' | 'bad'; text: string } | null;

export interface BuyOptions {
  /** Shown instead of the generic network-failure line when the result
   *  comes back `reason: 'network'`. Used for the launch offer: a 409 from
   *  razorpay-order (the ten slots went between the read and the tap) is
   *  not distinguishable from a real network failure at this layer today
   *  (see razorpay-order/index.ts and this file's own note on
   *  `usePromoOffer`), so a caller selling a capped product can supply the
   *  honest, specific guess instead of the generic one. */
  networkFallbackMessage?: string;
}

export interface Purchase {
  /** The product key currently mid-checkout, or null. Every buy button
   *  should disable itself while this is set - Razorpay's modal is one at a
   *  time, a second tap while it is open is never a second purchase. */
  busyKey: string | null;
  status: PurchaseStatus;
  buy(product: Product, opts?: BuyOptions): Promise<PayResult | null>;
}

/**
 * The one buy handler both ProCta and the Account pricing table call.
 * Returns the raw `PayResult` (or null if the tap never reached the server,
 * e.g. no session) so a caller can react to the specific outcome - the
 * launch offer refreshing its own remaining count being the one case that
 * needs to today.
 *
 * CONFIRMATION IS A HAPTIC, NOT CONFETTI. This used to fire a canvas
 * confetti burst (`confetti.ts`, removed 2026-08-27) on every `ok:true`
 * result, including the branch below where the balance has NOT actually
 * landed yet ("Payment confirmed... hang on"). A burst of colour reads as
 * "done, for sure" - it does not know how to say "probably, in a second."
 * `haptics.doubleThump()` is the app's own existing vocabulary for "that
 * committed" (RollingScreen.tsx uses it the same way, marking a take), it
 * is legible in bright sun or full dark where a canvas animation is not,
 * and it costs nothing to a crew that is not looking at the screen at the
 * moment a webhook happens to land. Confetti squares are also just the
 * wrong register for a tool a crew is running at 3am under a deadline - see
 * this task's own note on the owner rejecting anything that reads as
 * decorative rather than earned.
 */
export function usePurchase(): Purchase {
  const { user } = useSession();
  const [busyKey, setBusyKey] = useState<string | null>(null);
  const [status, setStatus] = useState<PurchaseStatus>(null);

  async function buy(product: Product, opts?: BuyOptions): Promise<PayResult | null> {
    haptics.tap();
    setStatus(null);
    if (!user) {
      setStatus({ kind: 'bad', text: 'Sign in first, then try again.' });
      return null;
    }
    setBusyKey(product.key);
    try {
      const run = product.kind === 'subscription' ? startSubscription : startCheckout;
      const result: PayResult = await run(product.key, user.email ?? undefined);

      if (result.ok) {
        track('credits_purchase_succeeded', {
          product: product.key,
          kind: product.kind,
          credits: result.credits,
        });
        haptics.doubleThump();
        if (result.credits > 0) {
          setStatus({
            kind: 'good',
            text: `Done. ${result.credits} credit${result.credits === 1 ? '' : 's'} added.` +
              (result.balance != null ? ` ${result.balance} on your account now.` : ''),
          });
          void refreshEntitlements();
        } else {
          // credits: 0, balance: null - see this file's header. Paid for
          // real; just not confirmed with a number yet.
          setStatus({
            kind: 'good',
            text: 'Payment confirmed. Your balance updates in a few seconds, hang on.',
          });
          void pollForLateGrant();
        }
        return result;
      }

      if (result.reason === 'dismissed') {
        setStatus(null);
        return result;
      }
      if (result.reason === 'signin') {
        setStatus({ kind: 'bad', text: 'Sign in first, then try again.' });
        return result;
      }
      if (result.reason === 'not_configured') {
        track('credits_purchase_failed', { product: product.key, kind: product.kind, reason: result.reason });
        setStatus({ kind: 'bad', text: 'Payments are not switched on for this yet.' });
        return result;
      }
      track('credits_purchase_failed', { product: product.key, kind: product.kind, reason: result.reason });
      const fallback = result.reason === 'network' && opts?.networkFallbackMessage
        ? opts.networkFallbackMessage
        : result.reason === 'failed' || result.reason === 'unverified'
          ? result.message
          : 'Could not start the payment. Try again.';
      setStatus({ kind: 'bad', text: fallback });
      return result;
    } finally {
      setBusyKey(null);
    }
  }

  return { busyKey, status, buy };
}

// ===========================================================================
// THE LAUNCH OFFER
// ===========================================================================
// `jumpstart_5` - Rs 100 for 5 credits, first ten accounts only, one per
// account. Whether to show it and how many are left is decided server-side
// (net/pay.ts's readPromoOffer, backed by supabase/functions/promo-status);
// this hook only re-reads it on mount and exposes a manual `refresh` for
// after a jumpstart purchase attempt settles, so the count updates without
// a reload the same way a normal credit balance does.

export const JUMPSTART_PRODUCT_KEY = 'jumpstart_5';

export interface PromoState {
  offer: PromoOffer | null;
  refresh(): Promise<void>;
}

// A SEAM FOR SCREENSHOTS. DEV ONLY, same move as ShotlistSheet.tsx's
// __clapperShotlistGate and AccountScreen.tsx's __clapperAccountDev: the
// promo's live states (eligible with N left, claimed, signed-out, gone)
// depend on a real account's row in a real database and cannot be stood in
// front of otherwise. Dropped from the shipped bundle by import.meta.env.DEV.
let promoDevOverride: PromoOffer | null | undefined = undefined;
if (import.meta.env.DEV && typeof window !== 'undefined') {
  (window as unknown as Record<string, unknown>).__clapperPromoDev = (o: PromoOffer | null) => {
    promoDevOverride = o;
  };
}

export function usePromoOffer(): PromoState {
  const [offer, setOffer] = useState<PromoOffer | null>(null);

  const refresh = useCallback(async () => {
    if (import.meta.env.DEV && promoDevOverride !== undefined) {
      setOffer(promoDevOverride);
      return;
    }
    const o = await readPromoOffer();
    setOffer(o);
  }, []);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  return { offer, refresh };
}

/** Whether the promo is worth rendering at all. `null` (unreadable, or the
 *  server says it is simply over and not a "your ten are used" case)
 *  means DO NOT SHOW IT - never treat null as available. Slots gone for
 *  everyone but not claimed by THIS account also hides it: a button that
 *  is guaranteed to fail is worse than no button. */
export function showPromo(offer: PromoOffer | null): boolean {
  if (!offer) return false;
  return offer.eligible || offer.alreadyClaimed || !offer.signedIn;
}
