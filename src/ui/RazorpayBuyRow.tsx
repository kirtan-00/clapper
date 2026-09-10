// NO LONGER RENDERED ANYWHERE, as of 2026-08-27. Settings shows GoProRow
// instead, which navigates to the Account tab's ladder rather than selling a
// second time. Everything below this line describes the world before the
// owner reversed the selling pause, and is kept only because the checkout
// mechanics it proved (order, modal, verify) are the same ones net/pay.ts
// runs today. If you are looking for the buy surface, it is PricingRows.tsx.
//
// The header that follows says this row "is deliberately NOT wired into
// ProCta.tsx" and that it lives in Settings. Both were true when written and
// neither is now: ProCta sells the full ladder, and Settings no longer
// renders this at all. Left in place rather than quietly corrected, because
// the reasoning it records is why two shops existed in the first place.
//
// NEW 2026-08-27. A working Razorpay checkout button, at the owner's direct
// request, with test keys confirmed live against the real API. This is
// deliberately NOT wired into ProCta.tsx (the paywall gate shown on
// Account/Project/Shotlist when a free-tier counter runs out) - that file's
// own header records a considered, explicit decision the owner made on
// 2026-08-24 to pause selling everywhere it appears and show an interest
// probe instead, and this task did not ask for that decision to be
// reversed. This row exists so the checkout mechanics - order, modal,
// verify - can be exercised and proven end to end without touching that
// decision. Wiring a real buy button back into ProCta's three call sites is
// the owner's call to make, same as pausing it was; see ProCta.tsx's own
// header for exactly what that would take.
//
// Settings, not Account: AccountScreen.tsx is off limits (a second, parallel
// change is rewriting the entitlement model there right now), and Settings
// is where StudioRow and the like already live as a self-contained row that
// owns its own state - the same shape this follows.
//
// ONLY `one_time` PRODUCTS ARE OFFERED. razorpay-order refuses a
// `subscription`-kind product outright (Razorpay's Orders API cannot sell
// one - see that file's header), so listing one here would be a button that
// always fails. Filtering here means the failure never has to be explained
// to anybody: a subscription product simply is not a row.
//
// PRICES ARE SHOWN IN WHATEVER CURRENCY THE CATALOGUE SAYS, because the
// catalogue is the only place a price is allowed to come from - this
// component does not know a rupee from a cent. As of the 2026-08-27
// repricing that means `credit_1` (INR 699) and `bundle_5` (INR 2,399) are
// what actually renders here; `pro_monthly` and `studio_plus` are filtered
// out below for being `subscription` kind, not for their currency. Nothing
// here needed to change when the catalogue moved from USD to INR - that is
// the whole point of reading it instead of a hardcoded list.

import { useState } from 'react';
import { Row, Section } from './glist';
import { useSession } from '../net/auth';
import { startCheckout } from '../net/pay';
import { track } from '../net/analytics';
import { PRODUCTS, type Product } from '../../supabase/functions/_shared/products';
import { formatPrice } from './pricing';
import * as haptics from './haptics';

const SELLABLE: Product[] = Object.values(PRODUCTS).filter((p) => p.kind === 'one_time');

export function RazorpayBuyRow() {
  const { user } = useSession();
  const [busyKey, setBusyKey] = useState<string | null>(null);
  const [status, setStatus] = useState<string | null>(null);

  if (SELLABLE.length === 0) return null;

  async function buy(product: Product) {
    haptics.tap();
    setStatus(null);
    if (!user) {
      setStatus('Sign in first, then try again.');
      return;
    }
    setBusyKey(product.key);
    try {
      const result = await startCheckout(product.key, user.email ?? undefined);
      if (result.ok) {
        track('credits_purchase_succeeded', { product: product.key, credits: result.credits });
        setStatus(
          result.credits > 0
            ? `Done. ${result.credits} credit${result.credits === 1 ? '' : 's'} added.`
            : 'Done. Your credits are already on your account.',
        );
        return;
      }
      if (result.reason === 'dismissed') {
        setStatus(null);
        return;
      }
      if (result.reason === 'not_configured') {
        track('credits_purchase_failed', { product: product.key, reason: result.reason });
        setStatus('Payments are not switched on for this yet.');
        return;
      }
      if (result.reason === 'signin') {
        setStatus('Sign in first, then try again.');
        return;
      }
      track('credits_purchase_failed', { product: product.key, reason: result.reason });
      setStatus(result.reason === 'failed' || result.reason === 'unverified' ? result.message : 'Could not start the payment. Try again.');
    } finally {
      setBusyKey(null);
    }
  }

  return (
    <Section title="Buy project credits" note={status ?? undefined}>
      {SELLABLE.map((product) => (
        <Row
          key={product.key}
          label={product.label}
          value={busyKey === product.key ? 'Working…' : formatPrice(product)}
          mono={busyKey !== product.key}
          disabled={busyKey !== null}
          onClick={() => buy(product)}
        />
      ))}
    </Section>
  );
}
