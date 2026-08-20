// Shown when a free-tier counter is exhausted (Script Mode / Premiere XML /
// CSV export), and standing on the Account tab.
//
// It used to be a willingness-to-pay PROBE: one tap logged `pro_interest` and
// showed "Pro is not live yet, hang tight". Pro is live now, so this actually
// sells. The `pro_interest` event is kept and still fires on the tap that opens
// the plans, because the ratio of opens to completed payments is the only
// honest read on whether the price is right.
//
// The confetti is still gone and stays gone (2026-08-15-premium-standard.md §6).
// The brass state change is the whole feedback.
//
// PRICES ARE NOT IN THIS FILE. The server owns them
// (supabase/functions/_shared/plans.ts) and the modal shows what the server
// actually charged. A price rendered here would be a second copy that can drift
// from the one that takes the money, and the first time it drifts someone is
// charged something other than what they read.

import { useState } from 'react';
import { track } from '../net/analytics';
import { startCheckout, type PlanKey } from '../net/pay';
import { useSession } from '../net/auth';
import { SignInSheet } from './SignInSheet';
import { SparkMark } from './marks';
import * as haptics from './haptics';

// Where the tap came from. The first three are cap-hits; 'account' is the
// standing CTA, which is interest with no wall behind it and is worth counting
// separately. ANALYTICS ONLY — it gates nothing and the server never sees it.
export type ProGate = 'script' | 'premiere' | 'csv' | 'account';

type Phase =
  | { s: 'idle' }
  | { s: 'plans' }
  | { s: 'paying'; plan: PlanKey }
  | { s: 'done' }
  | { s: 'error'; message: string };

export function ProCta(props: { gate: ProGate }) {
  const [phase, setPhase] = useState<Phase>({ s: 'idle' });
  const [showSignIn, setShowSignIn] = useState(false);
  const session = useSession();

  function openPlans() {
    haptics.tap();
    track('pro_interest', { gate: props.gate });
    setPhase({ s: 'plans' });
  }

  async function buy(plan: PlanKey) {
    if (phase.s === 'paying') return;
    haptics.tap();
    setPhase({ s: 'paying', plan });
    const r = await startCheckout(plan, session.user?.email ?? undefined);

    if (r.ok) {
      track('pro_purchased', { plan });
      haptics.tap();
      setPhase({ s: 'done' });
      return;
    }
    switch (r.reason) {
      case 'dismissed':
        // Closing the modal is not an error and must not be dressed as one.
        // Straight back to the plans, no message.
        setPhase({ s: 'plans' });
        return;
      case 'signin':
        setPhase({ s: 'plans' });
        setShowSignIn(true);
        return;
      case 'network':
        setPhase({ s: 'error', message: 'Could not reach the payment page. Check your connection and try again.' });
        return;
      case 'failed':
        track('pro_payment_failed', { plan });
        setPhase({ s: 'error', message: r.message });
        return;
      case 'unverified':
        // The one branch where money may have moved. Logged separately because
        // it is the only failure worth waking up for.
        track('pro_payment_unverified', { plan });
        setPhase({ s: 'error', message: r.message });
        return;
    }
  }

  if (phase.s === 'done') {
    return (
      <div className="procta">
        <p className="procta__msg procta__msg--good">
          You are on Pro. Script Mode and every export are open. Thank you — genuinely.
        </p>
      </div>
    );
  }

  return (
    <div className="procta">
      {phase.s === 'idle' ? (
        <button type="button" className="procta__btn" onClick={openPlans}>
          <span className="procta__spark" aria-hidden="true">
            <SparkMark />
          </span>
          Wanna go Pro?
        </button>
      ) : (
        <>
          <div className="procta__plans">
            <button
              type="button"
              className="btn btn--go btn--full"
              disabled={phase.s === 'paying'}
              onClick={() => void buy('pro_monthly')}
            >
              {phase.s === 'paying' && phase.plan === 'pro_monthly' ? 'Opening…' : 'Pro — monthly'}
            </button>
            <button
              type="button"
              className="btn btn--full"
              disabled={phase.s === 'paying'}
              onClick={() => void buy('pro_yearly')}
            >
              {phase.s === 'paying' && phase.plan === 'pro_yearly' ? 'Opening…' : 'Pro — 12 months'}
            </button>
          </div>
          <p className="procta__msg">
            The price is shown in the payment window before anything is charged.
            Your logged takes and every backup stay free, always.
          </p>
        </>
      )}

      {phase.s === 'error' && (
        <p className="procta__msg procta__msg--bad" role="alert">
          {phase.message}
        </p>
      )}

      {showSignIn && (
        <SignInSheet onClose={() => setShowSignIn(false)} />
      )}
    </div>
  );
}
