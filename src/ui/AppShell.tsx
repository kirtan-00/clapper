// The wrapper that outlives every screen. It owns the nav state, renders the
// current screen and decides whether the tab tray exists at all.
//
// UNMOUNT, DO NOT HIDE. The tray is dropped from the tree on two screens
// rather than made invisible:
//
//   rolling — `.roll` is `position: fixed; inset: 0` and CUT is `sticky;
//     bottom: 0` under a written contract that CUT is never allowed off
//     screen. A tray element that is merely hidden still takes part in
//     layout and eats the vertical budget CUT is fighting for, which has
//     already caused real bugs on that screen.
//   the guide — `.guide` is the same full-window shape, and it is
//     documentation you read standing up: it gets the whole viewport.
//
// The guide is opened deep inside ProjectsScreen, so instead of threading a
// prop up four levels it CLAIMS the screen while it is mounted (see
// useFullScreenClaim below). Any future full-window overlay does the same and
// the tray gets out of the way for free.

import { useEffect, useSyncExternalStore, type ReactNode } from 'react';
import { useNavState, type Nav, type Route } from './nav';
import { TabTray } from './TabTray';
import { Onboarding } from './Onboarding';
import { RollRecovery } from './RollRecovery';
import { trackScreenView } from '../net/analytics';

// ------------------------------------------------- full-screen claims -----

let claims = 0;
const listeners = new Set<() => void>();

function emit(): void {
  for (const fn of listeners) fn();
}
function subscribe(fn: () => void): () => void {
  listeners.add(fn);
  return () => listeners.delete(fn);
}
function claimed(): boolean {
  return claims > 0;
}

/**
 * Call from any component that takes the whole window. While it is mounted the
 * tab tray is unmounted. The cleanup always decrements, so StrictMode's double
 * invoke stays balanced.
 */
export function useFullScreenClaim(): void {
  useEffect(() => {
    claims += 1;
    emit();
    return () => {
      claims -= 1;
      emit();
    };
  }, []);
}

function useFullScreenClaimed(): boolean {
  return useSyncExternalStore(subscribe, claimed, () => false);
}

// ------------------------------------------------------------- shell -----

export function AppShell(props: { render: (route: Route, nav: Nav) => ReactNode }) {
  const { route, nav } = useNavState();
  const overlay = useFullScreenClaimed();
  const tray = route.name !== 'rolling' && !overlay;

  // ONE `screen_view` per distinct screen NAME, not per route object — keyed
  // that way on purpose. `nav.replace` swaps a route's payload without
  // changing its name (editing the project you're already looking at,
  // stepping to the next shot on the rolling screen); neither is a
  // navigation and neither should count as a second view of the same screen.
  // See src/net/analytics.ts for what this also feeds: a later `session_end`
  // reports whatever screen was recorded here last.
  useEffect(() => {
    trackScreenView(route.name);
  }, [route.name]);

  return (
    // --tray-lift rides on this class, so anything floating inside (the toast)
    // knows whether there is a tray to clear.
    <div className={`shell${tray ? ' shell--tray' : ''}`}>
      {props.render(route, nav)}
      {tray && <TabTray nav={nav} />}
      {/* FIRST OPEN, ASKED ONCE. It lives here rather than on Home because it
          is about the app and not about a screen, and because here it is
          mounted exactly once for the life of the page — the card it replaces
          was mounted on two tabs and counted one appearance three times.
          It decides for itself whether it has anything to ask; the only thing
          it cannot know is the route, and mid-roll it must not appear at all. */}
      <Onboarding rolling={route.name === 'rolling'} />
      {/* Crash recovery for an in-flight take (see RollRecovery.tsx and
          src/engine/rollCheckpoint.ts). Mounted once, at the shell, same
          reasoning as Onboarding above — cold launch always lands on Home,
          never on the rolling screen directly, so a killed-tab recovery
          prompt cannot live inside RollingScreen itself. It renders nothing
          when there is no checkpoint to offer back. */}
      <RollRecovery nav={nav} />
    </div>
  );
}
