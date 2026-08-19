// The price list, server-side and nowhere else.
//
// THE ONE RULE IN THIS FILE: the amount NEVER comes from the client. The
// integration guide this was built from passes `{ amount, currency }` up from
// the browser, and that is the single most common way a payment integration
// gets robbed — anyone with devtools sends `amount: 100` and buys Pro for one
// rupee. The client sends a PLAN KEY and the server looks the price up here.
//
// Amounts are in PAISE, because that is what the Razorpay orders API takes.
// Razorpay's own floor is 100 paise (₹1); everything here is far above it, but
// the order function still checks, because a typo that drops a zero should fail
// loudly rather than quietly sell a month for eight rupees.

export interface Plan {
  /** What the client sends. Opaque, and safe to expose. */
  key: string;
  /** Paise. 100 paise = ₹1. */
  amount: number;
  currency: "INR";
  /** Shown in the Razorpay modal. */
  label: string;
  /** How long this purchase grants Pro for, in days. */
  grantDays: number;
}

export const PLANS: Record<string, Plan> = {
  // The $5/month tier, priced in rupees because the account, the gateway and
  // most of the early users are Indian. Razorpay settles INR; charging USD
  // needs international payments enabled on the account, which is a separate
  // activation.
  pro_monthly: {
    key: "pro_monthly",
    amount: 44900, // ₹449
    currency: "INR",
    label: "Clapper Pro — 1 month",
    grantDays: 31,
  },
  // Twelve months for the price of ten. The discount is the reason to offer it
  // at all: a shoot-driven tool has months where nobody opens it, and an annual
  // plan stops that month from being a cancellation.
  pro_yearly: {
    key: "pro_yearly",
    amount: 449000, // ₹4,490
    currency: "INR",
    label: "Clapper Pro — 12 months",
    grantDays: 366,
  },
};

/** Razorpay's own minimum. Anything under this is rejected by their API too. */
export const MIN_AMOUNT_PAISE = 100;

export function getPlan(key: unknown): Plan | null {
  if (typeof key !== "string") return null;
  return PLANS[key] ?? null;
}
