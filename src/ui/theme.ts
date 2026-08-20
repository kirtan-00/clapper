// The clear theme, and the night switch.
//
// Light is the DEFAULT. A phone at midday holds about 1,000 nits against
// roughly 10,000 lux of sunlight, and a dark UI in that light stops being a
// screen and becomes a mirror of the person holding it. Night exists for the
// 5am call time and nothing else.
//
// A manual toggle rather than `prefers-color-scheme`, deliberately: the OS
// switches on a clock, and a 2pm interior and a 2pm exterior want opposite
// things. There is no system-preference listener here and there should not be.
//
// First paint is NOT this module's job. index.html carries an inline script
// that reads the same key and stamps the same attribute before the bundle
// loads, because applying the theme in React means a white flash into night
// mode at 4am. This module owns everything after that: reading, writing, and
// keeping React in sync.

export type Theme = 'light' | 'night';

export const THEME_KEY = 'clapper.theme';

/** Ground colour per theme: --paper in src/styles.css. Also in index.html. */
const THEME_COLOR: Record<Theme, string> = {
  light: '#fbfaf7',
  night: '#000000',   // night is TRUE black now; #0c0d10 was the old charcoal
};

// Storage throws outright in Safari private mode and with cookies blocked. A
// theme preference is never worth taking the app down for, so every access is
// guarded and every failure resolves to the default.
function read(): Theme {
  try {
    return localStorage.getItem(THEME_KEY) === 'night' ? 'night' : 'light';
  } catch {
    return 'light';
  }
}

function write(theme: Theme): void {
  try {
    localStorage.setItem(THEME_KEY, theme);
  } catch {
    /* the toggle still works for this session, it just will not survive it */
  }
}

/**
 * Stamp the theme onto the document. Light is the absence of the attribute, so
 * `:root` alone styles it and there is one less selector in the way.
 */
function paint(theme: Theme): void {
  const root = document.documentElement;
  if (theme === 'night') root.setAttribute('data-theme', 'night');
  else root.removeAttribute('data-theme');

  // Without this the iOS status bar and the PWA splash keep the other theme's
  // colour, which reads as a rendering bug rather than a setting.
  const meta = document.querySelector('meta[name="theme-color"]');
  if (meta) meta.setAttribute('content', THEME_COLOR[theme]);
}

// --------------------------------------------------------- subscription ----
// A tiny store rather than context: the toggle can be mounted anywhere, by any
// screen, without a provider having to be threaded above it first.

let current: Theme = read();
const listeners = new Set<() => void>();

export function getTheme(): Theme {
  return current;
}

export function subscribe(fn: () => void): () => void {
  listeners.add(fn);
  return () => {
    listeners.delete(fn);
  };
}

export function setTheme(theme: Theme): void {
  if (theme === current) return;
  current = theme;
  write(theme);
  paint(theme);
  for (const fn of listeners) fn();
}

export function toggleTheme(): Theme {
  const next: Theme = current === 'night' ? 'light' : 'night';
  setTheme(next);
  return next;
}

/**
 * Re-assert what storage says onto the document. The inline script has already
 * done this on a cold start; this only matters when the module loads into a
 * document that never ran it (a test, an embedded harness, a hot reload).
 */
export function syncTheme(): void {
  current = read();
  paint(current);
}
