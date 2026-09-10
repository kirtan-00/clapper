// The block-level furniture for "what does Clapper cost" - shared by
// ProCta's inline paywall and AccountScreen's standing pricing table so the
// two surfaces are, structurally, the same list of plan blocks rendered in
// two places.
//
// TWO CORRECTIONS, SAME DAY (2026-08-31). The owner saw a first pass built
// on this app's existing grouped-inset LIST vocabulary (hairline rows
// inside one shared card, `glist.tsx`'s `Row`/`ReadRow`) and said "I don't
// think even I would pay with that UI" - a complaint about persuasion, not
// shape, and that pass fixed the WORDS: a lede up top (wedge, permanence,
// generosity), the hero moved from Studio Plus to Studio, savings stated
// against the Rs 699 anchor. The words are unchanged here.
//
// The owner then saw THAT and said it a second time, differently: "this
// looks bad, the UI needs to be blocky like an app." That is a complaint
// about SHAPE - thin divider rows sharing one bordered container reads as
// an editorial list (a webpage), not as the app. This file answers that:
// every tier is now its OWN rounded, filled, padded block (`PlanCard`
// below), with a real gap between blocks, built on the EXACT surface/press
// vocabulary `.btn` already uses elsewhere in this app for "a control you
// press" (styles.css, ~line 1385: SECONDARY is an unfilled surface with an
// inset hairline; PRIMARY is a solid slab in the one accent colour; flat,
// no bevel, no gradient, no lift; rank is carried by FILL, not by a shape
// nobody else on the screen has). The recommended tier (Studio, "Our pick")
// takes the PRIMARY treatment - a solid accent fill, teal on day / acid on
// night - exactly the way this app's own "Start shoot" / "Create project"
// buttons already read as the one thing to press. Every other tier takes
// the SECONDARY treatment: the app's own surface, a hairline, full-strength
// ink.
//
// THE SELL ITSELF DID NOT CHANGE. `PricingLede` (the wedge - Premiere XML -
// and the permanence pitch - unlock once, own it forever), the savings
// numbers against the Rs 699 anchor, "Pay per job" vs "Subscribe & save",
// and the trust line are all the same copy this file shipped a few hours
// earlier in the day. Only the CONTAINER changed.

import { ExternalMark } from './glist';
import type { ReactNode } from 'react';
import type { Product } from '../../supabase/functions/_shared/products';
import type { PromoOffer } from '../net/pay';
import { FREE_PROJECT_LIMIT, FREE_PREMIERE_PROJECTS } from '../net/quota';
import {
  tierLabel,
  tierValue,
  showPromo,
  savingsPercent,
  perProjectCost,
  ONE_TIME_PRODUCTS,
  SUBSCRIPTION_PRODUCTS,
  JUMPSTART_PRODUCT_KEY,
  type Purchase,
  type TierValue,
} from './pricing';
import './PricingRows.css';

/**
 * The sticker price and its qualifier, stacked and right-aligned inside a
 * card's value column - "Rs 999" over "per month, Rs 166 each". Unchanged
 * in substance from the row-era `ValueStack` this replaces: same swap-only-
 * the-top-line busy state (a card must not change height the instant
 * someone taps it), same tabular sticker. Restyled through CSS classes
 * (`.pr-card__sticker` / `.pr-card__qualifier`) instead of inline styles
 * because a card has room to let the qualifier wrap if it ever needs to -
 * the old inline `whiteSpace: 'nowrap'` was a fix for a THIN ROW running out
 * of width next to a label fighting it for space, which is not a problem a
 * generously padded, full-width block has. The sticker line stays `nowrap`
 * in CSS regardless (a price is one unbreakable run), it just no longer
 * needs an inline escape hatch to say so.
 */
function PriceStack(props: { value: TierValue; busy?: boolean }) {
  return (
    <span className="pr-card__stack">
      <span className={props.busy ? 'pr-card__sticker' : 'pr-card__sticker tnum'}>
        {props.busy ? 'Working…' : props.value.sticker}
      </span>
      <span className="pr-card__qualifier">{props.value.detail}</span>
    </span>
  );
}

/**
 * ONE BLOCK, EVERY TIER. Free, 1 credit, 5 credits, Studio, Studio Plus and
 * the launch offer all render through this - the shape is identical, only
 * the face (`solid`) and the interactivity (`onClick` vs `isStatic`)
 * change. That sameness is the point: five separately-styled cards would
 * have drifted the moment one of them needed a fix, the same failure mode
 * the row-era `Row`/`ReadRow`/`SubscriptionRow` split was already correcting
 * for once, just at the wrong altitude.
 *
 * TWO FACES, BORROWED FROM `.btn` (styles.css), NOT INVENTED HERE:
 *   SECONDARY (default) - `var(--surface)` fill, an inset hairline
 *     (`box-shadow: inset 0 0 0 1.5px var(--hairline)`, the same "border
 *     that does not eat the content box" trick `.btn` uses), full ink.
 *   PRIMARY (`solid`) - a solid slab of `var(--m-accent)` (teal on day,
 *     acid on night), `var(--m-accent-ink)` type, no hairline - the fill
 *     IS the rank signal, a border under it would read as a hairline
 *     fighting its own slab, which is `.btn--go`'s own comment, verbatim.
 * Press steps the fill one shade (`--surface-sunk` / `--m-accent-press`),
 * nothing moves, nothing lifts - `.btn`'s own "FLAT. No 3D, no bevel, no
 * gradient" rule, unchanged for a bigger control.
 *
 * `isStatic` renders a `<div>`, not a `<button>` - for the Free tier
 * (nothing to tap), an already-claimed launch offer, and an account's own
 * current subscription ("Your plan"). No press state, no disabled dimming,
 * because none of those three are ever mid-purchase.
 */
function PlanCard(props: {
  name: string;
  /** "Our pick" - a small word after the name, never a pill: the card's
   *  own solid fill already carries the "this is the one" signal, this
   *  only makes sure that signal is not colour-alone (a11y) and gives it a
   *  name a screen reader also gets. */
  pick?: boolean;
  subline?: string;
  value: ReactNode;
  solid?: boolean;
  isStatic?: boolean;
  disabled?: boolean;
  onClick?: () => void;
}) {
  const { name, pick, subline, value, solid, isStatic, disabled, onClick } = props;
  const className = solid ? 'pr-card pr-card--solid' : 'pr-card';

  const face = (
    <>
      <div className="pr-card__row">
        <span className="pr-card__name">
          {name}
          {pick && <span className="pr-card__pick">Our pick</span>}
        </span>
        <span className="pr-card__value">{value}</span>
      </div>
      {subline && <p className="pr-card__subline">{subline}</p>}
    </>
  );

  if (isStatic || !onClick) {
    return (
      <div className={className} data-static="">
        {face}
      </div>
    );
  }

  return (
    <button type="button" className={className} disabled={disabled} onClick={onClick}>
      {face}
    </button>
  );
}

/** Just "Studio" / "Studio Plus" - the plan name and nothing else, the
 *  credit count carried in the subline instead (see `subscriptionSubline`).
 *  A card has room for a longer name than a 320px row ever did, but there
 *  is still nothing this name needs to say that the subline says better. */
function subscriptionName(product: Product): string {
  return product.key === 'studio_plus' ? 'Studio Plus' : 'Studio';
}

/**
 * The one prose line under a subscription's name: what the money buys, said
 * the same way for both tiers so the ladder frames its value evenly rather
 * than only one tier earning a subline. One or two sentences, never a
 * bulleted feature list - the dash-bulleted look is named by hand in
 * ProCta.tsx's header as the AI-default this must not read as.
 *
 * THE SAVING NUMBER. `savingsPercent` (pricing.ts) reads the same
 * `PER_PROJECT_DISPLAY` table `tierValue`'s own per-project figure already
 * does, so a subscriber sees the ANCHOR ("what a one-off costs") and the
 * ARGUMENT ("how much less this is than that") on the same card.
 *
 * `accent`: the one sentence that explains WHY this is the recommended
 * card, not just what it costs - only ever true for whichever product
 * `PricingLadder` has handed the accent to, so this never says it twice.
 */
function subscriptionSubline(product: Product, accent: boolean): string {
  const credits = `${product.credits} project credits`;
  const savings = savingsPercent(product);
  const rate = savings !== undefined ? `, about ${savings}% cheaper than paying per project` : '';
  if (product.key === 'studio_plus') {
    return `${credits}${rate}. Plus your own logo on every export.`;
  }
  const why = accent ? ' Built for a normal month of shoots.' : '';
  return `${credits}${rate}.${why}`;
}

/** The subline for a one-time credit pack - "About 31% cheaper than paying
 *  one at a time" for anything that buys more than one credit, nothing for
 *  `credit_1` itself (there is nothing to save against the thing that IS
 *  the reference rate). `savingsPercent` returns `undefined` for exactly
 *  that case, which is what makes this a plain pass-through rather than a
 *  second place that has to know which key is the baseline. */
function oneTimeSubline(product: Product): string | undefined {
  const savings = savingsPercent(product);
  if (savings === undefined) return undefined;
  return `About ${savings}% cheaper than paying one at a time.`;
}

/** A one-time credit pack: `credit_1` or `bundle_5`, plain SECONDARY cards -
 *  the "pay per job" ladder is deliberately the quieter half of the screen,
 *  see `PricingLadder`'s own header. */
function TierCard(props: { product: Product; purchase: Purchase }) {
  const { product, purchase } = props;
  const busy = purchase.busyKey === product.key;
  return (
    <PlanCard
      name={tierLabel(product)}
      subline={oneTimeSubline(product)}
      value={<PriceStack value={tierValue(product)} busy={busy} />}
      disabled={purchase.busyKey !== null}
      onClick={() => void purchase.buy(product)}
    />
  );
}

/** The always-free tier. A card because everything on this screen is a
 *  card now, `isStatic` because there is nothing to tap - free is not a
 *  purchase decision. */
function FreeCard() {
  return (
    <PlanCard
      name="Free"
      // `FREE_PROJECT_LIMIT` is a literal-typed const, so the pluralize
      // guard is read through a `number` widening rather than compared
      // against the literal (which TS rightly calls a dead branch). This
      // replaced a hardcoded "2 projects" that would have quietly lied the
      // day that constant changed.
      value={`${FREE_PROJECT_LIMIT} project${(FREE_PROJECT_LIMIT as number) === 1 ? '' : 's'}, once`}
      isStatic
    />
  );
}

/** A subscription tier - Studio or Studio Plus. `accent` gives it the
 *  PRIMARY (solid-fill) face and the "Our pick" marker together, always
 *  paired (see `PlanCard`'s own header on why a border-only accent was
 *  never really the plan once the container itself became a card: a solid
 *  fill IS what "the one that matters" looks like in this app's own button
 *  language). `current` swaps the value column for a static "Your plan" and
 *  renders the whole card as non-interactive, whichever face it would
 *  otherwise have worn. */
function SubscriptionCard(props: {
  product: Product;
  purchase: Purchase;
  accent?: boolean;
  current?: boolean;
}) {
  const { product, purchase, accent, current } = props;
  const busy = purchase.busyKey === product.key;
  return (
    <PlanCard
      name={subscriptionName(product)}
      pick={!!accent}
      subline={subscriptionSubline(product, !!accent)}
      value={current ? 'Your plan' : <PriceStack value={tierValue(product)} busy={busy} />}
      solid={!!accent}
      isStatic={current}
      disabled={purchase.busyKey !== null}
      onClick={current ? undefined : () => void purchase.buy(product)}
    />
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
 * The launch offer card, or nothing. `null` from the promo read, or a state
 * where the ten are gone and this account never had one, both render
 * nothing - see `showPromo`'s own note on why a button guaranteed to fail
 * is worse than no button. Solid-filled while it is actually buyable, the
 * same PRIMARY face `SubscriptionCard` gives Studio - this and Studio's
 * accent are handed off, never both live at once, see `PricingLadder`'s own
 * header for the rule. */
function PromoCard(props: { offer: PromoOffer | null; purchase: Purchase }) {
  const { offer, purchase } = props;
  if (!showPromo(offer)) return null;
  const o = offer!;

  if (o.alreadyClaimed) {
    return <PlanCard name="Launch offer" value="Already used" isStatic />;
  }

  const label = !o.signedIn
    ? 'Launch offer, first 10 accounts only'
    : `Launch offer, ${o.remaining} of ${o.slots} left`;

  const busy = purchase.busyKey === JUMPSTART_PRODUCT_KEY;
  const product = jumpstartProduct(o);

  return (
    <PlanCard
      name={label}
      value={<PriceStack value={tierValue(product)} busy={busy} />}
      solid
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
 * THE SELL, BEFORE THE PRICES. Nobody reads a price ladder as a reason to
 * buy; they read it to check the number against a decision they have
 * already half-made. This makes that decision for them, in three short
 * sentences, before the ladder gets a chance to look like a bill:
 *
 *   1. THE WEDGE. Premiere XML is the format the app's own gate logic
 *      already treats as the killer feature - see gate.ts's
 *      FREE_PREMIERE_PROJECTS header ("the format... real exporters
 *      actually chose"), which is WHY it is free on an account's first
 *      projects at all. Leading with it here says the same thing to a
 *      human that the free taste already says to the product.
 *   2. THE PERMANENCE. "Unlock once, own it forever" is the single most
 *      underused fact in the catalogue - see products.ts's own "WHAT A
 *      CREDIT IS" header. A buyer comparing this to a subscription-only
 *      competitor needs to hear it before the price, not discover it by
 *      reading the fine print after paying.
 *   3. THE GENEROSITY. Rolling and the CSV shot log are unlimited and free
 *      for everyone, unlock or not - true on this screen exactly as it is
 *      on GoProRow's own note in Settings. Saying it here reframes every
 *      card below as "unlock more," not "pay to use the app at all," which
 *      matters most on ProCta's cap-hit paywall, the one place this text
 *      also renders to someone who just got told no.
 *
 * PROSE, NOT A CARD. No icon, no illustration, no gradient panel - the
 * `--t-title` / `--t-secondary` pairing `.ltitle` and `.glist-note` already
 * use elsewhere in this app, stacked as two plain paragraphs above the
 * first block. The screen below is now all rounded blocks; the one sales
 * pitch above them stays plain text on purpose, so it reads as the app
 * talking to you rather than as a sixth thing for sale.
 *
 * RENDERED UNCONDITIONALLY, both call sites (ProCta's cap-hit gate and
 * AccountScreen's standing ladder) - the wedge and the permanence pitch are
 * true regardless of which counter someone just ran out of. */
function PricingLede() {
  return (
    <div className="pr-lede">
      <p className="pr-lede__head">Premiere XML, straight onto your timeline.</p>
      <p className="pr-lede__body">
        Free on your first {FREE_PREMIERE_PROJECTS} projects. After that, one credit unlocks a
        project for good - PDF, Premiere, Resolve, the folder, all of it - so you can reopen it
        and export again months later at no extra cost. Rolling and the CSV shot log never cost
        anything, unlocked or not.
      </p>
    </div>
  );
}

/** One labelled group of cards - a header outside the stack, a real gap
 *  (`.pr-stack`) between the cards inside it, an optional footnote under
 *  it. Replaces the row-era `Section` (glist.tsx) for this screen only:
 *  `Section` wraps its children in ONE shared `.glist-card` with hairline
 *  rules between them, which is exactly the "one bordered container" shape
 *  the owner rejected. `glist.tsx` itself is untouched - Settings, Home and
 *  every other grouped-inset list in the app still wants that shape, this
 *  screen no longer does. `.glist-hdr` / `.glist-note` (list.css) are still
 *  the right typographic voice for a caption above and a footnote below a
 *  group of controls, so those two classes carry over unchanged; only the
 *  middle - what actually holds the controls - is new. */
function Group(props: { title?: string; note?: ReactNode; children: ReactNode }) {
  return (
    <section className="glist">
      {props.title && <h2 className="glist-hdr">{props.title}</h2>}
      <div className="pr-stack">{props.children}</div>
      {props.note && <p className="glist-note">{props.note}</p>}
    </section>
  );
}

/**
 * THE WHOLE LADDER, as blocks in two labelled groups rather than a flat
 * list or one shared card. A buyer is not choosing between five things,
 * they are answering one question - pay per job, or subscribe - so the
 * surface still asks it that way; only the container under each answer
 * changed shape today. Order a reader should consider them, unchanged:
 *
 *   1. The launch offer, ABOVE EVERYTHING, only while it is actually
 *      buyable for this viewer (see `showPromo` - null and "the ten are
 *      gone" both render nothing here, same as `PromoCard` alone).
 *   2. "Pay per job" - Free, 1 credit, 5 credits. Plain SECONDARY cards,
 *      no subscription, so it stays first for anyone who came here
 *      undecided, AND it is what puts the Rs 699 anchor in front of a
 *      reader before Studio's Rs 166 reveal one group down - the saving
 *      argument needs something to save against.
 *   3. "Subscribe & save" - Studio, then Studio Plus. The section title
 *      itself carries half the pitch: a reader who has just seen Rs 699
 *      and Rs 480 lands on a heading that tells them, before a single
 *      card, that what follows is cheaper still.
 *
 * `currentSubscriptionKey` is AccountScreen-only (it has entitlements to
 * check); ProCta's cap-hit paywall omits it; passing nothing here just
 * means no card ever renders as "Your plan", never a wrong one.
 *
 * THE ONE ACCENT, HANDED OFF RATHER THAN DOUBLED, POINTED AT STUDIO.
 * `PromoCard` already takes the solid PRIMARY face for as long as the
 * launch offer is actually buyable - see its own comment. `heroAccent`
 * below is true exactly when that is NOT happening: `showPromo(offer)`
 * false (no offer, or the ten are gone and this account never had one), or
 * true but `alreadyClaimed` (the offer renders as a plain "Already used"
 * static card, no fill, nothing accented). Only one of "the promo card" and
 * "the Studio card" is ever solid-filled at a time - stacking both would
 * put two acid slabs on the same night screen at once (`--m-accent` and
 * `--brass`-derived fills are the identical hue there), which is the one
 * thing "exactly one" rules out.
 *
 * WHY STUDIO, NOT STUDIO PLUS. The brief's own instruction is to anchor on
 * the tier that "covers the median user" (Rs 166/project, six projects a
 * month), which launch/PRICE-SHEET.md's own research independently names
 * as the plan sized for a regular working crew member, with Studio Plus
 * reserved for the smaller ad-circuit slice doing fifteen to twenty jobs a
 * month. Recommending the cheaper, broader-fit plan by default is also the
 * honest read of "chosen, on-brand" rather than "whichever costs more" -
 * Studio Plus is still one card down, still real, still explains its own
 * one true differentiator (the logo) in its own subline. */
export function PricingLadder(props: {
  offer: PromoOffer | null;
  purchase: Purchase;
  includeFree?: boolean;
  enterpriseHref?: string;
  currentSubscriptionKey?: string | null;
}) {
  const { offer, purchase, includeFree, enterpriseHref, currentSubscriptionKey } = props;
  const heroAccent = !(showPromo(offer) && !offer?.alreadyClaimed);

  // The Rs 699 anchor, spent a second time. `ONE_TIME_PRODUCTS` is
  // `[credit_1, bundle_5]` (DISPLAY_ORDER, pricing.ts) - this finds
  // whichever one buys more than one credit rather than hardcoding the key,
  // so a future third pack does not silently fall out of this sentence.
  // Reads the same `savingsPercent`/`perProjectCost` the Subscribe group's
  // sublines do, so the two halves of the page can never disagree with each
  // other about what a bundle actually saves.
  const bundle = ONE_TIME_PRODUCTS.find((p) => p.credits > 1);
  const payPerJobNote = bundle
    ? `No subscription. Credits never expire, and an unlocked project stays unlocked forever. Buy ${bundle.credits} at once and it works out to Rs ${perProjectCost(bundle)} a project, about ${savingsPercent(bundle)}% less than one at a time.`
    : 'No subscription. Credits never expire, and an unlocked project stays unlocked forever.';

  return (
    <>
      <PricingLede />

      {showPromo(offer) && (
        <Group title="Launch offer">
          <PromoCard offer={offer} purchase={purchase} />
        </Group>
      )}

      <Group title="Pay per job" note={payPerJobNote}>
        {includeFree && <FreeCard />}
        {ONE_TIME_PRODUCTS.map((product) => (
          <TierCard key={product.key} product={product} purchase={purchase} />
        ))}
      </Group>

      {/* The trust cue rides the Subscribe note - a group footnote, under
          the cards, that adds no card of its own. One quiet line naming who
          takes the money is what turns a stack of tappable prices into
          something that reads as a real checkout rather than raw buttons;
          it shows on the standing pricing table and on ProCta's cap-hit
          paywall alike, since both render this same group. No logo, no
          badge - the app draws none of its own chrome and a payment-brand
          lockup would be the first.

          "Even if you cancel" - the two facts most competitors let a buyer
          assume are the same thing and are not: cancelling a subscription
          stops the NEXT charge, it does not repossess a project already
          unlocked with a credit that subscription paid for (see
          products.ts's own header: "once spent on a project, the
          subscription's own state... never touches that project again").
          Saying it here removes the one objection a burst-shaped buyer (see
          launch/PRICING-PSYCHOLOGY.md's own section on this product's
          bursty usage) would otherwise have to go dig for in a FAQ. */}
      <Group
        title="Subscribe & save"
        note="Cancel anytime. Projects you have already unlocked stay unlocked, even after you cancel. Payments are handled securely by Razorpay."
      >
        {SUBSCRIPTION_PRODUCTS.map((product) => (
          <SubscriptionCard
            key={product.key}
            product={product}
            purchase={purchase}
            accent={product.key === 'pro_monthly' && heroAccent}
            current={currentSubscriptionKey === product.key}
          />
        ))}
        {/* Enterprise is not a fifth block: it is a contact link, not a
            priced tier, and giving it the same rounded-card weight as
            Studio or Studio Plus would sell a product that does not exist
            in this table (see products.ts's own "Enterprise is not a
            product" closing note). A small text link under the cards, the
            same `ExternalMark` glyph every other outbound link in this app
            uses (glist.tsx), says "there is one more option" without
            pretending it is priced the same way the two above it are. */}
        {enterpriseHref && (
          <a className="pr-enterprise" href={enterpriseHref} target="_blank" rel="noopener">
            Enterprise, email us
            <ExternalMark />
          </a>
        )}
      </Group>

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
