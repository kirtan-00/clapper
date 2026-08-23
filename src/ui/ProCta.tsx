// Shown when a free-tier counter is exhausted (Script Mode / Premiere XML /
// CSV export), and standing on the Account tab.
//
// BACK TO A PROBE, 2026-08-24. Pro sold for real for about a week (from
// f6994ba to today): this file called startCheckout and took Razorpay
// payments. The owner looked at that and turned it off on purpose, told in
// advance that doing so stops new sales. This is not a bug getting fixed —
// it is a deliberate pause on selling while he rethinks the offer. One tap
// now: log `pro_interest`, throw a confetti burst, say Pro is not live yet.
// No plans modal, no charge.
//
// Existing Pro customers are unaffected. Entitlement is enforced
// server-side, off `profiles.is_pro` / `pro_until` in
// supabase/functions/export-gate — this component has never been part of
// that check, on the way in or the way out. Nothing here can take away what
// someone already paid for.
//
// The checkout plumbing is not deleted, only unreachable from here. See the
// comment on `startCheckout` in net/pay.ts for what selling again takes: one
// commit, wiring this file's tap back to it.
//
// CONFETTI IS BACK, 2026-08-24. It was cut in a13e86b under
// 2026-08-15-premium-standard.md §6 ("confetti on an upsell is the
// definition of slop; a brass state change is enough") and that section has
// been updated to say so. The call does not even apply any more in the
// literal sense the section argued it — this file is not an upsell right
// now, it is a probe — and the owner reversed the decision outright the same
// day he turned selling back off. Restored from a13e86b^ (the commit right
// before the cut) rather than rewritten, with one change: the old palette was
// `['#38d178', '#d8b23c', '#ece9e1']`, and `#d8b23c` was brass GOLD. The gold
// is gone app-wide as of 2026-08-22 (see the `--brass` token note in
// styles.css), so the confetti now reads its colours off `--m-accent` and the
// neutral `--ink` tokens at burst time — teal on day, acid on night — instead
// of a hardcoded hex for a colour that does not exist anywhere else in the
// app any more. It still skips entirely under `prefers-reduced-motion` and
// the app's own `data-motion="reduce"` override; the message and the logging
// fire either way.

import { useRef, useState } from 'react';
import { track } from '../net/analytics';
import { SparkMark } from './marks';

// Where the tap came from. The first three are cap-hits; 'account' is the
// standing CTA on the Account tab, which is interest with no wall behind it
// and is worth counting separately rather than mislabelling as a cap. This is
// an ANALYTICS label only — it gates nothing and the server never sees it.
export type ProGate = 'script' | 'premiere' | 'csv' | 'account';

/** Same check ShotDeck.tsx uses: the OS preference OR the app's own forced
 *  override (see ui/reduceMotion.ts), because either one on its own misses a
 *  real case — a phone whose OS setting nobody touched, or an operator who
 *  turned the in-app toggle on regardless of what the OS says. */
function prefersReducedMotion(): boolean {
  if (typeof window === 'undefined') return false;
  try {
    if (document.documentElement.getAttribute('data-motion') === 'reduce') return true;
    return window.matchMedia('(prefers-reduced-motion: reduce)').matches;
  } catch {
    return false;
  }
}

/** Read a CSS custom property off <html> at burst time, not at import time,
 *  so a burst mid-theme-swap always matches whichever theme is live rather
 *  than whatever was true when this module first loaded. */
function themeColor(name: string, fallback: string): string {
  if (typeof window === 'undefined' || typeof document === 'undefined') return fallback;
  const v = getComputedStyle(document.documentElement).getPropertyValue(name).trim();
  return v || fallback;
}

/**
 * Fire a lightweight confetti burst from around the given element. Draws ~40
 * squares on a fixed, pointer-events-none canvas that removes itself after the
 * animation. A no-op when the user prefers reduced motion.
 */
function burstConfetti(anchor: HTMLElement | null): void {
  if (typeof window === 'undefined' || typeof document === 'undefined') return;
  if (prefersReducedMotion()) return;

  const w = window.innerWidth;
  const h = window.innerHeight;
  const dpr = Math.min(window.devicePixelRatio || 1, 2);

  const canvas = document.createElement('canvas');
  canvas.width = w * dpr;
  canvas.height = h * dpr;
  canvas.style.cssText =
    'position:fixed;inset:0;width:100%;height:100%;pointer-events:none;z-index:80;';
  document.body.appendChild(canvas);

  const ctx = canvas.getContext('2d');
  if (!ctx) {
    canvas.remove();
    return;
  }
  ctx.scale(dpr, dpr);

  let ox = w / 2;
  let oy = h * 0.4;
  if (anchor) {
    const r = anchor.getBoundingClientRect();
    ox = r.left + r.width / 2;
    oy = r.top + r.height / 2;
  }

  // The app's own palette, read live off the current theme rather than a
  // hardcoded hex baked in for one theme or the other. No gold — that token
  // is gone. --m-accent is #0b4650 on day and #e6ff2b on night; --ink and
  // --ink-dim are the neutrals.
  const colors = [
    themeColor('--m-accent', '#0b4650'),
    themeColor('--ink', '#08160c'),
    themeColor('--ink-dim', '#4a5b45'),
  ];

  const parts = Array.from({ length: 42 }, () => {
    const angle = Math.random() * Math.PI * 2;
    const speed = 3 + Math.random() * 5;
    return {
      x: ox,
      y: oy,
      vx: Math.cos(angle) * speed,
      vy: Math.sin(angle) * speed - 3, // bias upward, then gravity pulls down
      size: 4 + Math.random() * 4,
      rot: Math.random() * Math.PI,
      vr: (Math.random() - 0.5) * 0.34,
      color: colors[(Math.random() * colors.length) | 0],
    };
  });

  const DURATION = 1200;
  const start = performance.now();

  function frame(now: number): void {
    const elapsed = now - start;
    if (elapsed >= DURATION || !ctx) {
      canvas.remove();
      return;
    }
    const fade = 1 - elapsed / DURATION;
    ctx.clearRect(0, 0, w, h);
    for (const p of parts) {
      p.vy += 0.15; // gravity
      p.vx *= 0.99;
      p.x += p.vx;
      p.y += p.vy;
      p.rot += p.vr;
      ctx.save();
      ctx.translate(p.x, p.y);
      ctx.rotate(p.rot);
      ctx.globalAlpha = Math.max(0, fade);
      ctx.fillStyle = p.color;
      ctx.fillRect(-p.size / 2, -p.size / 2, p.size, p.size * 0.62);
      ctx.restore();
    }
    requestAnimationFrame(frame);
  }
  requestAnimationFrame(frame);
}

/**
 * The "Wanna go Pro?" secondary CTA. Logs `pro_interest` at most once per mount
 * (a fresh cap-hit remounts it), but every tap re-shows the note and re-pops the
 * confetti so it always feels responsive.
 */
export function ProCta(props: { gate: ProGate }) {
  const [revealed, setRevealed] = useState(false);
  const logged = useRef(false);
  const btnRef = useRef<HTMLButtonElement>(null);

  function onClick(): void {
    if (!logged.current) {
      track('pro_interest', { gate: props.gate });
      logged.current = true;
    }
    setRevealed(true);
    burstConfetti(btnRef.current);
  }

  return (
    <div className="procta">
      <button ref={btnRef} type="button" className="procta__btn" onClick={onClick}>
        <span className="procta__spark" aria-hidden="true">
          <SparkMark />
        </span>
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
