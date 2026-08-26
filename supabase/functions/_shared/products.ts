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
// worst thing this app could do to somebody.
//
// PRICES ARE IN US CENTS, and the gateway is a merchant of record (Paddle),
// which means the buyer is charged in their own currency with their own tax on
// top. THE AMOUNT ON THE WEBHOOK WILL NOT EQUAL THE AMOUNT BELOW and it is not
// supposed to. That is why the grant is keyed to the PRICE ID and never to the
// amount: an amount check would fail for every buyer outside the US and would
// be, in effect, a randomly firing refusal to deliver something already paid
// for. The amount is recorded for the ledger, not used as a gate.
//
// APPEND ONLY. A key that has ever been sold stays in this table forever, even
// after it stops being offered, because a webhook that arrives late (Paddle
// retries for three days) still has to be able to look up what it granted.

export interface Product {
  /** Opaque, safe to expose, and what the ledger stores. */
  key: string;
  /** Projects unlocked per unit bought. Multiplied by the line quantity. */
  credits: number;
  /** US cents. Display and ledger only. See the header: NOT a gate. */
  amountCents: number;
  currency: "USD";
  label: string;
  /** Only sellable to somebody who has never bought before. */
  introOnly?: boolean;
}

export const PRODUCTS: Record<string, Product> = {
  // The way in. Five projects for five dollars is a rounding error against a
  // shoot budget, and the point of it is to be an obvious yes once, not to be
  // the best value per project forever.
  credits_intro_5: {
    key: "credits_intro_5",
    credits: 5,
    amountCents: 500,
    currency: "USD",
    label: "5 projects (first purchase)",
    introOnly: true,
  },
  // The standing price after that.
  credits_1: {
    key: "credits_1",
    credits: 1,
    amountCents: 300,
    currency: "USD",
    label: "1 project",
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
 * THE SUFFIX IS SHARED, THE PREFIX IS THE GATEWAY. `PADDLE_PRICE_INTRO_5` and
 * `STRIPE_PRICE_INTRO_5` are the same product at two gateways. Keeping the
 * mapping in one table rather than one per webhook is the whole point of this
 * file: the owner has changed gateway twice, and a third change should be a
 * new prefix, not a new copy of the price list.
 */
export const PRICE_ENV_SUFFIX_BY_PRODUCT: Record<string, string> = {
  credits_intro_5: "PRICE_INTRO_5",
  credits_1: "PRICE_CREDIT_1",
};

/** e.g. priceEnvName("credits_1", "STRIPE") -> "STRIPE_PRICE_CREDIT_1" */
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

/** Whether the introductory price may still be sold to this account. Checked
 *  at CHECKOUT time, server-side. The webhook does not enforce it: money that
 *  has already moved gets what it paid for, and a mismatch is logged instead. */
export function introEligible(creditsPurchasedTotal: number | null | undefined): boolean {
  return !creditsPurchasedTotal || creditsPurchasedTotal <= 0;
}

/** How many shot division uploads one project ever gets, unlocked or not.
 *
 *  This is the one cap that survives paying. Without it a single unlocked
 *  project is a lifetime subscription: keep one project forever, upload a new
 *  shot division for every shoot. Enforced in `breakdown`, per project, by the
 *  consume_project_breakdown RPC whose guard is in the WHERE clause. */
export const BREAKDOWNS_PER_PROJECT = 2;
