import { useState } from 'react';
import { Sheet } from './common';
import { signInWithGoogle } from '../net/auth';
import { getStudio, setStudio } from './studio';

/**
 * Sign-in sheet shown when an anonymous user reaches a gated action (shotlist import
 * or Premiere/CSV export). Google is the only provider. On success the OAuth flow
 * navigates away and returns to the app; the caller re-checks the session on return.
 *
 * Carries the name/production-house fields ABOVE the button (see StudioSheet.tsx for
 * why those questions exist and why StudioPrompt still exists alongside this). Same
 * markup and classes as StudioSheet on purpose, so the two surfaces read as one form
 * split across two moments rather than two different forms.
 */
export function SignInSheet(props: { onClose: () => void }) {
  const existing = getStudio();
  const [name, setName] = useState(existing.name);
  const [studioName, setStudioName] = useState(existing.studio);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function onSignIn() {
    setBusy(true);
    setError(null);
    // BEFORE signInWithGoogle, not after: the OAuth flow navigates the tab away
    // to accounts.google.com and back, so this is the only code that runs before
    // the redirect. localStorage survives a same-origin redirect, which is the
    // whole trick. Blank fields write nothing, so studioAsked() stays false and
    // StudioPrompt still catches this person after sign-in, exactly as it does
    // for someone who skipped this sheet entirely - see studio.ts.
    if (name.trim() || studioName.trim()) {
      setStudio({ name, studio: studioName });
    }
    try {
      await signInWithGoogle();
      // On success the browser redirects to Google; nothing else runs here.
    } catch {
      setError('Could not start sign-in. Check your connection and try again.');
      setBusy(false);
    }
  }

  return (
    <Sheet title="Sign in" onClose={props.onClose}>
      <p className="camnote" style={{ marginTop: 0 }}>
        Shotlist import and Premiere/CSV exports need a free account. Logging takes and
        PDF export are always free.
      </p>

      <p className="camnote" style={{ marginTop: 0 }}>
        Your production house goes on every PDF and CSV you export. You can change
        it any time in Settings, or skip this and we will ask once after you sign in.
      </p>

      <div className="formrow">
        <label className="label" htmlFor="signin-name">
          Your name
        </label>
        <input
          id="signin-name"
          className="field"
          autoComplete="name"
          placeholder="e.g. Kirtan"
          value={name}
          onChange={(e) => setName(e.target.value)}
        />
      </div>

      <div className="formrow">
        <label className="label" htmlFor="signin-house">
          Production house
        </label>
        <input
          id="signin-house"
          className="field"
          autoComplete="organization"
          placeholder="e.g. Fourside Studio"
          value={studioName}
          onChange={(e) => setStudioName(e.target.value)}
        />
      </div>

      {/* `--bad` was never defined anywhere, so the error line always rendered
          its raw-hex fallback: a colour outside the palette, on a sheet the
          repaint has to survive in both themes. --rec-text IS the house error
          register (5.69:1 on paper, and aliased to the bright value on night,
          so one token covers both grounds). */}
      {error && (
        <p className="camnote" role="alert" style={{ color: 'var(--rec-text)' }}>
          {error}
        </p>
      )}

      <button
        type="button"
        className="btn btn--go btn--full"
        disabled={busy}
        onClick={onSignIn}
      >
        {busy ? 'Opening Google…' : 'Sign in with Google'}
      </button>

      <p className="camnote" style={{ fontSize: '12px', marginBottom: 0 }}>
        By signing in you agree to our{' '}
        <a href="/legal/#terms" target="_blank" rel="noopener">Terms</a> and{' '}
        <a href="/legal/#privacy" target="_blank" rel="noopener">Privacy Policy</a>. We only receive
        your email; your projects stay on your device.
      </p>
    </Sheet>
  );
}
