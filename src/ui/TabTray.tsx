// The bottom tab tray. Four cells, always there, except where it is not:
// see AppShell for the two screens that unmount it outright.
//
// Icons are hand-drawn inline SVG. This is an offline PWA — no icon font, no
// CDN, no library — and the marks are the app's own vocabulary rather than a
// generic set: HOME is the clapper stick from the masthead, PROJECTS is a
// stack of slates, SETTINGS is a pair of faders (not a gear, which is what
// every other app reaches for), ACCOUNT is a plain head and shoulders.

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
  strokeWidth: 1.6,
  strokeLinecap: 'round' as const,
  strokeLinejoin: 'round' as const,
};

function Icon(props: { tab: Tab }) {
  const common = {
    className: 'tabtray__icon',
    viewBox: '0 0 22 22',
    'aria-hidden': true,
    focusable: 'false' as const,
  };
  switch (props.tab) {
    // The clapper stick, closed: the app's own mark.
    case 'home':
      return (
        <svg {...common}>
          <rect x="2.5" y="8.5" width="17" height="10.5" rx="2" {...STROKE} />
          <path d="M3.6 8.5 6.9 3.6M8.9 8.5l3.3-4.9M14.2 8.5l3.3-4.9" {...STROKE} />
          <path d="M2.9 3.9 18.4 2.6l.5 5.9H3.1z" {...STROKE} />
        </svg>
      );
    // A stack of slates, front one squared up.
    case 'projects':
      return (
        <svg {...common}>
          <rect x="3" y="7.5" width="16" height="11.5" rx="2" {...STROKE} />
          <path d="M5.4 4.8h11.2M7.2 2.6h7.6" {...STROKE} />
          <path d="M7.2 12h7.6M7.2 15.4h4.6" {...STROKE} />
        </svg>
      );
    // Two faders. A sound desk, not a gear.
    case 'settings':
      return (
        <svg {...common}>
          <path d="M3 7.2h16M3 14.8h16" {...STROKE} />
          <circle cx="8" cy="7.2" r="2.5" {...STROKE} />
          <circle cx="14.4" cy="14.8" r="2.5" {...STROKE} />
        </svg>
      );
    case 'account':
      return (
        <svg {...common}>
          <circle cx="11" cy="7.6" r="3.6" {...STROKE} />
          <path d="M3.9 19a7.1 7.1 0 0 1 14.2 0" {...STROKE} />
        </svg>
      );
  }
}

export function TabTray(props: { nav: Nav }) {
  const { nav } = props;
  return (
    <nav className="tabtray" aria-label="Sections">
      {TABS.map((tab) => {
        const on = nav.tab === tab;
        return (
          <button
            key={tab}
            type="button"
            className={`tabtray__tab${on ? ' tabtray__tab--on' : ''}`}
            aria-current={on ? 'page' : undefined}
            onClick={() => {
              haptics.tap();
              // Tapping the tab you are already in pops it back to its root,
              // the way every iPhone tab bar behaves. switchTab handles it.
              nav.switchTab(tab);
            }}
          >
            <Icon tab={tab} />
            <span className="tabtray__label">{LABEL[tab]}</span>
          </button>
        );
      })}
    </nav>
  );
}
