// FIRST OPEN — it ASKS, and it never locks.
//
// Two stages, in the app's own words:
//
//   1 SIGN IN            what an account buys: the shot log stops living only
//                        on this phone.
//   2 ADD TO HOME SCREEN platform-correct, and then it is done with you.
//
// ------------------------------------------------------------------------
// ASK, DO NOT LOCK. This is the whole design, and it is not a preference.
// ------------------------------------------------------------------------
//
// Every stage is escapable and the way past is a button in the footer, in the
// same place on both stages, visible without scrolling and without hunting.
// Two facts make that non-negotiable rather than polite:
//
//   THE CONSENT SCREEN. Clapper's Google OAuth app's publishing status is not
//   confirmed. While a Google app is in Testing only manually allowlisted
//   accounts can complete sign-in AT ALL — so a hard gate here would not be a
//   strict onboarding, it would be a locked door in front of every real
//   visitor of a live product, and we would find out from the traffic graph.
//
//   THE PRODUCT IS TRUE WITHOUT AN ACCOUNT. Logging takes, the PDF shot log,
//   backup and restore all work offline and signed out today. A wall in front
//   of that is a lie about the app, told at the worst possible moment.
//
// So: skip on stage 1, skip on stage 2, the scrim dismisses, and once it is
// dismissed it does not come back. Best-effort throughout — any failure in
// here degrades to "the flow does not show", never to a broken app.
//
// ------------------------------------------------------------------------
// IT LATCHES ONCE. IT IS NOT REACTIVE.
// ------------------------------------------------------------------------
//
// The decision to show is taken exactly once per page load, the first time the
// session resolves, and is never re-taken. A reactive version reads better in a
// diff and is wrong in practice: signing OUT on the Account tab six weeks from
// now would pop a first-open flow over somebody who has been using the app
// daily, which is the definition of a nag. Same reason the ROLLING screen is
// checked at latch time and not after — "never mid-shoot" means never, not
// "later, once you have cut".
//
// SIGNING IN IS THE ONE EXIT THAT DOES NOT MARK IT DONE. `signInWithGoogle`
// navigates the document away, so the return from Google is a fresh page load
// with a fresh latch: stage 1's condition is false now, and the flow reopens on
// stage 2, which is the only correct continuation. Writing the key before the
// redirect would silently cost that person the install ask — and if the consent
// screen is still in Testing and the sign-in fails, they would have been marked
// as asked for a thing they were never able to do.
//
// ------------------------------------------------------------------------
// WHERE THE OLD CARD WENT
// ------------------------------------------------------------------------
//
// InstallNudge was a dismissible card on Home and Projects that asked these
// same two questions — install, and sign in. It is deleted. Shipping both
// would have asked one person twice about one thing, once in a sheet and once
// in a card, with two separate dismissals to find. What was worth keeping from
// it is kept: its platform detection now lives in ./install.ts (moved, not
// copied), its dismissal key is still honoured so nobody who already said no
// to installing gets asked again, and the sentence that made it work — the
// REAL take count, never a rounded one and never an invented zero — is stage
// one's headline here.
//
// It also carried a bug: `install_nudge … action:'shown'` re-fired on every
// remount, and the card was mounted on two tabs, so walking Home → Projects →
// Home logged three impressions of one card (six under StrictMode's double
// effects, which main.tsx runs in dev). Deleting the card ends that, and the
// guard below means the replacement cannot inherit it: a stage counts as shown
// once per page load, tracked at module scope where a remount cannot reach.

import { useEffect, useRef, useState } from 'react';
import { Sheet, useSheetDismiss } from './common';
import { StageRail, StagePanel, StageActions, type StageDir } from './stages';
import { pickStages, type OnboardingStage } from './onboardingRules';
import { useSession, signInWithGoogle } from '../net/auth';
import { track } from '../net/analytics';
import { store } from '../store';
import * as haptics from './haptics';
import {
  isStandalone,
  isIosSafari,
  isInstallDismissed,
  markInstallDismissed,
  useCanPromptInstall,
  promptInstall,
} from './install';

/** Once-ever dismissal of the whole flow. Next to the other `clapper.*` keys. */
export const ONBOARDING_KEY = 'clapper.onboardingDone';

type Stage = OnboardingStage;

/** Why the sheet is closing. Only ever read for the analytics line. */
type Reason = 'skip' | 'done' | 'dismiss';

const STAGE_TITLE: Record<Stage, string> = {
  signin: 'Keep the log',
  install: 'Add to Home Screen',
};

function isDone(): boolean {
  try {
    return localStorage.getItem(ONBOARDING_KEY) === '1';
  } catch {
    return false;
  }
}

function markDone(): void {
  try {
    localStorage.setItem(ONBOARDING_KEY, '1');
  } catch {
    /* private mode / storage blocked: it may ask once more next load */
  }
}

/**
 * Impressions, once per stage per page load. At module scope on purpose — a
 * component-local ref resets on remount, which is exactly how the card this
 * replaces ended up counting one appearance three times.
 */
const shown = new Set<Stage>();

function trackShown(stage: Stage): void {
  if (shown.has(stage)) return;
  shown.add(stage);
  track('onboarding', { stage, action: 'shown' });
}

/**
 * How many takes are on this phone. Walks projects -> scenes -> takes, which is
 * the only path the store offers for a whole-device count, and does it exactly
 * once per appearance. Returns null rather than 0 on failure: zero is a claim,
 * and "no number" is the truth when the read did not happen.
 */
async function countTakes(): Promise<number | null> {
  try {
    const projects = await store.listProjects();
    const perProject = await Promise.all(
      projects.map(async (p) => {
        const slates = await store.listSlates(p.id);
        const perSlate = await Promise.all(slates.map((sl) => store.listTakes(sl.id)));
        return perSlate.reduce((n, list) => n + list.length, 0);
      }),
    );
    return perProject.reduce((n, c) => n + c, 0);
  } catch {
    return null;
  }
}

/** Tiny inline share-icon (box + up arrow) — avoids relying on a Unicode glyph. */
function ShareGlyph() {
  return (
    <svg
      className="ob-glyph"
      width="15"
      height="15"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      <path d="M12 3v12" />
      <path d="M7.5 7.5 12 3l4.5 4.5" />
      <rect x="4" y="11" width="16" height="10" rx="2" />
    </svg>
  );
}

// ------------------------------------------------------- the dev seam ------

/**
 * A seam for screenshots, so the iOS wording and the Chromium wording can both
 * be LOOKED AT on a machine that is neither. DEV ONLY — `import.meta.env.DEV`
 * is a compile-time constant, so this is dropped from the shipped bundle and
 * the real flow still reads the real browser. Same convention as
 * `__clapperSyncFace` in common.tsx.
 */
type Face = 'prompt' | 'ios' | 'menu';
let devFace: Face | null = null;
const devListeners = new Set<() => void>();

if (import.meta.env.DEV && typeof window !== 'undefined') {
  (window as unknown as Record<string, unknown>).__clapperOnboardingFace = (f: Face | null) => {
    devFace = f;
    for (const fn of devListeners) fn();
  };
}

function useDevFace(): Face | null {
  const [, bump] = useState(0);
  useEffect(() => {
    if (!import.meta.env.DEV) return;
    const fn = () => bump((n) => n + 1);
    devListeners.add(fn);
    return () => {
      devListeners.delete(fn);
    };
  }, []);
  return devFace;
}

// ------------------------------------------------------------ the gate -----

/**
 * Mounted once, by AppShell. Decides whether there is anything to ask, and gets
 * out of the way when there is not.
 *
 * `rolling` is passed in rather than read here because only the shell knows the
 * route, and this component must never be the thing that reaches into nav.
 */
export function Onboarding(props: { rolling: boolean }) {
  const { session, loading } = useSession();
  // The route at the moment the latch fires, read through a ref so that a later
  // navigation cannot re-run the effect and re-open a settled decision.
  const rollingRef = useRef(props.rolling);
  rollingRef.current = props.rolling;

  const [stages, setStages] = useState<readonly Stage[] | null>(null);
  const latched = useRef(false);

  useEffect(() => {
    if (latched.current || loading) return;
    latched.current = true;
    try {
      // Every rule is in ./onboardingRules.ts, which is pure and has tests
      // against exactly the two promises that matter: never mid-shoot, and
      // never a second time. All this does is read the world for it.
      const list = pickStages({
        signedIn: session !== null,
        standalone: isStandalone(),
        installDismissed: isInstallDismissed(),
        done: isDone(),
        rolling: rollingRef.current,
      });
      if (list.length === 0) return;
      setStages(list);
    } catch {
      /* first-open chrome is best-effort; never block the app */
    }
  }, [loading, session]);

  if (!stages) return null;
  return <OnboardingFlow stages={stages} />;
}

// ------------------------------------------------------------ the flow -----

function OnboardingFlow(props: { stages: readonly Stage[] }) {
  const { stages } = props;
  const [index, setIndex] = useState(0);
  const [dir, setDir] = useState<StageDir>('fwd');
  const [closed, setClosed] = useState(false);
  const [takes, setTakes] = useState<number | null>(null);

  const stage = stages[index];
  const last = index === stages.length - 1;

  /**
   * EVERY CLOSE GOES THROUGH THE SHEET, so it slides out instead of blinking
   * off. `<Sheet>`'s dismiss is the only thing that knows how to do that, and
   * it takes no argument — so the leaving button states its reason here first
   * and the sheet's `onClose` reads it on the way out. The default is 'dismiss'
   * because that is the one exit no button owns: a tap on the scrim.
   */
  const reason = useRef<Reason>('dismiss');

  useEffect(() => {
    trackShown(stage);
  }, [stage]);

  // Counted only once the flow has decided it is appearing, so the common path
  // (dismissed, installed, signed in) costs nothing at all.
  useEffect(() => {
    let alive = true;
    void countTakes().then((n) => {
      if (alive) setTakes(n);
    });
    return () => {
      alive = false;
    };
  }, []);

  /** The end of the road, whichever button got here. Dismissed is dismissed:
   *  the keys are written as the sheet unmounts, so a reload a second later
   *  cannot resurrect it. */
  function finish(): void {
    track('onboarding', { stage, action: reason.current });
    markDone();
    // Reaching the end past the install ask is an answer to the install ask
    // too, so the old key goes down with it and nothing else in the app can
    // re-open that question.
    if (stages.includes('install')) markInstallDismissed();
    setClosed(true);
  }

  /** Forward one stage. Only ever called when there IS one. */
  function advance(action: Reason): void {
    haptics.tap();
    track('onboarding', { stage, action });
    setDir('fwd');
    setIndex(index + 1);
  }

  if (closed) return null;

  return (
    <Sheet title={STAGE_TITLE[stage]} onClose={finish}>
      {/* The rail, the panel and the sticky footer are the shared stage chrome
          (ui/stages.tsx, styled with the .sl-* rules the shotlist flow already
          uses). `.ob` is only the five rules these two stages add. */}
      <div className="ob">
        {/* One stage is a stage, not a sequence. "1 of 1" is a progress bar
            reporting on nothing, so it does not render. */}
        {stages.length > 1 && (
          <StageRail index={index} total={stages.length} title={STAGE_TITLE[stage]} />
        )}

        <StagePanel dir={dir} key={stage}>
          {stage === 'signin' ? (
            <SignInStage
              takes={takes}
              last={last}
              onAdvance={() => advance('skip')}
              setReason={(r) => {
                reason.current = r;
              }}
            />
          ) : (
            <InstallStage
              setReason={(r) => {
                reason.current = r;
              }}
            />
          )}
        </StagePanel>
      </div>
    </Sheet>
  );
}

// ================================================================ one ======
// SIGN IN. The pitch is the shot log, not the feature list.

function SignInStage(props: {
  takes: number | null;
  last: boolean;
  onAdvance: () => void;
  setReason: (r: Reason) => void;
}) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // Inside a <Sheet>, so this is the sheet's own animated dismiss. The fallback
  // is unreachable in practice and is a no-op rather than a second close path
  // that could disagree with the first.
  const dismiss = useSheetDismiss(() => {});

  /**
   * COPY THE ASYMMETRY, DO NOT FIX IT. `signInWithGoogle()` REDIRECTS the
   * document to Google, so on the happy path nothing after the await ever
   * runs and `busy` is never cleared — the page is gone. It is cleared only in
   * the catch, which is the branch where the redirect never started and the
   * button therefore has to become pressable again. Same shape as
   * SignInSheet.tsx, deliberately.
   */
  async function onSignIn() {
    setBusy(true);
    setError(null);
    track('onboarding', { stage: 'signin', action: 'signin_start' });
    try {
      await signInWithGoogle();
      // On success the browser redirects to Google; nothing else runs here.
      // In particular NOTHING marks the flow done — see the file header.
    } catch {
      setError('Could not start sign-in. Check your connection and try again.');
      setBusy(false);
    }
  }

  /** Past this stage. Onto the install ask if there is one, out if there isn't;
   *  skipping the account is never a reason to lose the second question. */
  function skip() {
    if (props.last) {
      props.setReason('skip');
      haptics.tap();
      dismiss();
      return;
    }
    props.onAdvance();
  }

  return (
    <>
      {/* The FACT, with the real number in it where there is one. A brand new
          phone has no takes on it yet, and "0 takes live in this browser" is a
          scare quote about nothing — so the general sentence carries that case,
          and the count only speaks when it has something to say. */}
      <p className="ob-say">
        {props.takes !== null && props.takes > 0
          ? `${props.takes} ${props.takes === 1 ? 'take lives' : 'takes live'} in this browser and nowhere else.`
          : 'Everything you log lives in this browser and nowhere else.'}
      </p>
      <p className="camnote ob-note">
        An account backs the shot log up off the phone, so a cleared browser or a
        lost handset is not a lost shoot. It also opens shotlist import and the
        Premiere and CSV exports.
      </p>
      <p className="camnote ob-note">
        Logging takes, the PDF shot log, backup and restore all stay free without
        one — and you can do this later from the Account tab.
      </p>

      {/* `--bad` was never defined anywhere, so an error line styled with it
          renders its raw-hex fallback: a colour outside the palette. --rec-text
          IS the house error register and covers both grounds. */}
      {error && (
        <p className="camnote ob-note" role="alert" style={{ color: 'var(--rec-text)' }}>
          {error}
        </p>
      )}

      <p className="camnote ob-fine">
        By signing in you agree to our{' '}
        <a href="/legal/#terms" target="_blank" rel="noopener">Terms</a> and{' '}
        <a href="/legal/#privacy" target="_blank" rel="noopener">Privacy Policy</a>. We only
        receive your email; your projects stay on your device.
      </p>

      <StageActions>
        {/* THE WAY PAST, in the footer, on both stages, in the same place, with
            a real word on it. A flow you have to work out how to leave is a
            wall with a secret door in it. */}
        <button type="button" className="btn btn--ghost" onClick={skip}>
          Not now
        </button>
        <button
          type="button"
          className="btn btn--go"
          disabled={busy}
          onClick={() => void onSignIn()}
        >
          {busy ? 'Opening Google…' : 'Sign in with Google'}
        </button>
      </StageActions>
    </>
  );
}

// ================================================================ two ======
// ADD TO HOME SCREEN. Three faces, and the browser picks which one is true.

function InstallStage(props: { setReason: (r: Reason) => void }) {
  const canPrompt = useCanPromptInstall();
  const override = useDevFace();
  const dismiss = useSheetDismiss(() => {});

  // 'prompt' — Chromium has handed us its own install prompt, so the button IS
  //            the install and there is nothing to describe.
  // 'ios'    — Safari on iOS/iPadOS: the Share sheet is the only route, and
  //            there is no programmatic install to offer.
  // 'menu'   — everything else, including iOS Chrome and a Chromium that has
  //            not (yet) said we qualify. The browser menu is the honest
  //            instruction; it is where every one of them puts this.
  const face: Face = override ?? (canPrompt ? 'prompt' : isIosSafari() ? 'ios' : 'menu');

  function leave(reason: Reason): void {
    props.setReason(reason);
    haptics.tap();
    dismiss();
  }

  async function onInstall() {
    haptics.tap();
    const outcome = await promptInstall();
    track('onboarding', {
      stage: 'install',
      action:
        outcome === 'accepted'
          ? 'install_accepted'
          : outcome === 'dismissed'
            ? 'install_declined'
            : 'install_unavailable',
    });
    props.setReason('done');
    dismiss();
  }

  return (
    <>
      <p className="ob-say">Installed, Clapper is exempt from the browser&rsquo;s spring clean.</p>
      <p className="camnote ob-note">
        A browser under storage pressure can clear a site&rsquo;s data after about a
        week unused, and iOS is the strictest about it. On the home screen
        Clapper is exempt from that, and it opens full screen with no address
        bar eating the top of the slate.
      </p>

      {face === 'ios' && (
        <ol className="ob-steps">
          <li>
            Tap <ShareGlyph /> <b>Share</b> in Safari&rsquo;s toolbar.
          </li>
          <li>
            Scroll down and choose <b>Add to Home Screen</b>.
          </li>
          <li>
            Tap <b>Add</b>. Clapper lands on the home screen like any other app.
          </li>
        </ol>
      )}

      {face === 'menu' && (
        <ol className="ob-steps">
          <li>
            Open the browser menu — the <b>⋮</b> or <b>⋯</b> button.
          </li>
          <li>
            Choose <b>Add to Home screen</b>; some browsers call it{' '}
            <b>Install app</b>.
          </li>
          <li>Confirm, and Clapper lands on the home screen.</li>
        </ol>
      )}

      {face === 'prompt' && (
        <p className="camnote ob-note">
          This browser can do it itself — one tap and one confirmation, and it is
          on the home screen.
        </p>
      )}

      <StageActions>
        <button type="button" className="btn btn--ghost" onClick={() => leave('skip')}>
          Not now
        </button>
        {face === 'prompt' ? (
          <button type="button" className="btn btn--go" onClick={() => void onInstall()}>
            Add to Home Screen
          </button>
        ) : (
          // The instruction is NOT a button. There is no programmatic install on
          // this face, and dressing the steps as a control would be a control
          // that does nothing when pressed. So the only action left is saying
          // you have read them.
          <button type="button" className="btn btn--go" onClick={() => leave('done')}>
            Got it
          </button>
        )}
      </StageActions>
    </>
  );
}
