// ACCOUNT - who you are signed in as, what the free tier has left, and Pro.
//
// REWORKED 2026-08-27. This screen used to list five export counters
// (shotlist import, call sheet, Premiere/Resolve, PDF, CSV) - a direct
// reflection of the old per-format quota model. That model is gone; the
// meter is PROJECTS now, and exports split into "CSV: always free" and
// "PDF/Premiere: need this project unlocked" (never shown as a counter at
// all, since export access is a per-project yes/no, not a number that counts
// down). See src/net/quota.ts's own header for the full story.
//
// NO AUTH OR ENTITLEMENT LOGIC CHANGED IN KIND, only in shape:
//   - `getEntitlements()` reads the caller's own `profiles` row and nothing
//     else. The numbers on this screen are DISPLAY ONLY. Every limit is
//     enforced server-side in the edge functions, and none of that may ever
//     move into the client. A counter that read "0 left" and gated the
//     button here would be a lock on the front door of a building with no
//     walls.
//   - signInWithGoogle() redirects, so nothing after the await runs on
//     success; the busy flag is only ever cleared when the redirect never
//     started. That asymmetry is copied across as-is.
//   - Signed out there is no profile row to read, so the free-tier line
//     stays a static sentence rather than a number this screen would have to
//     invent.

import { useEffect, useState } from 'react';
import { Section, Row, ReadRow, ScreenHeader } from './glist';
import type { Nav } from './nav';
import { useSession, signInWithGoogle, signOut } from '../net/auth';
import { FREE_PROJECT_LIMIT, FREE_PROJECT_RESET_DAYS, type Entitlements } from '../net/quota';
import { useEntitlements } from './useEntitlements';
import { usePurchase, usePromoOffer, type Purchase } from './pricing';
import { PricingLadder } from './PricingRows';
import * as haptics from './haptics';

// The one contact route for the tier the catalogue deliberately never
// prices - see products.ts's own closing note: enterprise is a "contact us"
// link, negotiated by hand, and never reaches a payment gateway.
const ENTERPRISE_MAILTO =
  'mailto:purohit.krick@gmail.com?subject=' +
  encodeURIComponent('Clapper Enterprise') +
  '&body=' +
  encodeURIComponent('Tell us about your team and how many projects a month:\n\n');

// ===========================================================================
// A SEAM FOR SCREENSHOTS. DEV ONLY.
// ===========================================================================
// Same move ShotlistSheet.tsx's `__clapperShotlistGate` makes, for the same
// reason: the states that matter most on this screen (signed in on Free, on
// Studio, on Studio Plus, mid-purchase) cannot be stood in front of without
// a real Supabase session and a real subscription. `import.meta.env.DEV` is
// a compile-time constant, so this whole block is dropped from the shipped
// bundle.
interface AccountDevOverride {
  email?: string;
  entitlements?: Partial<Entitlements>;
}
const DEV_DEFAULT_ENTITLEMENTS: Entitlements = {
  isPro: false,
  proUntil: null,
  freeProjectsUsed: FREE_PROJECT_LIMIT,
  freeProjectsLimit: FREE_PROJECT_LIMIT,
  projectCredits: 0,
  subscriptionActive: false,
  subscriptionProduct: null,
  podcastMinutesLimit: 180,
  podcastMinutesUsed: 0,
};
let accountDevOverride: AccountDevOverride | null = null;
const accountDevListeners = new Set<() => void>();
if (import.meta.env.DEV && typeof window !== 'undefined') {
  (window as unknown as Record<string, unknown>).__clapperAccountDev = (o: AccountDevOverride | null) => {
    accountDevOverride = o;
    for (const fn of accountDevListeners) fn();
  };
}
function useAccountDev(): AccountDevOverride | null {
  const [, bump] = useState(0);
  useEffect(() => {
    if (!import.meta.env.DEV) return;
    const fn = () => bump((n) => n + 1);
    accountDevListeners.add(fn);
    return () => {
      accountDevListeners.delete(fn);
    };
  }, []);
  return import.meta.env.DEV ? accountDevOverride : null;
}

/**
 * "Ever" when FREE_PROJECT_RESET_DAYS is 0 (today's setting - the owner's
 * explicit one-time grant), or "a month" for any positive value. Read off
 * the same constant the entitlements read uses, so flipping that one number
 * in quota.ts/products.ts to switch to a monthly refill updates this screen's
 * copy for free - see products.ts's FREE_PROJECT_RESET_DAYS for the full
 * reasoning on why that is a single number rather than a rewrite.
 */
function freeProjectPeriodLabel(): string {
  return FREE_PROJECT_RESET_DAYS > 0 ? `every ${FREE_PROJECT_RESET_DAYS} days` : 'ever';
}

/**
 * The honest, final line for a free account that has spent its grant. NEVER
 * "resets soon" or anything implying a refill while FREE_PROJECT_RESET_DAYS
 * is 0 - the owner was explicit that this grant does not come back, and a
 * screen that hints otherwise is a screen that lies to someone about to pay
 * to find out. Written as its own function, not inlined, so the one place
 * this promise is made is the one place it has to stay true if the flip
 * above is ever thrown.
 */
function projectsLeftCopy(used: number, limit: number): string {
  const left = Math.max(0, limit - used);
  if (left > 0) return `${left} of ${limit} free projects left`;
  if (FREE_PROJECT_RESET_DAYS > 0) return `0 of ${limit} free projects left this period`;
  return `Free projects used up. This grant does not come back - unlock a project to continue.`;
}

function podcastCopy(ent: Entitlements): string {
  const left = Math.max(0, ent.podcastMinutesLimit - ent.podcastMinutesUsed);
  const hours = (n: number) => (n % 60 === 0 ? `${n / 60}h` : `${Math.floor(n / 60)}h ${n % 60}m`);
  return `${hours(left)} of ${hours(ent.podcastMinutesLimit)} left this month`;
}

export function AccountScreen(_props: { nav: Nav }) {
  const { session, loading } = useSession();
  const [busy, setBusy] = useState(false);
  const dev = useAccountDev();

  const signedIn = dev ? true : !!session;
  const email = dev?.email ?? session?.user.email ?? 'your account';
  // Shared with every other screen's paywall - a purchase made from a
  // locked export on ProjectScreen calls refreshEntitlements() (see
  // pricing.ts), and this hook picks the new number up the next time this
  // screen is mounted, no manual reload. See useEntitlements.ts's header.
  // Suspended while a dev override is active - see the seam's own header.
  const { entitlements: liveEnt } = useEntitlements(signedIn && !dev);
  const ent = dev ? { ...DEV_DEFAULT_ENTITLEMENTS, ...dev.entitlements } : liveEnt;
  const { busyKey, status, buy } = usePurchase();
  const purchase: Purchase = { busyKey, status, buy };
  const { offer } = usePromoOffer();

  async function onSignIn() {
    setBusy(true);
    try {
      await signInWithGoogle(); // redirects to Google; nothing after this runs on success
    } catch {
      setBusy(false); // only reached if the redirect never started
    }
  }

  // Full bypass - is_pro must keep working exactly as it did under the old
  // model: unlimited everything, every project already unlocked. Lapse is
  // decided the same way export-gate/breakdown decide it (see proBypass in
  // _shared/gate.ts): a pro_until in the past demotes to ordinary free-tier
  // display, it does not stay Pro because the flag is still true.
  const proActive = !!ent?.isPro && (ent.proUntil == null || new Date(ent.proUntil).getTime() > Date.now());

  return (
    <div className="app mscreen">
      {/* NO SYNC PILL ON THIS SCREEN, deliberately. The pill is a glance at
          the write's state for screens that are about something else; this
          screen IS that state, spelled out in full a row further down. Two
          things saying "this phone only" within 200px of each other is one
          too many, which is the same reasoning the theme row already uses for
          not spelling out the switch it is showing. */}
      <ScreenHeader title="Account" />

      {loading ? (
        <div className="empty">Checking your account</div>
      ) : signedIn ? (
        <>
          <Section title="Signed in">
            <ReadRow label="Google" value={email} />
          </Section>

          {proActive ? (
            <Section title="Pro" note="Legacy grant. Every project unlocked, no limits.">
              <ReadRow label="Projects" value="Unlimited" />
              <ReadRow label="Podcast roll time" value="Unlimited" />
              <ReadRow label="PDF / Premiere / Resolve export" value="Unlimited" />
            </Section>
          ) : (
            <Section
              title="Director mode"
              note={ent ? `Free grant is a one-time thing - ${freeProjectPeriodLabel()}.` : 'Needs a connection to read.'}
            >
              <ReadRow
                label="Projects"
                value={ent ? projectsLeftCopy(ent.freeProjectsUsed, ent.freeProjectsLimit) : '—'}
                // `pr-wraprow` (PricingRows.css): the spent-grant sentence
                // (projectsLeftCopy's last branch) is a full sentence, not a
                // short counter - list.css's normal nowrap value ran the
                // card past the screen's right edge rather than wrapping it.
                className="pr-wraprow"
              />
              <ReadRow
                label="Project credits"
                value={ent ? `${ent.projectCredits} available` : '—'}
              />
              <ReadRow
                label="PDF / Premiere / Resolve export"
                value={ent && ent.projectCredits > 0
                  ? 'Included with every unlocked project'
                  : 'Unlock a project to export'}
                // Same opt-in, same reason: this label plus this value
                // together do not fit on one line at 390px (let alone
                // 320px), and list.css's ellipsis crushed the label to "P…"
                // rather than wrapping it - see `pr-wraprow`'s own comment.
                className="pr-wraprow"
              />
            </Section>
          )}

          {!proActive && (
            <Section title="Podcast mode" note="Roll time, not project count.">
              <ReadRow label="This month" value={ent ? podcastCopy(ent) : '—'} />
            </Section>
          )}

          {/* CSV is the one export that never needs a project unlocked - see
              the header of net/quota.ts for why CSV specifically is the free
              one. */}
          <Section title="Always free">
            <ReadRow label="Take logging" value="Unlimited" />
            <ReadRow label="CSV export" value="Unlimited" />
            <ReadRow label="Backup and restore" value="Unlimited" />
          </Section>

          {/* THE STANDING PRICING SURFACE. Reachable on its own, not behind
              a lock - the "wanna go pro" entry the owner asked for, that a
              cap-hit's ProCta (still shown on ProjectScreen/ShotlistSheet)
              does not cover by itself: someone who has never hit a wall
              still gets to see what buying gets them.

              GROUPED, per the owner's own correction after seeing a flat
              five-row list: pay-per-job and subscribe are two different
              questions, so `PricingLadder` (PricingRows.tsx) answers them
              as two sections at two weights, Free included and Enterprise
              linked since this IS the full pricing page (ProCta's cap-hit
              paywall omits both). The subscription this account already
              holds passes through as `currentSubscriptionKey` and renders
              as a plain read row instead of a buy button - one-time
              credits never show "current", they are a consumable, not a
              plan you are "on". */}
          <PricingLadder
            offer={offer}
            purchase={purchase}
            includeFree
            enterpriseHref={ENTERPRISE_MAILTO}
            currentSubscriptionKey={ent?.subscriptionActive ? ent.subscriptionProduct : null}
          />

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
          {/* THE SIGNED-OUT BACKUP WARNING LIVES HERE NOW.
              It used to sit at the top of every project screen, on every visit,
              as two lines ending "if you lose the phone, you lose the shoot" -
              ambient dread, permanently, for a state that is a fact about the
              ACCOUNT rather than about the project you happen to have open. As
              a row with a badge it is still true, still findable, and no longer
              shouted at someone who is mid-shoot and cannot act on it. */}
          <Section
            title="Sign in"
            note="We receive your email address and nothing else."
          >
            <ReadRow
              label="Your shoots"
              value={<span className="cambadge cambadge--approx">This phone only</span>}
            />
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

          <Section title="Without an account">
            <ReadRow label="Take logging" value="Free" />
            <ReadRow label="Backup and restore" value="Free" />
            <ReadRow label="Shotlist import, call sheets, CSV/PDF/Premiere export" value="Sign in" />
            <ReadRow label="Free projects on sign-in" value={`${FREE_PROJECT_LIMIT}`} />
          </Section>
        </>
      )}
    </div>
  );
}
