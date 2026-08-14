// The night switch, as one settings row.
//
// MOUNTING: this renders the ROW ONLY, so it drops straight into a
// `.glist-card` next to the other settings rows:
//
//   <section className="glist">
//     <h2 className="glist-hdr">Display</h2>
//     <div className="glist-card">
//       <ThemeToggleRow />
//       ...more rows...
//     </div>
//   </section>
//
// It takes no props and needs no provider: it reads and writes the theme
// itself through src/ui/theme.ts. Mount it anywhere, once.
//
// One row rather than a floating control, on purpose. This is set once per
// call time, in the van, not fiddled with while a camera is rolling.

import { useSyncExternalStore } from 'react';
import { getTheme, subscribe, toggleTheme } from './theme';
import * as haptics from './haptics';

// Same house rules as the tab tray's set (see TabTray.tsx): one 24 viewBox,
// one 1.75 stroke, round caps and joins, stroke="currentColor" and no fill so
// the colour arrives from the token on the parent and both themes work with no
// extra code. A crescent, drawn as one closed path so it reads at 24px.
function MoonIcon() {
  return (
    <svg viewBox="0 0 24 24" aria-hidden focusable="false" width="24" height="24">
      <path
        d="M20 14.2A8.2 8.2 0 0 1 9.8 4a8.4 8.4 0 1 0 10.2 10.2Z"
        fill="none"
        stroke="currentColor"
        strokeWidth={1.75}
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  );
}

export function ThemeToggleRow() {
  const theme = useSyncExternalStore(subscribe, getTheme, () => 'light' as const);
  const on = theme === 'night';

  return (
    <button
      type="button"
      className="grow"
      data-icon=""
      role="switch"
      aria-checked={on}
      onClick={() => {
        haptics.tap();
        toggleTheme();
      }}
    >
      <span className="grow-icon">
        <MoonIcon />
      </span>
      <span className="grow-label">Night mode</span>
      {/* The switch is the state, so the row does not also spell it out in a
          trailing value: two things saying the same thing is one too many. */}
      <span className={`tswitch${on ? ' tswitch--on' : ''}`} aria-hidden>
        <span className="tswitch__knob" />
      </span>
    </button>
  );
}
