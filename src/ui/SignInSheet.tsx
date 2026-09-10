import { useState } from 'react';
import { Sheet } from './common';
import { signInWithGoogle } from '../net/auth';
import { getStudio, saveIdentityBeforeGoogle } from './studio';
import { IdentityFields } from './IdentityFields';

/**
 * Sign-in sheet shown when an anonymous user reaches a gated action (shotlist import
 * or Premiere/CSV export). Google is the only provider. On success the OAuth flow
 * navigates away and returns to the app; the caller re-checks the session on return.
 *
 * Carries the name/production-house fields ABOVE the button (see StudioSheet.tsx for
 * why those questions exist and why StudioPrompt still exists alongside this).
 * `IdentityFields` is the same component Onboarding.tsx's SignInStage renders, and
 * `saveIdentityBeforeGoogle` (studio.ts) is the one place that decides whether a
 * filled-in answer gets written before the redirect - see both for why the rule has
 * to live in exactly one place.
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
    // whole trick.
    saveIdentityBeforeGoogle(name, studioName);
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
      {/* VALUE, NOT A WALL (see Onboarding.tsx's SignInStage comment for the
          same rule). Reworded 2026-08-30: the old line said "PDF export are
          always free," which `exportGated` contradicts — PDF is project-locked
          like Premiere/Resolve. This sheet also fronts shotlist and call-sheet
          import, so the copy stays true for all three by leading with what the
          account BUYS: your work saved, and a CSV you hand straight to your
          editor. CSV is the one export any signed-in account keeps forever;
          logging takes and Backup never need an account at all. */}
      <p className="camnote" style={{ marginTop: 0 }}>
        Sign in with a free account to save your work and hand it to your editor. Your
        CSV export — a clean spreadsheet of every take — is free forever, ready to drop
        into any edit. Logging takes and Backup never need an account.
      </p>

      <p className="camnote" style={{ marginTop: 0 }}>
        Your production house goes on every PDF and CSV you export. You can change
        it any time in Settings, or skip this and we will ask once after you sign in.
      </p>

      <IdentityFields
        idPrefix="signin"
        name={name}
        studioName={studioName}
        onNameChange={setName}
        onStudioChange={setStudioName}
      />

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
