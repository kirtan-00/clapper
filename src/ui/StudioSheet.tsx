// ASKED ONCE: your name, and the production house the exports go out under.
//
// WHY THIS IS NOT PART OF SIGN-IN, which is what it looks like it should be.
// Google OAuth has no form of ours to add fields to - the flow leaves the app,
// lands on accounts.google.com and comes back. There is no "login screen" to
// put two inputs on. So the prompt is a one-time sheet on the RETURN, and it
// is triggered by STATE (signed in, never asked) rather than by the sign-in
// EVENT. That distinction is the whole design: ten people already have
// accounts and will never sign in again. An event-triggered prompt would
// never reach a single one of them.
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
import { isOnboardingDone } from './Onboarding';
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
    // Writes two blanks DELIBERATELY. `studioAsked()` keys off the value
    // existing at all, so a skip has to leave a mark - otherwise the sheet
    // returns on the next load and a skip becomes a "later" nobody asked for.
    setStudio({ name: '', studio: '' });
    props.onDone();
  }

  return (
    <Sheet title="Who's shooting?" onClose={skip}>
      <p className="camnote" style={{ marginTop: 0 }}>
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

      <button type="button" className="btn btn--go btn--full" onClick={save}>
        Save
      </button>

      <button
        type="button"
        className="btn btn--full"
        onClick={() => {
          haptics.tap();
          skip();
        }}
      >
        Not now
      </button>
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
 *   - onboarding has finished. Two one-time sheets stacked on a first launch
 *     is a wall, not a welcome.
 */
export function StudioPrompt(props: { rolling: boolean }) {
  const { session, loading } = useSession();
  const [dismissed, setDismissed] = useState(false);

  const suggested =
    (session?.user.user_metadata as Record<string, unknown> | undefined)?.full_name;

  if (loading || !session) return null;
  if (props.rolling) return null;
  if (dismissed || studioAsked()) return null;
  if (!isOnboardingDone()) return null;

  return (
    <StudioSheet
      suggestedName={typeof suggested === 'string' ? suggested : undefined}
      onDone={() => setDismissed(true)}
    />
  );
}
