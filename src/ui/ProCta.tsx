// Shown only when a free-tier counter is exhausted (Script Mode / Premiere XML /
// CSV export). It is the willingness-to-pay probe: one tap logs a `pro_interest`
// event so we can count real demand in SQL, shows a short "not yet" note, and
// pops a tiny handmade confetti burst. No orange, no CDN, no heavy deps. The
// confetti is a few dozen squares on a self-removing canvas, skipped entirely
// under prefers-reduced-motion (the message + logging still fire).

import { useRef, useState } from 'react';
import { track } from '../net/analytics';

// Where the tap came from. The first three are cap-hits; 'account' is the
// standing CTA on the Account tab, which is interest with no wall behind it and
// is worth counting separately rather than mislabelling as a cap. This is an
// ANALYTICS label only — it gates nothing and the server never sees it.
export type ProGate = 'script' | 'premiere' | 'csv' | 'account';

// Palette pulled straight from styles.css tokens: signal green, brass GOLD, and
// chalk. Deliberately no record-red (reads as an error) and never any orange.
const CONFETTI_COLORS = ['#38d178', '#d8b23c', '#ece9e1'];

/**
 * Fire a lightweight confetti burst from around the given element. Draws ~40
 * squares on a fixed, pointer-events-none canvas that removes itself after the
 * animation. A no-op when the user prefers reduced motion.
 */
function burstConfetti(anchor: HTMLElement | null): void {
  if (typeof window === 'undefined' || typeof document === 'undefined') return;
  if (window.matchMedia?.('(prefers-reduced-motion: reduce)').matches) return;

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
      color: CONFETTI_COLORS[(Math.random() * CONFETTI_COLORS.length) | 0],
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
