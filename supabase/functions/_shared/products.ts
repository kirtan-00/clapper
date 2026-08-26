// The price list, server-side and nowhere else.
//
// THE ONE RULE, CARRIED OVER FROM plans.ts: the amount NEVER comes from the
// client, and neither does the number of credits. The client names a PRODUCT;
// the server decides what that costs and what it grants.
//
// WHAT A CREDIT IS. One credit unlocks ONE project, permanently. Not a month,
// not a subscription: a project that has been unlocked keeps PDF export,
// Premiere XML export, shot division upload and the folder feature for good.
// People come back to a wrapped shoot at edit time, months later, and a
// project that fell back behind a paywall in the meantime would be the single
// worst thing this app could do to somebody. This is true of a credit bought
// from a subscription exactly as it was true of a credit bought one at a
// time: once spent on a project, the subscription's own state (active,
// cancelled, unpaid) never touches that project again.
//
// THE CATALOGUE, 2026-08-27. Repriced in INR and split into two meters that
// live on the SAME subscription (see podcastMinutesForPlan below):
//
//   Director mode (metered by PROJECTS - see claim_project_access):
//     free           2 projects, one-time (see FREE_PROJECT_RESET_DAYS)
//     credit_1       INR 699, one time      1 credit
//     bundle_5       INR 2,399, one time    5 credits
//     pro_monthly    INR 999 / month        6 credits on a normal renewal,
//                    ("Studio")             6 on the first invoice too -
//                                           see the introCredits note below
//     studio_plus    INR 2,499 / month      20 credits on a normal renewal,
//                                           20 on the first invoice too
//     enterprise     not a product          contact link only, never reaches
//                                           this file or a payment gateway
//
//   Podcast mode (metered by ROLL TIME, seconds - see consume_podcast_seconds
//   and podcastMinutesForPlan; nothing calls the RPC yet, see that migration's
//   header for why):
//     free           3 hours / month   PODCAST_MINUTES_FREE_PER_MONTH
//     pro_monthly    20 hours / month  PODCAST_MINUTES_STUDIO_PER_MONTH
//     studio_plus    60 hours / month  PODCAST_MINUTES_STUDIO_PLUS_PER_MONTH
//
// pro_monthly and studio_plus are ONE subscription each, carrying BOTH
// meters at once - there is no separate "podcast subscription". A pricing
// PAGE may split the two meters by persona so a film crew never reads the
// podcast numbers, but the underlying grant is one purchase, one product key.
//
// KEY CONTINUITY OVER RENAMING. `pro_monthly` is kept as the dictionary key
// for what is now sold as "Studio", rather than renamed, because another
// agent's checkout lane may already reference it (env var
// STRIPE_PRICE_PRO_MONTHLY / PADDLE_PRICE_PRO_MONTHLY, webhook metadata, a
// live purchases.product_key value) and the append-only rule below exists
// exactly to protect that. The catalogue's `label` is what changed, not the
// key. One consequence worth a human eye: a hypothetical in-flight invoice
// still tagged with the old `credits: 2` expectation now grants 6 instead -
// owner-favorable-to-the-user, and the only direction repricing an existing
// key can silently break in.
//
// INTRO BONUS: SET EQUAL TO THE MONTHLY GRANT, NOT GUESSED AT. The prior
// catalogue gave a bonus above the renewal amount (5 vs 2, a 2.5x multiple)
// on the theory that a big first month sells the plan. The new pricing pass
// did not restate that ratio, and manufacturing 15 / 50 out of thin air is
// exactly the kind of "helpful" rounding the brief warned against. So
// introCredits equals credits for both subscription products until the owner
// says otherwise: a first invoice grants exactly the stated monthly amount,
// no more. The mechanism (grantSubscriptionCredits,
// subscription_intro_bonus_granted) is untouched and will honor a real bonus
// the moment either number changes.
//
// credits_intro_5 (5 for 5, one time) and credits_1 (1 for 3, one time) are
// GONE, not deprecated. The append-only rule below still holds for anything
// that was ever actually sold; neither of those two was ever deployed and
// no payment has ever touched either one, so removing them loses nothing.
//
// PRICES ARE IN MINOR UNITS OF THE CURRENCY - cents for USD, paise for INR.
// A payment gateway is not a merchant of record here (see
// stripe-webhook/index.ts): the owner is the seller, buyers are charged in
// the currency below, and any sales tax collected is the owner's liability,
// not a gateway's. THE AMOUNT ON THE WEBHOOK WILL NOT NECESSARILY EQUAL THE
// AMOUNT BELOW once a currency-presentment feature is turned on, and that is
// why the grant is keyed to the PRICE ID, never to the amount. The amount is
// recorded for the ledger, not used as a gate.
//
// APPEND ONLY, going forward. A key that has ever been sold stays in this
// table forever, even after it stops being offered, because a webhook that
// arrives late (a gateway retries for days, and a subscription's own
// invoices keep citing the same price id for as long as it is billed) still
// has to be able to look up what it granted.

export type ProductKind = "subscription" | "one_time";

export interface Product {
  /** Opaque, safe to expose, and what the ledger stores. */
  key: string;
  kind: ProductKind;
  /** For `subscription`: credits granted on a STANDARD renewal invoice
   *  (billing_reason = subscription_cycle). For `one_time`: credits granted
   *  per unit bought. Either way this is the only place a credit count is
   *  allowed to come from. */
  credits: number;
  /** `subscription` only. Credits granted on the FIRST invoice of a new
   *  subscription (billing_reason = subscription_create), IN PLACE OF
   *  `credits`, and only once per account ever - see the migration's
   *  subscription_intro_bonus_granted column and
   *  grant_subscription_invoice_credits. Absent on a one_time product. */
  introCredits?: number;
  /** Minor units (cents for USD, paise for INR). Display and ledger only.
   *  See the header: NOT a gate. */
  amountCents: number;
  currency: "USD" | "INR";
  label: string;
}

export const PRODUCTS: Record<string, Product> = {
  // Kept at its original key for continuity (see header). Sold today as
  // "Clapper Studio": one subscription, both meters.
  pro_monthly: {
    key: "pro_monthly",
    kind: "subscription",
    credits: 6,
    introCredits: 6,
    amountCents: 99900,
    currency: "INR",
    label: "Clapper Studio, monthly",
  },
  // The heavier subscription tier, new 2026-08-27. Priced so a single tier
  // clearly beats the five-project pack for anyone doing more than two
  // projects a month (INR 166/project here vs INR 480/project in bundle_5),
  // while leaving Studio as the one tier that covers the median individual
  // user without an obvious upsell sitting right above it.
  studio_plus: {
    key: "studio_plus",
    kind: "subscription",
    credits: 20,
    introCredits: 20,
    amountCents: 249900,
    currency: "INR",
    label: "Clapper Studio Plus, monthly",
  },
  // Kept at its original key for continuity (see header). Repriced from its
  // original USD listing; credits unchanged.
  bundle_5: {
    key: "bundle_5",
    kind: "one_time",
    credits: 5,
    amountCents: 239900,
    currency: "INR",
    label: "5 project credits",
  },
  // NEW 2026-08-27: the single-credit option that did not exist in the
  // previous catalogue (credits_1 was removed unsold; this is a fresh key,
  // not a revival of that one).
  credit_1: {
    key: "credit_1",
    kind: "one_time",
    credits: 1,
    amountCents: 69900,
    currency: "INR",
    label: "1 project credit",
  },
};

export function getProduct(key: unknown): Product | null {
  if (typeof key !== "string") return null;
  return PRODUCTS[key] ?? null;
}

/**
 * Price id to product key.
 *
 * A gateway's price ids are minted inside the owner's account on that gateway
 * and differ between sandbox and live, so they CANNOT be hardcoded here. They
 * come from the environment, one variable per product per gateway, and an id
 * that matches nothing is a refusal to guess: the purchase gets recorded with
 * status `unknown_product`, grants nothing, and surfaces in the dashboard
 * panel. A webhook that quietly picked "probably the cheap one" would be a bug
 * that pays out in either direction.
 *
 * THE SUFFIX IS SHARED, THE PREFIX IS THE GATEWAY. `PADDLE_PRICE_PRO_MONTHLY`
 * and `STRIPE_PRICE_PRO_MONTHLY` are the same product at two gateways.
 * Keeping the mapping in one table rather than one per webhook is the whole
 * point of this file.
 */
export const PRICE_ENV_SUFFIX_BY_PRODUCT: Record<string, string> = {
  pro_monthly: "PRICE_PRO_MONTHLY",
  studio_plus: "PRICE_STUDIO_PLUS",
  bundle_5: "PRICE_BUNDLE_5",
  credit_1: "PRICE_CREDIT_1",
};

/** e.g. priceEnvName("bundle_5", "STRIPE") -> "STRIPE_PRICE_BUNDLE_5" */
export function priceEnvName(productKey: string, gatewayPrefix: string): string | null {
  const suffix = PRICE_ENV_SUFFIX_BY_PRODUCT[productKey];
  return suffix ? `${gatewayPrefix}_${suffix}` : null;
}

export function productForPriceId(
  priceId: unknown,
  env: (name: string) => string | undefined,
  gatewayPrefix: string,
): Product | null {
  if (typeof priceId !== "string" || !priceId) return null;
  for (const key of Object.keys(PRICE_ENV_SUFFIX_BY_PRODUCT)) {
    const envName = priceEnvName(key, gatewayPrefix);
    if (!envName) continue;
    const configured = env(envName);
    if (configured && configured === priceId) return PRODUCTS[key] ?? null;
  }
  return null;
}

/** How many shot division uploads one project ever gets, unlocked or not.
 *
 *  This is the one cap that survives paying, subscription or bundle alike.
 *  Without it a single unlocked project is a lifetime subscription on its
 *  own: keep one project forever, upload a new shot division for every
 *  shoot. Enforced in `breakdown`, per project, by the
 *  consume_project_breakdown RPC whose guard is in the WHERE clause. */
export const BREAKDOWNS_PER_PROJECT = 2;

// ---------------------------------------------------------------------------
// Director mode: the free project grant
// ---------------------------------------------------------------------------

/** How many projects a free account gets Script Mode access on before every
 *  further project needs a credit. Enforced by claim_project_access in
 *  supabase/migrations/20260827120000_project_metering.sql. Does NOT gate
 *  PDF or Premiere/Resolve export - see EXPORT_FORMATS_REQUIRING_UNLOCK. */
export const FREE_PROJECT_LIMIT = 2;

/**
 * THE ONE-LINE FLIP. 0 means the free grant in FREE_PROJECT_LIMIT never
 * refills - the owner's explicit, current instruction. Set this to 30 (or
 * whatever period is decided) to make it a monthly refill instead: that is
 * the ONLY change needed anywhere, database included - claim_project_access
 * already takes the period length as a parameter and reads 0 as "never
 * reset". No RPC signature changes, no new migration, no edge function edit.
 *
 * Two independent pricing passes recommended a monthly refill on the grounds
 * that a permanent dead end lands the paywall exactly when a returning user
 * is busiest. The owner has not overruled his original "never refills"
 * instruction in so many words, so this ships at 0. Flip it here when he
 * decides.
 */
export const FREE_PROJECT_RESET_DAYS = 0;

/** Exports that require the PROJECT to be unlocked (a credit spent via
 *  unlock_project). CSV is deliberately absent: it is free and uncounted for
 *  every signed-in account, unlocked project or not - see decideExport in
 *  _shared/gate.ts. This is the format list that changed meaning most in the
 *  2026-08-27 rework: these used to be per-format lifetime counters
 *  (`premiere: 2`, `pdf: 5`); now they are a single yes/no per project, with
 *  no counter at all once a project says yes. */
export const EXPORT_FORMATS_REQUIRING_UNLOCK = ["pdf", "premiere"] as const;

// ---------------------------------------------------------------------------
// Podcast mode: roll-time minutes per subscription tier
// ---------------------------------------------------------------------------
// See the header of 20260827120000_project_metering.sql: consume_podcast_
// seconds exists and is enforcement-ready, but nothing calls it yet because
// no part of this codebase currently times a recording and reports it to the
// server. These numbers are therefore read by the Account screen for display
// (an honest "0 of N hours used" until that wiring exists) and are what the
// RPC's p_limit_seconds should be computed from once a caller exists.

/** Free tier, minutes per month. Unlike the project grant this refills every
 *  period unconditionally - podcast time is a consumable resource, not a
 *  one-time unlock, so there is no "reset days" flip to make here. */
export const PODCAST_MINUTES_FREE_PER_MONTH = 180; // 3 hours
export const PODCAST_MINUTES_STUDIO_PER_MONTH = 1200; // 20 hours
export const PODCAST_MINUTES_STUDIO_PLUS_PER_MONTH = 3600; // 60 hours

/** How often the podcast-minutes counter resets. Always monthly - see
 *  consume_podcast_seconds' p_period_days. */
export const PODCAST_RESET_DAYS = 30;

/**
 * Minutes of podcast roll time this account gets in the current period, off
 * which subscription product (if any) is active. `product` is
 * profiles.subscription_product; `active` should reflect
 * profiles.subscription_status being a paying state (not e.g. 'canceled').
 * An unrecognized or missing product with `active: true` reads as free tier
 * rather than throwing - money that has not resolved to a known plan must
 * never grant more than the safe default.
 */
export function podcastMinutesForPlan(product: string | null | undefined, active: boolean): number {
  if (active && product === "studio_plus") return PODCAST_MINUTES_STUDIO_PLUS_PER_MONTH;
  if (active && product === "pro_monthly") return PODCAST_MINUTES_STUDIO_PER_MONTH;
  return PODCAST_MINUTES_FREE_PER_MONTH;
}

// Enterprise is not a product. It never reaches this file, a payment
// gateway, or the webhook: it is a "contact us" link in the app's own copy,
// negotiated by hand over email. Nothing here needs to know about it.
