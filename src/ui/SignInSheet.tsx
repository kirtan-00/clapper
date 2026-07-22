import { useState } from 'react';
import { Sheet } from './common';
import { signInWithGoogle } from '../net/auth';

/**
 * Sign-in sheet shown when an anonymous user reaches a gated action (Script Mode
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
        Script Mode and Premiere/CSV exports need a free account. Logging takes and
        PDF export are always free.
      </p>

      {error && (
        <p className="camnote" role="alert" style={{ color: 'var(--bad, #ff6b6b)' }}>
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
    </Sheet>
  );
}
