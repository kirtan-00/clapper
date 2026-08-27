// Shown when a free-tier counter is exhausted (Script Mode / Premiere XML /
// CSV export), and standing on the Account tab.
//
// SELLING AGAIN, 2026-08-27. This file spent a week (2026-08-24 through
// today) as a probe: one tap logged `pro_interest` and said "not live yet",
// on the owner's own deliberate pause - see RazorpayBuyRow.tsx's header for
// the fuller account of that pause and why it did not touch that file. This
// task is the owner's call to reverse it: every gate this component renders
// on now shows the real ladder and takes a real payment.
//
// NO REVEAL TAP. The earlier version of this file (and the "probe" before
// it) put a "Wanna go Pro?" button in front of the offer, tapped to reveal
// it. That step is gone: a cap has already been hit by the time this
// mounts, so hiding the plans behind one more tap was friction with no
// job left to do. `pro_interest` now logs on MOUNT instead, once per
// mount, which is the more honest reading of the event anyway - "this gate
// was shown to someone", not "someone was curious enough to tap a teaser".
//
// GROUPED, NOT A FLAT FIVE-ROW LIST. See PricingRows.tsx's `PricingLadder` -
// the owner's own correction after seeing a flat version: a buyer answers
// one question first (pay per job, or subscribe), so the surface asks it
// that way, in rows, at two different weights, rather than a card grid, a
// "recommended" pill, or dash-bulleted feature lists - all called out by
// name as the AI-generated look this had to stop reading as.
//
// NO CONFETTI. `usePurchase` used to fire a canvas burst on every verified
// purchase (confetti.ts, removed 2026-08-27) - see pricing.ts's own note on
// `usePurchase` for why: it fired even on the "paid for real, balance not
// confirmed yet" branch, which is a certainty confetti cannot honestly
// express, and it is the wrong register for a tool run on set at 3am. A
// purchase now confirms with `haptics.doubleThump()`, the same felt
// confirmation RollingScreen.tsx uses for marking a take.

import { useEffect, useRef } from 'react';
import { track } from '../net/analytics';
import { usePurchase, usePromoOffer, type Purchase } from './pricing';
import { PricingLadder } from './PricingRows';

// Where the tap came from. The first three are cap-hits; 'account' is the
// standing CTA on the Account tab, which is interest with no wall behind it
// and is worth counting separately rather than mislabelling as a cap. This is
// an ANALYTICS label only — it gates nothing and the server never sees it.
// 'callsheet' is its own label as of 2026-08-26, when the call-sheet parse got
// its own counter instead of spending the shotlist import's. Folding the two
// cap-hits back together in the analytics would hide the one thing this split
// was made to find out: which of the two walls people actually hit.
export type ProGate = 'script' | 'callsheet' | 'premiere' | 'csv' | 'account';

export function ProCta(props: { gate: ProGate }) {
  const logged = useRef(false);
  const { busyKey, status, buy } = usePurchase();
  const { offer } = usePromoOffer();
  const purchase: Purchase = { busyKey, status, buy };

  useEffect(() => {
    if (logged.current) return;
    logged.current = true;
    track('pro_interest', { gate: props.gate });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // No Free row, no Enterprise link here - this is a cap-hit paywall, not
  // the full pricing page. Someone reading this already spent their free
  // grant to get here, and Enterprise is a browse-time decision, not a
  // reach-for-your-wallet-right-now one.
  return <PricingLadder offer={offer} purchase={purchase} />;
}
