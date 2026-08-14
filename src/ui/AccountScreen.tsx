// ACCOUNT — PLACEHOLDER: the shell wires it, the next agent writes it.
//
// What moves here (from docs/specs/2026-08-14-shell-and-shot-division.md):
//   - AccountRow (ProjectsScreen 282-338): sign in with Google, sign out, and
//     the line explaining what an account is actually for.
//   - The usage and quota counters (net/quota.ts: getUsage, FREE_LIMIT,
//     ANON_LIMIT_XML).
//   - ProCta (src/ui/ProCta.tsx).
//
// AccountRow stays live on the Projects tab until it is moved, so signing in
// is never unreachable in the meantime. Move it, do not copy it.

import type { Nav } from './nav';
import { Stub } from './Stub';

export function AccountScreen(_props: { nav: Nav }) {
  return (
    <div className="app">
      <header className="masthead">
        <div>
          <h1>Account</h1>
          <p>Sign in, usage, Pro</p>
        </div>
      </header>

      <Stub
        title="Account"
        lede="Sign in is still on the Projects tab, under the buttons. Moving here next."
        coming={[
          'Sign in and out with Google',
          'What is free without an account',
          'Usage and free-tier counters',
          'Pro',
        ]}
      />
    </div>
  );
}
