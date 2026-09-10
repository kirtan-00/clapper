// THE WAY IN. One row, in Settings, that carries somebody who has decided to
// pay to the screen that can take the money.
//
// WHY THIS EXISTS AT ALL. Until now the app had no button anywhere that said
// "buy". The full ladder lives on the Account tab, and the only route to it
// was guessing that pricing sits behind a tab named after account settings.
// The one surface a user reached without knowing where to look was the
// paywall that opens by itself when an export is refused, which only fires
// once they are already blocked. So the app could sell to people it had just
// stopped, and to nobody who simply wanted to buy.
//
// IT NAVIGATES, IT DOES NOT SELL. This row deliberately owns no checkout, no
// price and no product list. It switches to the Account tab and stops. The
// ladder there (PricingRows.tsx) is the single place a price is allowed to be
// rendered, so there is exactly one screen to keep honest when the catalogue
// changes. This replaced RazorpayBuyRow, which put a SECOND shop here selling
// two of the five products at prices written out a second time - see that
// file's header for the pause it was built during and why it outlived it.
//
// THE VALUE COLUMN IS THE PITCH. A row that just says "Go Pro" tells somebody
// nothing they did not already know. Showing what they hold right now is what
// makes the next tap obvious: an account with no credits and its free grant
// spent reads a different sentence from one with ten credits banked, and both
// are true without asking the server anything this screen was not already
// going to ask.

import { Row, Section } from './glist';
import { useSession } from '../net/auth';
import { useEntitlements } from './useEntitlements';
import type { Nav } from './nav';
import * as haptics from './haptics';

/**
 * What this account is standing on, in the fewest words that are still true.
 *
 * ORDER MATTERS, most-committed first: a subscriber who also has banked
 * credits is a subscriber, and saying "3 credits" to somebody paying Rs 2,499
 * a month would read as a downgrade. `null` entitlements (signed out, or the
 * read has not landed) resolve to the neutral line rather than to "Free",
 * because telling somebody they are on the free tier before we know is the
 * one wrong answer that also insults a paying customer.
 */
function standing(ent: { subscriptionActive: boolean; subscriptionProduct: string | null; projectCredits: number } | null): string {
  if (!ent) return 'See plans';
  if (ent.subscriptionActive) {
    return ent.subscriptionProduct === 'studio_plus' ? 'Studio Plus' : 'Studio';
  }
  if (ent.projectCredits > 0) {
    return ent.projectCredits === 1 ? '1 credit left' : `${ent.projectCredits} credits left`;
  }
  return 'See plans';
}

/**
 * `primary` (the accent row) ONLY when there is something to sell. Somebody
 * already on Studio Plus does not need the loudest row on the screen pointing
 * at a shop they are already inside; for them this is a plain row that happens
 * to be a way back to their plan. The accent is a finite resource on a screen
 * and spending it on a customer who has already paid is spending it on nobody.
 */
export function GoProRow(props: { nav: Nav }) {
  const { session } = useSession();
  const { entitlements } = useEntitlements(!!session);
  const selling = !entitlements?.subscriptionActive;

  return (
    <Section title="Plan" note="Rolling and the CSV shot log stay free. Credits unlock PDF and Premiere exports.">
      <Row
        label="Go Pro"
        value={standing(entitlements)}
        primary={selling}
        push
        onClick={() => {
          haptics.tap();
          // switchTab, not push: Account is a tab root with its own stack, and
          // pushing it onto the Settings stack would strand somebody on a
          // second copy of Account that the tab tray does not know about.
          props.nav.switchTab('account');
        }}
      />
    </Section>
  );
}
