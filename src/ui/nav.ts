// Navigation state for the app shell.
//
// Before this, App.tsx was a `switch` over one flat `Screen` union: every
// screen swap replaced the whole tree, so nothing survived a navigation and
// there was nowhere to hang a persistent tab tray.
//
// The shape now is FOUR STACKS, one per tab, plus which tab is on top. A push
// lands on the current tab's stack, so opening a project, its shot list and
// its clip log all happen INSIDE the Projects tab and the tray stays up.
// Switching tabs leaves the other stacks exactly where you left them, so
// coming back to Projects comes back to the screen you were on, not to the
// list. (Route stacks persist; component state and scroll position do not —
// the other tab's screens are unmounted while you are away.)

import { useCallback, useMemo, useState } from 'react';
import type { Project, Shot, Slate } from '../types';

export type Tab = 'home' | 'projects' | 'settings' | 'account';

/** Tab order, left to right in the tray. */
export const TABS: readonly Tab[] = ['home', 'projects', 'settings', 'account'];

/**
 * One screen. The first four are tab roots and only ever sit at the bottom of
 * their own stack; the rest are pushed on top of one.
 */
export type Route =
  | { name: 'home' }
  | { name: 'projects' }
  | { name: 'settings' }
  | { name: 'account' }
  | { name: 'project'; project: Project }
  // The shot list for one scene. Only reachable for scenes that HAVE shots —
  // a hand-made scene goes straight from the project screen to rolling, as it
  // always has.
  | { name: 'shots'; project: Project; slate: Slate }
  // Every clip the project has rolled, flat and newest-first. Project-wide by
  // nature (you look a clip up by name, not by remembering its scene). It is
  // reachable from the project screen AND from the rolling screen — it is the
  // fix-a-mistake path, so it has to be close to where the mistake is noticed.
  // Backing out of it lands where you came from for free now: the stack
  // remembers, so the old `from` field is gone.
  | { name: 'cliplog'; project: Project }
  // `shot` is absent when the scene has no breakdown: takes then log against
  // the scene itself, exactly as before shots existed.
  | { name: 'rolling'; project: Project; slate: Slate; shot?: Shot };

/** The root route of each tab. */
const ROOT: Record<Tab, Route> = {
  home: { name: 'home' },
  projects: { name: 'projects' },
  settings: { name: 'settings' },
  account: { name: 'account' },
};

/**
 * The navigation API. Every screen that needs to move gets this — either as a
 * `nav` prop (Home, Settings, Account) or as narrow callbacks App.tsx builds
 * out of it (the Projects stack, which predates the shell and keeps its own
 * `onBack` / `onOpen` prop shapes).
 */
export interface Nav {
  /** Which tab is on top right now. */
  readonly tab: Tab;
  /** Routes on the current tab's stack. 1 means you are at its root. */
  readonly depth: number;
  /** Push a screen onto the CURRENT tab's stack. */
  push(route: Route): void;
  /** Swap the top screen without growing the stack (rename, next shot). */
  replace(route: Route): void;
  /** Back one screen. A no-op at a tab root — a tab root is never popped. */
  pop(): void;
  /**
   * Pop until the top screen has this name. A no-op if no screen on the stack
   * has it, so it can never empty a stack. Used to go sideways: leaving one
   * scene for another pops back to the project screen before pushing the new
   * one, so BACK still means "the scene list", not "the scene I was in".
   */
  popTo(name: Route['name']): void;
  /**
   * Show another tab. Its stack is where you left it; `reset` sends it back to
   * its root instead (which is also what tapping the tab you are already on
   * does, the iPhone convention).
   */
  switchTab(tab: Tab, opts?: { reset?: boolean }): void;
}

interface NavState {
  tab: Tab;
  stacks: Record<Tab, Route[]>;
}

/**
 * Cold open lands on Projects, not Home. Home is the gateway the spec wants and
 * it is a stub in this phase; opening the app onto "not built yet" would break
 * the one flow that has to survive a refactor — open, tap a project, roll.
 * The agent who builds Home flips this to 'home'.
 */
const INITIAL_TAB: Tab = 'projects';

function initialState(): NavState {
  return {
    tab: INITIAL_TAB,
    stacks: {
      home: [ROOT.home],
      projects: [ROOT.projects],
      settings: [ROOT.settings],
      account: [ROOT.account],
    },
  };
}

/**
 * Owns the nav state and hands back the current route plus the `Nav` API.
 * Called once, by AppShell.
 */
export function useNavState(): { route: Route; nav: Nav } {
  const [state, setState] = useState<NavState>(initialState);

  // Every mutation is an updater, so two of them in one handler compose
  // correctly (popTo followed by push, in ProjectScreen's scene-to-scene move).
  const edit = useCallback((fn: (stack: Route[]) => Route[]) => {
    setState((prev) => {
      const next = fn(prev.stacks[prev.tab]);
      if (next.length === 0 || next === prev.stacks[prev.tab]) return prev;
      return { ...prev, stacks: { ...prev.stacks, [prev.tab]: next } };
    });
  }, []);

  const stack = state.stacks[state.tab];
  const route = stack[stack.length - 1];

  const nav = useMemo<Nav>(
    () => ({
      tab: state.tab,
      depth: stack.length,
      push: (r) => edit((s) => [...s, r]),
      replace: (r) => edit((s) => [...s.slice(0, -1), r]),
      pop: () => edit((s) => (s.length > 1 ? s.slice(0, -1) : s)),
      popTo: (name) => {
        edit((s) => {
          const i = s.map((r) => r.name).lastIndexOf(name);
          return i === -1 ? s : s.slice(0, i + 1);
        });
      },
      switchTab: (tab, opts) =>
        setState((prev) => ({
          tab,
          stacks:
            opts?.reset || (prev.tab === tab && prev.stacks[tab].length > 1)
              ? { ...prev.stacks, [tab]: [ROOT[tab]] }
              : prev.stacks,
        })),
    }),
    [state.tab, stack.length, edit],
  );

  return { route, nav };
}

/** A scene with a breakdown opens its shot list; a bare scene opens rolling. */
export function enterSlate(project: Project, slate: Slate): Route {
  return slate.shots?.length
    ? { name: 'shots', project, slate }
    : { name: 'rolling', project, slate };
}
