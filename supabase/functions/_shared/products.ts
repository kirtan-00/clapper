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
// from the subscription exactly as it was true of a credit bought one at a
// time: once spent on a project, the subscription's own state (active,
// cancelled, unpaid) never touches that project again.
//
// THE CATALOGUE, 2026-08-26. Credits changed from one-time only to a
// subscription plus a bundle:
//
//   pro_monthly   5 USD / month, recurring    2 credits on a normal renewal,
//                                              5 on the FIRST invoice only
//   bundle_5      20 USD, one time             5 credits
//   enterprise    not a product                contact link only, never
//                                              reaches this file or Stripe
//
// credits_intro_5 (5 for 5, one time) and credits_1 (1 for 3, one time) are
// GONE, not deprecated. The append-only rule below still holds for anything
// that was ever actually sold; neither of those two was ever deployed and
// no payment has ever touched either one, so removing them loses nothing.
//
// PRICES ARE IN US CENTS. Stripe is not a merchant of record here (see
// stripe-webhook/index.ts): the owner is the seller, buyers are charged in
// USD, and any sales tax collected is the owner's liability, not a gateway's.
// THE AMOUNT ON THE WEBHOOK WILL NOT NECESSARILY EQUAL THE AMOUNT BELOW once
// Stripe Tax or a currency-presentment feature is turned on, and that is why
// the grant is keyed to the PRICE ID, never to the amount. The amount is
// recorded for the ledger, not used as a gate.
//
// APPEND ONLY, going forward. A key that has ever been sold stays in this
// table forever, even after it stops being offered, because a webhook that
// arrives late (Stripe retries for three days, and a subscription's own
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
  /** US cents. Display and ledger only. See the header: NOT a gate. */
  amountCents: number;
  currency: "USD";
  label: string;
}

export const PRODUCTS: Record<string, Product> = {
  // The way in, and the standing price at once: there is only one price for
  // this, $5 a month, always. What changes is what the FIRST invoice grants,
  // and that decision is made by the webhook against billing_reason, never
  // by a second Stripe price or a coupon. See stripe-webhook/index.ts for why
  // that split is on our side rather than Stripe's.
  pro_monthly: {
    key: "pro_monthly",
    kind: "subscription",
    credits: 2,
    introCredits: 5,
    amountCents: 500,
    currency: "USD",
    label: "Clapper Pro, monthly",
  },
  // The one-time alternative for somebody who does not want a recurring
  // charge: five projects, paid once, never billed again.
  bundle_5: {
    key: "bundle_5",
    kind: "one_time",
    credits: 5,
    amountCents: 2000,
    currency: "USD",
    label: "5 project credits",
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
  bundle_5: "PRICE_BUNDLE_5",
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

// Enterprise is not a product. It never reaches this file, Stripe, or the
// webhook: it is a "contact us" link in the app's own copy, and the owner
// prices it by hand over email. Nothing here needs to know about it.
