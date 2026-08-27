// ASKED ONCE: your name, and the production house the exports go out under.
//
// TWO SURFACES NOW ASK THIS SAME QUESTION FIRST, and that is deliberate, not
// duplication: SignInSheet.tsx (the gated-action sheet) and Onboarding.tsx's
// SignInStage (first run) both carry the same two fields ABOVE their own
// Google button, because those sheets are ours - each is the last screen we
// control before the flow leaves the app for accounts.google.com and comes
// back. Google's own screen still has no form of ours to add fields to; that
// part of the old argument here was always right. What was wrong was
// concluding from it that OUR sheets could not ask first. They can, and now
// do - both through the same shared pieces, `IdentityFields` for the markup
// and `saveIdentityBeforeGoogle` for the one rule about what gets kept, so
// the two ask-first sheets cannot quietly disagree with each other either.
//
// THIS sheet - StudioSheet, gated by StudioPrompt below - is the catch for
// everyone that pre-ask misses: the ten accounts that already exist and will
// never see either sign-in sheet again, and anyone who saw one and left both
// fields blank. It is triggered by STATE (signed in, never asked) rather than
// by the sign-in EVENT, which is exactly what makes it able to reach people
// whose sign-in event happened before this feature existed, or before this
// session. `saveIdentityBeforeGoogle` writes the same key `setStudio` here
// does, so filling it in on either sign-in sheet marks `studioAsked()` true
// and this sheet correctly stays silent afterward - see studio.ts.
//
// The name is prefilled from Google because Google already gave it to us and
// retyping something the machine knows is a small insult. It is still editable
// - the name on a Google account is frequently not the name someone puts on a
// call sheet.
//
// SKIPPABLE, and a skip is remembered. Someone opening this mid-shoot to log a
// take is not going to fill in a form, and a modal they cannot dismiss between
// them and the CUT button would be the worst thing in the app.

import { useState } from 'react';
import { Sheet } from './common';
import { getStudio, setStudio, studioAsked } from './studio';
import { useSession } from '../net/auth';
import { onboardingShowing } from './Onboarding';
import * as haptics from './haptics';

export function StudioSheet(props: {
  /** Name off the Google profile, when there is one. Prefill only. */
  suggestedName?: string;
  onDone: () => void;
}) {
  const existing = getStudio();
  const [name, setName] = useState(existing.name || props.suggestedName || '');
  const [studio, setStudioName] = useState(existing.studio);

  function save() {
    haptics.tap();
    setStudio({ name, studio });
    props.onDone();
  }

  function skip() {
    // ONLY on the first ask. `studioAsked()` keys off the value existing at
    // all, so a skip has to leave a mark - otherwise the sheet returns on the
    // next load and a skip becomes a "later" nobody asked for.
    //
    // But this same sheet is REOPENED from Settings (see StudioRow), and there
    // backing out is not a skip, it is a cancel. Writing blanks
    // unconditionally erased a saved production house every time somebody
    // opened the row and tapped the scrim - silent data loss on a dismiss
    // gesture, which is the one interaction people use without looking.
    if (!studioAsked()) setStudio({ name: '', studio: '' });
    props.onDone();
  }

  return (
    <Sheet title="Who's shooting?" onClose={skip}>
      <p className="camnote studio__lede" style={{ marginTop: 0 }}>
        Your production house goes on every PDF and CSV you export. You can change
        it any time in Settings.
      </p>

      <div className="formrow">
        <label className="label" htmlFor="studio-name">
          Your name
        </label>
        <input
          id="studio-name"
          className="field"
          autoComplete="name"
          placeholder="e.g. Kirtan"
          value={name}
          onChange={(e) => setName(e.target.value)}
        />
      </div>

      <div className="formrow">
        <label className="label" htmlFor="studio-house">
          Production house
        </label>
        <input
          id="studio-house"
          className="field"
          autoComplete="organization"
          placeholder="e.g. Fourside Studio"
          value={studio}
          onChange={(e) => setStudioName(e.target.value)}
        />
      </div>

      <div className="studio__actions">
        <button type="button" className="btn btn--go btn--full" onClick={save}>
          Save
        </button>

        {/* "Not now" on the one-time ask, "Cancel" when reopened from Settings:
            same button, but backing out of a form you went looking for is a
            different act from declining one that arrived. */}
        <button
          type="button"
          className="btn btn--full"
          onClick={() => {
            haptics.tap();
            skip();
          }}
        >
          {studioAsked() ? 'Cancel' : 'Not now'}
        </button>
      </div>
    </Sheet>
  );
}

/**
 * THE GATE. Decides for itself whether it has anything to ask, the same way
 * Onboarding does, so the shell mounts it unconditionally and never has to
 * reason about it.
 *
 * Four conditions, and every uncertain case resolves to silence:
 *
 *   - the session must be RESOLVED and present. `loading` is not "signed out",
 *     and asking during it would flash a sheet at someone who is about to be
 *     recognised.
 *   - never asked on this device.
 *   - not mid-roll. Same promise Onboarding makes and for the same reason: a
 *     form between a person and the CUT button is the worst thing in the app.
 *     Mid-shoot is NEVER, not later - the next load asks.
 *   - onboarding is not presenting anything. Two one-time sheets stacked on a
 *     first launch is a wall, not a welcome. Asked as "is that flow SHOWING",
 *     never as "is it done" - see onboardingShowing() for why the done flag is
 *     permanently false for most accounts, and why gating on it would keep
 *     this sheet silent forever for exactly the people it exists to reach.
 */
export function StudioPrompt(props: { rolling: boolean }) {
  const { session, loading } = useSession();
  const [dismissed, setDismissed] = useState(false);

  const suggested =
    (session?.user.user_metadata as Record<string, unknown> | undefined)?.full_name;

  if (loading || !session) return null;
  if (props.rolling) return null;
  if (dismissed || studioAsked()) return null;
  if (onboardingShowing(true, props.rolling)) return null;

  return (
    <StudioSheet
      suggestedName={typeof suggested === 'string' ? suggested : undefined}
      onDone={() => setDismissed(true)}
    />
  );
}
