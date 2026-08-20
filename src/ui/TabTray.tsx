// The bottom nav. Four sections, always there, except where it is not:
// see AppShell for the two screens that unmount it outright.
//
// ROUND 1/2 SHAPE: a FLOATING POD, not a full-width bar. One filled accent
// pill carries the section you are in; the other three are circular icon
// buttons beside it. The block is `.mnav` (skin/shell.css) rather than the old
// `.tabtray`, so the shipped bar's rules in styles.css - a four-column grid, a
// material blur, a 3px mark on a hairline - are not being fought with
// overrides. Nothing outside this file ever referenced those class names.
//
// WHY A POD RATHER THAN A BAR - THE REACH. A bar spreads four cells across the
// full 390, which puts the leftmost cell ~337px from a right thumb's pivot:
// two-handed, on a phone held one-handed in the other hand's glove. The pod is
// only as wide as its contents and centred, so every target moves inboard by
// the width of the margins. The measured before/after is in the lane report;
// the levers are --m-nav-pad and --m-nav-item-gap in shell.css.
//
// Icons are hand-drawn inline SVG in the SF Symbols IDIOM, not SF Symbols
// themselves: Apple's licence covers Apple-platform UI, not a web PWA
// redistributing the glyphs. No icon font and no CDN either (offline PWA), and
// certainly no emoji, which is the loudest "nobody designed this" tell there
// is.
//
// The house rules for the set, so a fifth icon added later still matches:
//   - one 24 viewBox, one 1.75 stroke, across all four. Never mix a filled
//     mark into a stroked row.
//   - round caps and joins, one corner-radius family (2.5), so they read as
//     one hand.
//   - stroke="currentColor" and no fill, so colour arrives from the token on
//     the parent and the active state, both themes and the light repaint all
//     work without touching this file.
//   - optically centred on 12,12 rather than mathematically: each mark's own
//     ink is balanced, not its bounding box.
//
// The marks are the app's own vocabulary: HOME is the clapper stick from the
// masthead, PROJECTS is one slate stacked behind another, SETTINGS is a pair
// of faders (a sound desk, not the gear every other app reaches for), ACCOUNT
// is a plain head and shoulders.

import type { Nav, Tab } from './nav';
import { TABS } from './nav';
import * as haptics from './haptics';

const LABEL: Record<Tab, string> = {
  home: 'Home',
  projects: 'Projects',
  settings: 'Settings',
  account: 'Account',
};

const STROKE = {
  fill: 'none',
  stroke: 'currentColor',
  strokeWidth: 1.75,
  strokeLinecap: 'round' as const,
  strokeLinejoin: 'round' as const,
};

function Icon(props: { tab: Tab }) {
  const common = {
    className: 'mnav__icon',
    viewBox: '0 0 24 24',
    'aria-hidden': true,
    focusable: 'false' as const,
  };
  switch (props.tab) {
    // The clapper stick, closed. Two slashes, not three: at 22px a third is mush.
    case 'home':
      return (
        <svg {...common}>
          <rect x="3" y="9" width="18" height="11.5" rx="2.5" {...STROKE} />
          <path d="M3 9V5.6L20 3.7a1.2 1.2 0 0 1 1 1.2V9" {...STROKE} />
          <path d="M8.2 5 6.8 9M14 4.4 12.6 9" {...STROKE} />
        </svg>
      );
    // One slate behind another. Only the visible L of the back card is drawn,
    // so no stroke crosses another and it stays clean at 22px.
    case 'projects':
      return (
        <svg {...common}>
          <rect x="3.5" y="8" width="12.5" height="12.5" rx="2.5" {...STROKE} />
          <path
            d="M8 8V6a2.5 2.5 0 0 1 2.5-2.5H18A2.5 2.5 0 0 1 20.5 6v7.5A2.5 2.5 0 0 1 18 16h-2"
            {...STROKE}
          />
        </svg>
      );
    case 'settings':
      return (
        <svg {...common}>
          <path d="M3.5 8h17M3.5 16h17" {...STROKE} />
          <circle cx="9" cy="8" r="2.6" {...STROKE} />
          <circle cx="15.5" cy="16" r="2.6" {...STROKE} />
        </svg>
      );
    case 'account':
      return (
        <svg {...common}>
          <circle cx="12" cy="8" r="3.8" {...STROKE} />
          <path d="M4.8 20.2a7.2 7.2 0 0 1 14.4 0" {...STROKE} />
        </svg>
      );
  }
}

export function TabTray(props: { nav: Nav }) {
  const { nav } = props;
  return (
    // The <nav> spans the window so the pod can centre in it, but only the pod
    // takes pointer events - the gutter beside it belongs to whatever is
    // scrolling underneath, which is how a floating control has to behave.
    <nav className="mnav" aria-label="Sections">
      <div className="mnav__pod">
        {TABS.map((tab) => {
          const on = nav.tab === tab;
          return (
            <button
              key={tab}
              type="button"
              className={`mnav__tab${on ? ' mnav__tab--on' : ''}`}
              aria-current={on ? 'page' : undefined}
              onClick={() => {
                haptics.tap();
                // Tapping the tab you are already in pops it back to its root,
                // the way every iPhone tab bar behaves. switchTab handles it.
                nav.switchTab(tab);
              }}
            >
              <Icon tab={tab} />
              {/* ALWAYS RENDERED, hidden by CSS on the three that are not
                  active. An icon-only button still needs a name, and the name
                  a screen reader gets is then the same string a sighted user
                  reads on the pill - one source, so they can never disagree
                  the way a hand-written aria-label eventually does. */}
              <span className="mnav__label">{LABEL[tab]}</span>
            </button>
          );
        })}
      </div>
    </nav>
  );
}
