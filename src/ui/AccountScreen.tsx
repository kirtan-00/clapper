// ACCOUNT — who you are signed in as, what the free tier has left, and Pro.
//
// This is a MOVE and a re-dress of AccountRow out of the bottom of the projects
// list. NO AUTH OR QUOTA LOGIC CHANGED, deliberately:
//
//   - `getUsage()` reads the caller's own `usage` row and nothing else. The
//     numbers on this screen are DISPLAY ONLY. Every limit is enforced
//     server-side in the edge functions, `is_pro` is writable by service_role
//     alone, and none of that may ever move into the client. A counter that
//     read as "0 left" and gated the button here would be a lock on the front
//     door of a building with no walls.
//   - signInWithGoogle() redirects, so nothing after the await runs on success;
//     the busy flag is only ever cleared when the redirect never started. That
//     asymmetry is load-bearing and is copied across as-is.
//   - Signed out there is no usage row to read, and no client path to the anon
//     counter, so the free-tier line stays the same static sentence it has
//     always been rather than a number this screen would have to invent.

import { useEffect, useState } from 'react';
import { Section, Row, ReadRow, ScreenHeader } from './glist';
import { ProCta } from './ProCta';
import type { Nav } from './nav';
import { useSession, signInWithGoogle, signOut } from '../net/auth';
import { getUsage, FREE_LIMIT, ANON_LIMIT_XML, type Usage } from '../net/quota';
import * as haptics from './haptics';

/**
 * The three free-tier counters, in the order someone meets them. They are
 * SEPARATE buckets on the server: burning shotlist imports does not cost you an
 * export. Premiere and Resolve deliberately share one, because they are the
 * same handoff in two dialects — see exportGated in ProjectScreen.
 */
const COUNTERS: { key: keyof Usage; label: string }[] = [
  { key: 'script', label: 'Shotlist import' },
  { key: 'premiere', label: 'Premiere and Resolve XML' },
  { key: 'csv', label: 'CSV export' },
];

export function AccountScreen(_props: { nav: Nav }) {
  const { session, loading } = useSession();
  const [busy, setBusy] = useState(false);
  const [usage, setUsage] = useState<Usage | null>(null);

  const signedIn = !!session;

  useEffect(() => {
    if (!signedIn) {
      setUsage(null);
      return;
    }
    let active = true;
    void getUsage().then((u) => {
      if (active) setUsage(u);
    });
    return () => {
      active = false;
    };
  }, [signedIn]);

  async function onSignIn() {
    setBusy(true);
    try {
      await signInWithGoogle(); // redirects to Google; nothing after this runs on success
    } catch {
      setBusy(false); // only reached if the redirect never started
    }
  }

  return (
    <div className="app">
      <ScreenHeader title="Account" />

      {loading ? (
        <div className="empty">Checking your account</div>
      ) : signedIn ? (
        <>
          <Section title="Signed in">
            <ReadRow label="Google" value={session.user.email ?? 'your account'} />
          </Section>

          <Section
            title="Free uses left"
            note={
              usage
                ? `Each counter is its own. ${FREE_LIMIT} free uses of each, and they do not spend each other.`
                : 'Counted on the server. This needs a connection to read.'
            }
          >
            {COUNTERS.map(({ key, label }) => (
              <ReadRow
                key={key}
                label={label}
                mono
                value={usage ? `${usage[key].left} of ${FREE_LIMIT}` : '—'}
              />
            ))}
          </Section>

          <Section
            title="Always free"
            note="Logging takes, the PDF shot log and Backup never need an account, a connection or a counter. They are the parts you cannot be locked out of at 2am on a location with no signal."
          >
            <ReadRow label="Take logging" value="Unlimited" />
            <ReadRow label="PDF shot log" value="Unlimited" />
            <ReadRow label="Backup and restore" value="Unlimited" />
          </Section>

          <ProCta gate="account" />

          <Section title="Session">
            <Row
              label="Sign out"
              destructive
              onClick={() => {
                haptics.tap();
                void signOut();
              }}
            />
          </Section>
        </>
      ) : (
        <>
          <Section
            title="Sign in"
            note="A free Google sign-in. We receive your email address and nothing else. It is what the server counts your free uses against."
          >
            <Row
              label={busy ? 'Opening Google…' : 'Sign in with Google'}
              push
              primary
              disabled={busy}
              onClick={() => {
                haptics.tap();
                void onSignIn();
              }}
            />
          </Section>

          <Section
            title="Without an account"
            note="Signing in is never forced. It unlocks the parts that run on a server, and nothing else changes."
          >
            <ReadRow label="Take logging" value="Free" />
            <ReadRow label="PDF shot log" value="Free" />
            <ReadRow label="Backup and restore" value="Free" />
            <ReadRow label="Premiere and Resolve XML" value={`${ANON_LIMIT_XML} times`} mono />
            <ReadRow label="Shotlist import" value="Sign in" />
            <ReadRow label="CSV export" value="Sign in" />
          </Section>
        </>
      )}
    </div>
  );
}
