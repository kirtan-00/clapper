// THE TOUR'S OWN RULES — pure, no imports, same shape as onboardingRules.ts
// and for the same reason: everything this file needs is an argument, which
// is what makes "never mid-shoot" and "never past the last step" testable
// without a DOM, a store or localStorage.

import type { TourAdvanceMode } from './tourSteps';

/** Does a real tap on the target advance this step, or does it wait for the
 *  Next button? Trivial, but named so a call site reads as an assertion
 *  ("does this step advance on action") rather than a raw string compare. */
export function advancesOnAction(advance: TourAdvanceMode): boolean {
  return advance === 'on-action';
}

/** The step after `current`, or null once `current` was the last one — null
 *  is "the tour is finished", not an error. */
export function nextStepIndex(current: number, total: number): number | null {
  const next = current + 1;
  return next >= 0 && next < total ? next : null;
}

/** A saved step index, made safe to render — clamped into range and never
 *  negative, so a corrupt or stale `clapper.tourStep` degrades to "step
 *  zero" instead of an out-of-bounds read. */
export function clampStepIndex(index: number, total: number): number {
  if (total <= 0) return 0;
  if (!Number.isFinite(index)) return 0;
  return Math.min(Math.max(Math.trunc(index), 0), total - 1);
}

/**
 * NEVER MID-SHOOT. The same promise onboarding makes, spent here too: a
 * request to START the tour is refused outright while the rolling screen is
 * up, exactly like `pickStages` refuses to open onboarding there (see
 * onboardingRules.ts). It is not deferred — a tour sheet arriving the moment
 * somebody calls action is worse than one that never arrives.
 *
 * Reachability already keeps this rare (the tab tray, and Settings' "Take
 * the tour" row with it, is unmounted while `route.name === 'rolling'` — see
 * AppShell.tsx's `tray` calc) — this is the second lock on the same door, for
 * the auto-offer and for any future entry point that does not go through the
 * tray at all.
 */
export function canStartTour(rolling: boolean): boolean {
  return !rolling;
}

export interface TourOfferState {
  /** TourController.tsx's TOUR_AUTOSTART constant, passed in rather than
   *  imported — this function stays pure and testable either way it's set. */
  autostart: boolean;
  /** The tour has already been finished or explicitly skipped once. */
  tourDone: boolean;
  /** The first-open flow (Onboarding.tsx) has settled — asked or not — so
   *  the tour offer never stacks a second sheet on top of it. Mirrors
   *  `onboardingShowing`'s own reasoning: two prompts is worse than a person
   *  who never sees either. */
  onboardingDone: boolean;
  /** Never while a real shoot is up. */
  rolling: boolean;
  /** How many takes already live on this phone. null = not read yet (be
   *  conservative and say no); this is "after the user has seen the app",
   *  never before — a person who has not logged a single take has not seen
   *  enough of the app for a tour offer to be anything but noise. */
  takeCount: number | null;
}

/** Whether to surface the first-time, non-blocking "want a 2-minute tour?"
 *  offer right now. Gated behind TOUR_AUTOSTART for the whole first release —
 *  see that constant's own comment in TourController.tsx — so this function
 *  can ship exercised by tests while the feature itself stays dark. */
export function shouldOfferTour(state: TourOfferState): boolean {
  if (!state.autostart) return false;
  if (state.rolling) return false;
  if (state.tourDone) return false;
  if (!state.onboardingDone) return false;
  if (state.takeCount === null) return false;
  return state.takeCount >= 1;
}
