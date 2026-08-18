// Shown only when a free-tier counter is exhausted (Script Mode / Premiere XML /
// CSV export). It is the willingness-to-pay probe: one tap logs a `pro_interest`
// event so we can count real demand in SQL, and shows a short "not yet" note.
//
// There USED to be a 42-square canvas confetti burst here. It is gone, and the
// premium standard bans it by name (2026-08-15-premium-standard.md §6): confetti
// on an upsell is the definition of slop, and a brass state change is enough.
// That state change is what replaced it — the button fills solid brass and holds
// there, which says "logged" for as long as the note is on screen instead of for
// 1200ms of falling squares. The transitions were already declared on
// `.procta__btn`, so the feedback costs no new motion.

import { useRef, useState } from 'react';
import { track } from '../net/analytics';

// Where the tap came from. The first three are cap-hits; 'account' is the
// standing CTA on the Account tab, which is interest with no wall behind it and
// is worth counting separately rather than mislabelling as a cap. This is an
// ANALYTICS label only — it gates nothing and the server never sees it.
export type ProGate = 'script' | 'premiere' | 'csv' | 'account';

/**
 * The "Wanna go Pro?" secondary CTA. Logs `pro_interest` at most once per mount
 * (a fresh cap-hit remounts it); tapping again is a no-op on the wire and leaves
 * the button in its logged state, which is the honest thing to show — the
 * interest is already counted.
 */
export function ProCta(props: { gate: ProGate }) {
  const [revealed, setRevealed] = useState(false);
  const logged = useRef(false);

  function onClick(): void {
    if (!logged.current) {
      track('pro_interest', { gate: props.gate });
      logged.current = true;
    }
    setRevealed(true);
  }

  return (
    <div className="procta">
      <button
        type="button"
        className="procta__btn"
        data-logged={revealed ? '' : undefined}
        onClick={onClick}
      >
        <span className="procta__spark" aria-hidden="true">★</span>
        Wanna go Pro?
      </button>
      {revealed && (
        <p className="procta__msg">
          Pro is not live yet. But we just logged that you want it, and that is exactly
          what gets it built. Hang tight.
        </p>
      )}
    </div>
  );
}
