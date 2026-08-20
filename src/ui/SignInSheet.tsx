import { useState } from 'react';
import { Sheet } from './common';
import { signInWithGoogle } from '../net/auth';

/**
 * Sign-in sheet shown when an anonymous user reaches a gated action (shotlist import
 * or Premiere/CSV export). Google is the only provider. On success the OAuth flow
 * navigates away and returns to the app; the caller re-checks the session on return.
 */
export function SignInSheet(props: { onClose: () => void }) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function onSignIn() {
    setBusy(true);
    setError(null);
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
