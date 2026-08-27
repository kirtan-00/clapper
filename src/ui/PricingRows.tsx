// The row-level furniture for "what does Clapper cost" - shared by ProCta's
// inline paywall and AccountScreen's standing pricing table so the two
// surfaces are, structurally, the same list rendered in two places. Rows in
// sections, hairline rules between them, one tabular figure per row that
// shares a right edge with every other price on the screen - the same
// vernacular Account and Settings already use for everything else. No
// cards, no "recommended" pill: the ladder is supposed to argue itself, via
// the per-project figure in every row's value column, not via a badge on
// one of them.
//
// ACID YELLOW, EXACTLY ONCE - BUT NEVER ZERO TIMES. `Row`'s existing
// `primary` prop already reads `--m-accent-text` (acid on night, the day
// accent on day) - see its own comment in styles.css ("the one row on a
// screen that is the reason you opened it"). The launch offer is `primary`
// here for as long as it is actually buyable. That offer is capped at ten
// accounts, though (see `pricing.ts`'s own header on `jumpstart_5`), and
// for the entire rest of this product's life after that this screen would
// otherwise have nothing for the eye to land on - a defect named directly:
// "a screen whose only job is to take money must have one deliberate focal
// point that survives the promo ending." Studio Plus (`SubscriptionRow`'s
// `accent` prop, gated in `PricingLadder`) is that permanent focal point,
// carrying the SAME brass vocabulary the rest of this app already uses for
// "the one that matters" - never both at once, see `PricingLadder`'s own
// header for the hand-off rule. Every other row stays plain weight, plain
// colour.

import type { CSSProperties } from 'react';
import { Row, ReadRow, Section, LinkRow, Chevron } from './glist';
import type { Product } from '../../supabase/functions/_shared/products';
import type { PromoOffer } from '../net/pay';
import {
  tierLabel,
  tierValue,
  showPromo,
  ONE_TIME_PRODUCTS,
  SUBSCRIPTION_PRODUCTS,
  JUMPSTART_PRODUCT_KEY,
  type Purchase,
  type TierValue,
} from './pricing';
import './PricingRows.css';

/**
 * Two right-aligned lines in the one tabular value column: the sticker
 * price, and, muted underneath, the qualifier plus (when the tier buys more
 * than one credit) the per-project cost. Went through one failed cut first -
 * a single line concatenating everything ("Rs 2,499/mo (Rs 125/ea)") ran
 * wide enough on a 375-390px row to force every subscription LABEL into an
 * ellipsis, which is the exact "figures do not share a baseline" complaint
 * this was meant to fix, just moved to the other column. Splitting across
 * two short lines instead of one long one leaves the label whole and still
 * puts both numbers "next to" the option, stacked rather than side by side.
 *
 * MONO ON THE STICKER ONLY, not the whole stack. `mono` used to sit on the
 * outer `Row`/`button`, which put `.tnum` (list.css's tabular/monospace
 * class) on the detail line too - and the detail line is a PHRASE ("once,
 * Rs 480 each"), not a number. A sentence set in the app's number font is
 * exactly the machine-written register this screen keeps getting rejected
 * for; `glist.tsx`'s own `RowFace` comment already says words stay in the
 * UI face. So callers now pass `mono={false}` on the row and this component
 * puts `.tnum` on the sticker span by hand - the money is still tabular,
 * the sentence around it reads like English.
 *
 * Sits inside `SubscriptionRow`'s scaled wrapper without any scale prop of
 * its own - the row's own font-size carries the scale (see `SubscriptionRow`
 * for how, and for the self-reference bug that used to make the "bigger"
 * rows render smaller), and this inherits it like any other text.
 *
 * BOTH LINES `nowrap`, FOUND ON THE RENDER, NOT IN THE SOURCE. `pr-wraprow`
 * (PricingRows.css) puts `white-space: normal` on `.grow-value` so a long
 * VALUE never truncates - correct for `TierRow`, where the value is one
 * short line. At Studio Plus's 1.3x scale that same rule let the flex
 * layout starve the value column for space and wrap "Rs 2,499" as "Rs" /
 * "2,499" on two lines - the sticker literally split its own digits, which
 * is the "figures do not share a right edge" defect all over again, just
 * inside one row instead of across four. Both lines here opt back OUT of
 * that inherited wrapping: a price is one unbreakable run, so if something
 * has to give up width to the label at this scale, it has to be the label
 * (which has real word-break points) and never the money.
 */
function ValueStack(props: { value: TierValue }) {
  return (
    <span
      style={{
        display: 'flex',
        flexDirection: 'column',
        alignItems: 'flex-end',
        lineHeight: 1.3,
      }}
    >
      <span className="tnum" style={{ whiteSpace: 'nowrap' }}>{props.value.sticker}</span>
      <span style={{ fontSize: 'var(--t-caption)', color: 'var(--text-faint)', whiteSpace: 'nowrap' }}>
        {props.value.detail}
      </span>
    </span>
  );
}

/** A standard priced tier: name + what it gets you on the left, the sticker
 *  price and (when it buys more than one credit) the per-project cost on
 *  the right, tabular. Used for the "pay per job" one-off ladder, kept
 *  deliberately plain and compact next to `SubscriptionRow`.
 *
 *  `push` (the chevron `Row` already draws for anything that acts - see
 *  AccountScreen.tsx's own "Sign in with Google" row for the same pairing)
 *  is the fix for a row that priced itself correctly but never looked
 *  tappable: name and a number read as a table row, not a control, with
 *  nothing to tell a buyer a tap does anything. This is the app's own
 *  vocabulary for "this row acts," not a new affordance invented here. */
export function TierRow(props: { product: Product; purchase: Purchase }) {
  const { product, purchase } = props;
  const busy = purchase.busyKey === product.key;
  return (
    <Row
      label={tierLabel(product)}
      value={busy ? 'Working…' : <ValueStack value={tierValue(product)} />}
      // NOT `mono`: that puts `.tnum` on the whole value slot, and
      // `ValueStack`'s detail line is a phrase ("once, Rs 480 each"), not a
      // number - see that component's own header. `ValueStack` puts `.tnum`
      // on the sticker span itself, so the money still reads tabular
      // without setting a sentence in the mono face.
      // Same opt-out as the launch offer row, for the same reason and one
      // width down: at 320px, the narrowest phone this app supports, "5
      // project credits" lost its last word to ellipsis while the price
      // beside it kept every digit. A price is never a reason to make the
      // thing being priced unreadable.
      className="pr-wraprow"
      push
      disabled={purchase.busyKey !== null}
      onClick={() => void purchase.buy(product)}
    />
  );
}

/** "Studio · 6/mo" - short on purpose. `RowFace.label` is a plain string
 *  (glist.tsx, not mine to widen to ReactNode), and at the scaled-up size
 *  `SubscriptionRow` renders this at, the longer "Studio Plus, 20 credits"
 *  this file used at 1x truncated - see ValueStack's own note on the same
 *  problem hitting the value column first. */
function subscriptionLabel(product: Product): string {
  const name = product.key === 'studio_plus' ? 'Studio Plus' : 'Studio';
  return `${name} · ${product.credits}/mo`;
}

/** The one thing Studio Plus buys beyond more credits. Built by other agents
 *  (src/ui/studio.ts, src/export/pdf.ts) - this only names it so the row
 *  that costs more explains why.
 *
 *  REWORKED 2026-08-27: this used to be TWO lines, "Plus: your own logo on
 *  every export" and "Plus: folders, by client or show", each its own
 *  ReadRow under the Studio Plus row at full row weight - a buyer counting
 *  rows saw seven products for sale, not five. Folders is gone from here
 *  entirely now: it turned out to already ship free, live, for every
 *  account (verified against the deployed bundle), so advertising it as a
 *  Studio Plus perk would have been selling something the buyer already
 *  owns. What is left is the one claim that is actually true of Studio Plus
 *  and nothing else - the logo - carried as supporting text INSIDE the row
 *  (see `SubscriptionLabel` below), at caption weight, directly under the
 *  name it explains.
 *
 *  LEGIBILITY FIXED 2026-08-27, SEPARATELY FROM THE ACCENT. This line used
 *  to sit at `--t-caption` in `--text-faint` - the faintest text on the
 *  screen, naming the one reason to pay 2.5x more. `.pr-subrow__perks`
 *  (PricingRows.css) now sets it at `--t-secondary` in `--text-dim`,
 *  unconditionally, whether or not the row also carries the one accent this
 *  task adds (see `SubscriptionRow`'s own header) - a claim this important
 *  has to read whether or not the launch offer happens to be live, not only
 *  once the promo is gone and the accent lands here. */
const STUDIO_PLUS_PERK = 'Your own logo on every export.';

/** `SubscriptionRow`'s label, shared between its buyable branch (a real
 *  `<button>`) and its `current` branch (a static row someone already
 *  subscribed to) so both render the EXACT same two-line markup - same
 *  `.grow-label pr-subrow__label` structure, same `.pr-subrow__perks`
 *  caption. Also why the `current` branch is a hand-rolled `.grow` row
 *  rather than a `ReadRow` plus a trailing `<p>`: a `<p>` sibling would sit
 *  between two `.grow` elements and break `.grow + .grow::before`'s
 *  adjacency, silently dropping the hairline above whatever row comes
 *  after (Enterprise, on the standing pricing table). One `.grow` per row,
 *  always, keeps that CSS rule true without either branch having to know
 *  about the other. */
function SubscriptionLabel(props: { product: Product; big?: boolean }) {
  return (
    <span className="grow-label pr-subrow__label">
      <span className="pr-subrow__name">{subscriptionLabel(props.product)}</span>
      {props.big && <span className="pr-subrow__perks">{STUDIO_PLUS_PERK}</span>}
    </span>
  );
}

/**
 * A subscription tier, deliberately heavier than `TierRow` - bigger type,
 * more room, per the owner's own correction: "a buyer is not choosing
 * between five things, they are answering one question: pay per job, or
 * subscribe". Size carries the weight, not a badge - `big` (Studio Plus
 * only) scales further still than plain Studio, so the row that carries
 * the logo visibly outweighs the one that is just more credits.
 *
 * THE SCALE USED TO BE A NO-OP, AND WORSE - MADE THE ROW SMALLER. The first
 * cut wrote `'--t-row': calc(var(--t-row) * ${scale})` as an inline style on
 * this SAME wrapping div. That is a custom property referencing itself: CSS
 * calls that a cyclic reference, and a cyclic custom property is invalid at
 * computed-value time - not "falls back to the old value", INVALID, full
 * stop. Every descendant's `font-size: var(--t-row)` then went invalid too
 * and fell all the way back to the browser's own default (16px), which is
 * SMALLER than the app's own 17px row type - so the row the owner asked to
 * look heavier rendered lighter than an ordinary row, silently, because
 * nothing throws for an invalid custom property, it just quietly stops
 * being it. Caught by reading the rows' own computed `font-size` in a live
 * page, not by reading this file - the bug was invisible in the source.
 *
 * THE FIX IS A SECOND VARIABLE, NOT A BIGGER MULTIPLIER. `--pr-row-scale`
 * (below, and in PricingRows.css) is a NEW custom property, never redefined
 * by anything that also reads it, so there is no cycle: `--t-row` is read
 * fresh off this row's actual ancestor (the section's card, still 17px),
 * multiplied by `--pr-row-scale`, and the result becomes THIS row's own
 * `font-size` - one CSS rule, `.pr-subrow-scale > .grow`, in PricingRows.css.
 * Label and value both inherit that computed font-size normally, so it is
 * still one scaling mechanism doing both, exactly as the original comment
 * intended - it just cannot be an override of the same name it reads.
 *
 * NOT `Row` FOR EITHER BRANCH. `Row`'s `label` is a plain string (glist.tsx,
 * RowFace), which is right for every other row in the app but cannot carry
 * Studio Plus's second, dimmer line. So both branches compose the same
 * `.grow` markup `Row`/`ReadRow` render (icon slot unused, label, tabular
 * value, chevron only on the buyable one) by hand, sharing `SubscriptionLabel`
 * above so the two-line label is byte-identical either way. Same CSS
 * classes, same tap target, same hairline and press state as every other
 * row - only the label grew a second line. The chevron (`push`, same as
 * `TierRow`) is what makes the buyable branch read as tappable rather than
 * a priced table row.
 *
 * `accent`: THE ONE FOCAL POINT THIS SCREEN KEEPS ONCE THE PROMO IS GONE.
 * `PricingRows.css`'s own header names the defect - the launch offer's
 * `primary` (Row's own prop) is correct while ten slots last, and then this
 * screen has nothing left for the eye. `accent` is true only when the
 * caller (`PricingLadder`, below) has decided the promo is NOT currently
 * showing its own `primary` row - passing both at once would put two acid
 * moments on the same night screen at once (`--brass-text` and
 * `--m-accent-text` are the identical #e6ff2b there), which is the one
 * thing "exactly one" rules out. It only ever does anything when `big` is
 * also true: Studio Plus, the top of the ladder, is the row built to carry
 * it permanently. See `.pr-subplus` in PricingRows.css for the treatment -
 * the same GOLD vocabulary (`--brass-tint`, `--brass-edge`, `--brass-text`)
 * `procta__btn`, `.goldbtn` and `.camcount__opt--on` already use elsewhere
 * in this app for "the one that matters", not a new colour.
 */
export function SubscriptionRow(props: {
  product: Product;
  purchase: Purchase;
  big?: boolean;
  current?: boolean;
  accent?: boolean;
}) {
  const { product, purchase, big, current, accent } = props;
  const busy = purchase.busyKey === product.key;
  const scale = big ? 1.3 : 1.12;
  const rawStyle: Record<string, string | number> = {
    '--pr-row-scale': scale,
    fontWeight: big ? 700 : 600,
  };
  const accentOn = !!(big && accent);
  const growClass = (base: string) => (accentOn ? `${base} pr-subplus` : base);

  if (current) {
    return (
      <div className="pr-subrow-scale" style={rawStyle as CSSProperties}>
        {/* `pr-wraprow` HERE TOO, found missing on the render, not in review.
            Without it, "Studio Plus · 20/mo" next to this branch's own fixed-
            width "Your plan" value has nothing beating `.grow-label`'s plain
            `white-space: nowrap` (list.css) at equal (0,1,0) specificity to
            `.pr-subrow__label`'s own `white-space: normal` - and since
            list.css loads after this file in the cascade, list.css's nowrap
            silently won every time, on every branch, even before this task.
            It only became visible once Studio Plus actually scaled to 1.3x
            (see this component's own header on the cyclic `--t-row` bug) and
            212px stopped being wide enough at 320px: the overflowing nowrap
            name painted straight through "Your plan" rather than wrapping
            under it. `.pr-wraprow .grow-label` (PricingRows.css) is a
            descendant selector at (0,2,0), which is the one thing that
            reliably beats list.css regardless of stylesheet load order - the
            buyable branch below already carries it for the same reason. */}
        <div className={growClass('grow pr-wraprow')} data-static="">
          <SubscriptionLabel product={product} big={big} />
          <span className="grow-value">Your plan</span>
        </div>
      </div>
    );
  }

  return (
    <div className="pr-subrow-scale" style={rawStyle as CSSProperties}>
      <button
        type="button"
        // `pr-wraprow` has to sit on the SAME element as `grow` (see that
        // class's comment). This row hand-builds its markup instead of
        // going through `Row`, so it does not inherit the opt-out and has
        // to name it: at 320px "Studio Plus · 20/mo" was truncating.
        className={growClass('grow pr-wraprow')}
        disabled={purchase.busyKey !== null}
        onClick={() => void purchase.buy(product)}
      >
        <SubscriptionLabel product={product} big={big} />
        {/* NOT `.tnum` on this outer span - see `ValueStack`'s own header.
            The sticker span inside it carries the tabular class itself; this
            span just holds whichever of the two the row is showing. */}
        <span className="grow-value">
          {busy ? 'Working…' : <ValueStack value={tierValue(product)} />}
        </span>
        <span className="grow-chev">
          <Chevron />
        </span>
      </button>
    </div>
  );
}

/** A Product-shaped stand-in for the launch offer, built from what
 *  promo-status actually returned rather than from the static catalogue -
 *  the ten-slot cap and its price live server-side (see
 *  supabase/functions/_shared/promo.ts), this just gives `tierValue` a
 *  shape it already knows how to format. Falls back to the catalogue's own
 *  Rs 100 / 5 credits only when the server omitted a field, which today
 *  only happens while signed out (remaining/amount/credits are null on
 *  purpose - eligibility is per account, see PromoOffer's own comment). */
function jumpstartProduct(offer: PromoOffer): Product {
  return {
    key: JUMPSTART_PRODUCT_KEY,
    kind: 'one_time',
    credits: offer.credits ?? 5,
    amountCents: offer.amount ?? 10000,
    currency: (offer.currency as 'INR' | 'USD') ?? 'INR',
    label: offer.label ?? 'Launch offer',
  };
}

/**
 * The launch offer row, or nothing. `null` from the promo read, or a state
 * where the ten are gone and this account never had one, both render
 * nothing - see `showPromo`'s own note on why a button guaranteed to fail
 * is worse than no button.
 */
export function PromoRow(props: { offer: PromoOffer | null; purchase: Purchase }) {
  const { offer, purchase } = props;
  if (!showPromo(offer)) return null;
  const o = offer!;

  if (o.alreadyClaimed) {
    return <ReadRow label="Launch offer" value="Already used" />;
  }

  const label = !o.signedIn
    ? 'Launch offer, first 10 accounts only'
    : `Launch offer, ${o.remaining} of ${o.slots} left`;

  const busy = purchase.busyKey === JUMPSTART_PRODUCT_KEY;
  const product = jumpstartProduct(o);

  return (
    <Row
      label={label}
      value={busy ? 'Working…' : <ValueStack value={tierValue(product)} />}
      // NOT `mono` - see `ValueStack`'s own header on why the whole value
      // slot no longer takes the tabular class; the sticker span inside
      // carries it by itself now.
      // `pr-wraprow` (PricingRows.css): the one number that makes this row
      // legible - "N of M left" - must never lose a digit to ellipsis. See
      // that class's own comment for why this needs the opt-in rather than
      // list.css's normal one-line row.
      className="pr-wraprow"
      primary
      // primary + push together, same pairing AccountScreen.tsx's own
      // "Sign in with Google" row uses for the one action a screen most
      // wants tapped: the accent carries the eye, the chevron confirms
      // there is something to press. It is the only row on the ladder that
      // gets both, which is what makes it read as the most pressable thing
      // on the screen rather than just the most colourful one.
      push
      disabled={purchase.busyKey !== null}
      onClick={() =>
        void purchase.buy(product, {
          networkFallbackMessage: o.signedIn
            ? 'That launch offer just went. Grab one of the plans below instead.'
            : 'Could not start that. Check your connection and try again.',
        })
      }
    />
  );
}

/**
 * THE WHOLE LADDER, grouped rather than a flat five-row list. The owner's
 * own correction, after seeing the flat version: a buyer is not choosing
 * between five things, they are answering one question - pay per job, or
 * subscribe - so the surface should ask it that way. Three groups, in the
 * order a reader should consider them:
 *
 *   1. The launch offer, ABOVE EVERYTHING, only while it is actually
 *      buyable for this viewer (see `showPromo` - null and "the ten are
 *      gone" both render nothing here, same as `PromoRow` alone).
 *   2. "Pay per job" - Free, 1 credit, 5 credits. Tight, factual,
 *      `TierRow`'s compact size. No subscription, so it stays first for
 *      anyone who came here undecided.
 *   3. "Subscribe" - Studio, then Studio Plus larger still, `Row`s not
 *      cards, deliberately outsized against group 2 so the two questions
 *      ("per job" vs "subscribe") read as two different weights of
 *      decision rather than five equal options in a row.
 *
 * `currentSubscriptionKey` is AccountScreen-only (it has entitlements to
 * check); ProCta's cap-hit paywall omits it; passing nothing here just
 * means no row ever renders as "Your plan", never a wrong one.
 *
 * THE ONE ACCENT, HANDED OFF RATHER THAN DOUBLED. `PromoRow` already takes
 * `primary` for as long as the launch offer is actually buyable - see its
 * own comment. `studioPlusAccent` below is true exactly when that is NOT
 * happening: `showPromo(offer)` false (no offer, or the ten are gone and
 * this account never had one), or true but `alreadyClaimed` (the offer
 * renders as a plain "Already used" `ReadRow`, no `primary`, nothing
 * accented). Only one of "the promo row" and "the Studio Plus row" is ever
 * the accent at a time - see `SubscriptionRow`'s own header for why
 * stacking both would put two acid moments on the same night screen, since
 * `--m-accent-text` and `--brass-text` are the identical colour there. */
export function PricingLadder(props: {
  offer: PromoOffer | null;
  purchase: Purchase;
  includeFree?: boolean;
  enterpriseHref?: string;
  currentSubscriptionKey?: string | null;
}) {
  const { offer, purchase, includeFree, enterpriseHref, currentSubscriptionKey } = props;
  const studioPlusAccent = !(showPromo(offer) && !offer?.alreadyClaimed);

  return (
    <>
      {showPromo(offer) && (
        <Section title="Launch offer">
          <PromoRow offer={offer} purchase={purchase} />
        </Section>
      )}

      <Section title="Pay per job" note="No subscription. Credits never expire.">
        {includeFree && <ReadRow label="Free" value="2 projects, once" />}
        {ONE_TIME_PRODUCTS.map((product) => (
          <TierRow key={product.key} product={product} purchase={purchase} />
        ))}
      </Section>

      <Section title="Subscribe" note="Cancel anytime.">
        {SUBSCRIPTION_PRODUCTS.map((product) => (
          <SubscriptionRow
            key={product.key}
            product={product}
            purchase={purchase}
            big={product.key === 'studio_plus'}
            current={currentSubscriptionKey === product.key}
            accent={product.key === 'studio_plus' && studioPlusAccent}
          />
        ))}
        {enterpriseHref && <LinkRow label="Enterprise" value="Email us" href={enterpriseHref} />}
      </Section>

      {purchase.status && (
        <p
          className={`procta__msg ${purchase.status.kind === 'good' ? 'procta__msg--good' : 'procta__msg--bad'}`}
          style={{ marginTop: 'calc(var(--sp-7) * -1)', marginBottom: 'var(--sp-4)' }}
        >
          {purchase.status.text}
        </p>
      )}
    </>
  );
}
