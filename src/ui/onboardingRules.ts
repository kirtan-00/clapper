// WHETHER TO ASK, AND WHAT TO ASK — the first-open flow's whole decision, as
// one pure function.
//
// It lives outside the component (which is ui/Onboarding.tsx) because this is
// the part with rules in it, and rules are worth being able to state a test
// about. "Never mid-shoot" and "never twice" are promises; a promise that can
// only be checked by taking a screenshot of the right moment is a promise that
// eventually gets broken by a refactor nobody screenshotted.
//
// No imports on purpose. Everything it needs is an argument, which is what
// makes it testable and also what stops it quietly acquiring a second opinion
// about localStorage.

export type OnboardingStage = 'signin' | 'install';

export interface FirstOpen {
  /** A resolved session. Never call this while the session is still loading —
   *  a false here means "signed out", not "we do not know yet". */
  signedIn: boolean;
  /** Already running as an installed app. */
  standalone: boolean;
  /** The install ask has been answered before, including by the card this flow
   *  replaced — its key is honoured, so nobody is asked that twice. */
  installDismissed: boolean;
  /** The whole flow has been dismissed before. */
  done: boolean;
  /** A camera is rolling, or at least the rolling screen is up. */
  rolling: boolean;
}

/**
 * The stages to show, in order. An empty list means show nothing at all, which
 * is by far the most common answer and the one every uncertain case resolves
 * to: this flow's failure mode is silence.
 *
 * MID-SHOOT IS NEVER, NOT LATER. `rolling` returns an empty list rather than
 * deferring, because the alternative — a sheet that arrives the moment somebody
 * cuts — is worse than not asking at all. The next page load asks.
 */
export function pickStages(state: FirstOpen): readonly OnboardingStage[] {
  if (state.rolling) return [];
  if (state.done) return [];

  const stages: OnboardingStage[] = [];
  if (!state.signedIn) stages.push('signin');
  if (!state.standalone && !state.installDismissed) stages.push('install');
  return stages;
}
