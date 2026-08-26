import { describe, it, expect } from 'vitest';
import {
  applyCreditPurchase,
  applySubscriptionCredit,
  NEEDS_ATTENTION_STATUSES,
  type CreditPurchase,
  type EntitlementStore,
  type SubscriptionInvoiceGrant,
} from '../../supabase/functions/_shared/entitlements.ts';

// Idempotency, tested against a fake that implements the SAME conditional
// semantics the database does. Paddle retries a failed delivery up to 60 times
// over three days and a manual replay reuses the event id, so "the same event
// arrives twice" is the normal case, not the edge case. Granting five projects
// twice for one payment is a silent, direct loss.
//
// The fake below is written to be honest about the one thing that matters:
// `claimPurchase` is a single conditional update whose guard is in the WHERE
// clause, so it returns a row to exactly one caller and null to every other.
// A fake that just returned the row every time would make these tests pass
// while proving nothing.

interface Row {
  provider: string;
  eventId: string;
  userId: string | null;
  txnId: string | null;
  productKey: string | null;
  credits: number;
  status: string;
  note: string | null;
}

function fakeStore(opts?: { addCreditsFails?: string; startingBalance?: number }) {
  const rows = new Map<string, Row>();
  /** Stands in for the purchases_txn_idx unique index. */
  const txnSeen = new Set<string>();
  const balances = new Map<string, number>();
  const events: { name: string; userId: string | null; props: Record<string, unknown> }[] = [];
  const calls = { record: 0, claim: 0, addCredits: 0, finish: 0, grantSubscription: 0 };
  // Stands in for profiles.subscription_intro_bonus_granted: a flag on the
  // ACCOUNT, set once, never cleared. This is the thing under test in the
  // "bonus is unrepeatable" suite below - a fake that just returned the
  // bonus every time would make those tests pass while proving nothing,
  // exactly like the note on claimPurchase above.
  const introBonusGranted = new Set<string>();

  const key = (provider: string, eventId: string) => `${provider}::${eventId}`;

  const store: EntitlementStore = {
    async recordPurchase(p, status) {
      calls.record++;
      const k = key(p.provider, p.eventId);
      // ON CONFLICT DO NOTHING over EVERY unique constraint: the primary key
      // (provider, event id) and the transaction id index both silently drop
      // the insert rather than raising.
      if (rows.has(k)) return {};
      if (p.providerTxnId) {
        const tk = `${p.provider}::${p.providerTxnId}`;
        if (txnSeen.has(tk)) return {};
        txnSeen.add(tk);
      }
      rows.set(k, {
        provider: p.provider,
        eventId: p.eventId,
        userId: p.userId,
        txnId: p.providerTxnId,
        productKey: p.productKey,
        credits: p.credits,
        status,
        note: null,
      });
      return {};
    },

    async claimPurchase(provider, eventId) {
      calls.claim++;
      const row = rows.get(key(provider, eventId));
      // THE GUARD. Equivalent to:
      //   update purchases set status='granting'
      //    where provider=$1 and provider_event_id=$2 and status='received'
      //   returning user_id, credits
      // Zero rows matched means somebody else already owns this event.
      if (!row || row.status !== 'received') return { claimed: null };
      row.status = 'granting';
      return { claimed: { userId: row.userId, credits: row.credits } };
    },

    async addCredits(userId, credits) {
      calls.addCredits++;
      if (opts?.addCreditsFails) return { balance: null, error: opts.addCreditsFails };
      const next = (balances.get(userId) ?? opts?.startingBalance ?? 0) + credits;
      balances.set(userId, next);
      return { balance: next };
    },

    async finishPurchase(provider, eventId, status, note, credits) {
      calls.finish++;
      const row = rows.get(key(provider, eventId));
      if (row) {
        row.status = status;
        row.note = note ?? null;
        if (typeof credits === 'number') row.credits = credits;
      }
      return {};
    },

    async grantSubscriptionCredits(userId, isFirstInvoice, introCredits, renewalCredits) {
      calls.grantSubscription++;
      if (opts?.addCreditsFails) {
        return { credits: 0, bonusApplied: false, balance: null, error: opts.addCreditsFails };
      }
      // THE GUARD, mirroring grant_subscription_invoice_credits' WHERE
      // clause: the bonus can be claimed by this account exactly once, ever,
      // no matter how many first invoices arrive for it.
      const bonusApplied = isFirstInvoice && !introBonusGranted.has(userId);
      if (bonusApplied) introBonusGranted.add(userId);
      const credits = bonusApplied ? introCredits : renewalCredits;
      const next = (balances.get(userId) ?? opts?.startingBalance ?? 0) + credits;
      balances.set(userId, next);
      return { credits, bonusApplied, balance: next };
    },

    async logEvent(name, userId, props) {
      events.push({ name, userId, props });
    },
  };

  return { store, rows, balances, events, calls, introBonusGranted };
}

const USER = '11111111-1111-4111-8111-111111111111';

function purchase(over?: Partial<CreditPurchase>): CreditPurchase {
  return {
    provider: 'paddle',
    eventId: 'evt_01hq',
    userId: USER,
    productKey: 'credits_intro_5',
    credits: 5,
    amountCents: 500,
    currency: 'USD',
    providerTxnId: 'txn_01hq',
    occurredAt: '2026-08-26T04:00:00.000Z',
    ...over,
  };
}

describe('applyCreditPurchase: the happy path', () => {
  it('grants the credits once and records the purchase as granted', async () => {
    const f = fakeStore();
    const out = await applyCreditPurchase(f.store, purchase());

    expect(out).toEqual({ status: 'granted', credits: 5, balance: 5 });
    expect(f.balances.get(USER)).toBe(5);
    expect([...f.rows.values()][0].status).toBe('granted');
  });

  it('logs one revenue row carrying the account, the product and the money', async () => {
    const f = fakeStore();
    await applyCreditPurchase(f.store, purchase());

    const revenue = f.events.filter((e) => e.name === 'credits_purchased');
    expect(revenue).toHaveLength(1);
    expect(revenue[0].userId).toBe(USER);
    expect(revenue[0].props).toMatchObject({
      provider: 'paddle',
      product: 'credits_intro_5',
      credits: 5,
      amount_cents: 500,
      currency: 'USD',
      balance: 5,
    });
  });
});

describe('applyCreditPurchase: idempotency', () => {
  it('does not grant twice when the same event is delivered twice', async () => {
    const f = fakeStore();
    const first = await applyCreditPurchase(f.store, purchase());
    const second = await applyCreditPurchase(f.store, purchase());

    expect(first).toEqual({ status: 'granted', credits: 5, balance: 5 });
    expect(second).toEqual({ status: 'duplicate' });
    // The number that matters.
    expect(f.balances.get(USER)).toBe(5);
    expect(f.calls.addCredits).toBe(1);
  });

  it('stays at one grant across sixty retries, which is Paddle\'s live schedule', async () => {
    const f = fakeStore();
    const outcomes = [];
    for (let i = 0; i < 60; i++) outcomes.push(await applyCreditPurchase(f.store, purchase()));

    expect(outcomes.filter((o) => o.status === 'granted')).toHaveLength(1);
    expect(outcomes.filter((o) => o.status === 'duplicate')).toHaveLength(59);
    expect(f.balances.get(USER)).toBe(5);
  });

  it('grants once when two deliveries of the same event race', async () => {
    const f = fakeStore();
    const [a, b] = await Promise.all([
      applyCreditPurchase(f.store, purchase()),
      applyCreditPurchase(f.store, purchase()),
    ]);

    const statuses = [a.status, b.status].sort();
    expect(statuses).toEqual(['duplicate', 'granted']);
    expect(f.balances.get(USER)).toBe(5);
    expect(f.calls.addCredits).toBe(1);
  });

  it('grants once when transaction.paid and transaction.completed both arrive', async () => {
    // Two DIFFERENT event ids describing the SAME money. The primary key
    // cannot catch this; the transaction-id unique index is what does, and
    // this test is the reason that index exists.
    const f = fakeStore();
    const paid = await applyCreditPurchase(f.store, purchase({ eventId: 'evt_paid' }));
    const completed = await applyCreditPurchase(f.store, purchase({ eventId: 'evt_completed' }));

    expect(paid.status).toBe('granted');
    expect(completed).toEqual({ status: 'duplicate' });
    expect(f.balances.get(USER)).toBe(5);
  });

  it('treats a genuinely separate second purchase as a second grant', async () => {
    // The mirror of every test above: idempotency must not become "one
    // purchase per customer, ever". Different event, different transaction.
    const f = fakeStore();
    await applyCreditPurchase(f.store, purchase());
    const again = await applyCreditPurchase(
      f.store,
      purchase({ eventId: 'evt_02', providerTxnId: 'txn_02', productKey: 'credits_1', credits: 1, amountCents: 300 }),
    );

    expect(again).toEqual({ status: 'granted', credits: 1, balance: 6 });
    expect(f.balances.get(USER)).toBe(6);
  });

  it('extends an existing balance rather than replacing it', async () => {
    const f = fakeStore({ startingBalance: 3 });
    const out = await applyCreditPurchase(f.store, purchase({ credits: 5 }));
    expect(out).toEqual({ status: 'granted', credits: 5, balance: 8 });
  });
});

describe('applyCreditPurchase: money that cannot be applied', () => {
  it('records a purchase with no resolvable account and grants nothing', async () => {
    const f = fakeStore();
    const out = await applyCreditPurchase(f.store, purchase({ userId: null }));

    expect(out).toEqual({ status: 'no_user' });
    expect(f.calls.addCredits).toBe(0);
    // RECORDED, not dropped. A payment with no row is a payment nobody can
    // reconcile, and this is the row the dashboard panel goes looking for.
    const row = [...f.rows.values()][0];
    expect(row.status).toBe('user_unknown');
    expect(NEEDS_ATTENTION_STATUSES).toContain(row.status);
    expect(f.events.some((e) => e.name === 'purchase_needs_attention')).toBe(true);
  });

  it('records a purchase whose price matched no product and grants nothing', async () => {
    const f = fakeStore();
    const out = await applyCreditPurchase(f.store, purchase({ productKey: null, credits: 0 }));

    expect(out).toEqual({ status: 'unknown_product' });
    expect(f.calls.addCredits).toBe(0);
    expect([...f.rows.values()][0].status).toBe('unknown_product');
  });

  it('marks the row grant_failed when the credit write fails, and keeps it out of granted', async () => {
    const f = fakeStore({ addCreditsFails: 'no profile row for that account' });
    const out = await applyCreditPurchase(f.store, purchase());

    expect(out.status).toBe('grant_failed');
    const row = [...f.rows.values()][0];
    expect(row.status).toBe('grant_failed');
    expect(row.note).toContain('no profile row');
    expect(f.events.some((e) => e.name === 'purchase_needs_attention')).toBe(true);
    expect(f.events.some((e) => e.name === 'credits_purchased')).toBe(false);
  });

  it('lets a retry recover a failed grant without double granting a good one', async () => {
    // grant_failed is deliberately NOT claimable: the row is repaired by hand
    // from the dashboard, not by a retry that might land on top of a grant
    // that actually worked. What a retry must never do is pay out twice.
    const f = fakeStore({ addCreditsFails: 'transient' });
    await applyCreditPurchase(f.store, purchase());
    const retry = await applyCreditPurchase(f.store, purchase());

    expect(retry).toEqual({ status: 'duplicate' });
    expect(f.balances.get(USER)).toBeUndefined();
  });

  it('refuses a purchase with no event id, because it has no idempotency key', async () => {
    const f = fakeStore();
    const out = await applyCreditPurchase(f.store, purchase({ eventId: '' }));

    expect(out.status).toBe('store_error');
    expect(f.calls.record).toBe(0);
    expect(f.balances.size).toBe(0);
  });
});

// =============================================================================
// applySubscriptionCredit: renewal granting, and the first-month bonus being
// unrepeatable. See the header of entitlements.ts for why this is a separate
// function rather than a branch of applyCreditPurchase.

const USER2 = '22222222-2222-4222-8222-222222222222';

function subGrant(over?: Partial<SubscriptionInvoiceGrant>): SubscriptionInvoiceGrant {
  return {
    provider: 'stripe',
    eventId: 'evt_inv_01',
    userId: USER,
    productKey: 'pro_monthly',
    billingReason: 'subscription_cycle',
    introCredits: 5,
    renewalCredits: 2,
    amountCents: 500,
    currency: 'USD',
    providerTxnId: 'in_01',
    occurredAt: '2026-08-26T04:00:00.000Z',
    ...over,
  };
}

describe('applySubscriptionCredit: renewal granting', () => {
  it('grants the standard renewal amount on billing_reason subscription_cycle', async () => {
    const f = fakeStore();
    const out = await applySubscriptionCredit(f.store, subGrant());

    expect(out).toEqual({ status: 'granted', credits: 2, balance: 2 });
    expect(f.balances.get(USER)).toBe(2);
  });

  it('a subscription that only granted on signup would silently stop delivering in month two - this is the fix: three renewal invoices grant three times', async () => {
    const f = fakeStore();
    const first = await applySubscriptionCredit(
      f.store,
      subGrant({ eventId: 'evt_create', billingReason: 'subscription_create', providerTxnId: 'in_create' }),
    );
    const second = await applySubscriptionCredit(
      f.store,
      subGrant({ eventId: 'evt_cycle_1', providerTxnId: 'in_cycle_1' }),
    );
    const third = await applySubscriptionCredit(
      f.store,
      subGrant({ eventId: 'evt_cycle_2', providerTxnId: 'in_cycle_2' }),
    );

    expect(first).toEqual({ status: 'granted', credits: 5, balance: 5 }); // the bonus
    expect(second).toEqual({ status: 'granted', credits: 2, balance: 7 }); // renewal 1
    expect(third).toEqual({ status: 'granted', credits: 2, balance: 9 }); // renewal 2
    expect(f.balances.get(USER)).toBe(9);
  });

  it('does not grant twice when the same invoice event is delivered twice', async () => {
    const f = fakeStore();
    const first = await applySubscriptionCredit(f.store, subGrant());
    const second = await applySubscriptionCredit(f.store, subGrant());

    expect(first).toEqual({ status: 'granted', credits: 2, balance: 2 });
    expect(second).toEqual({ status: 'duplicate' });
    expect(f.balances.get(USER)).toBe(2);
    expect(f.calls.grantSubscription).toBe(1);
  });

  it('corrects the purchase row credits from the placeholder 0 to what was actually granted', async () => {
    const f = fakeStore();
    await applySubscriptionCredit(f.store, subGrant({ billingReason: 'subscription_create' }));
    expect([...f.rows.values()][0].credits).toBe(5);
    expect([...f.rows.values()][0].status).toBe('granted');
  });

  it('logs one revenue row carrying which credit count applied and whether it was the bonus', async () => {
    const f = fakeStore();
    await applySubscriptionCredit(f.store, subGrant({ billingReason: 'subscription_create' }));

    const revenue = f.events.filter((e) => e.name === 'credits_purchased');
    expect(revenue).toHaveLength(1);
    expect(revenue[0].props).toMatchObject({
      credits: 5,
      bonus_applied: true,
      billing_reason: 'subscription_create',
    });
  });
});

describe('applySubscriptionCredit: the first-month bonus is unrepeatable', () => {
  it('grants the bonus once, and the standard renewal amount on a SECOND, later subscription for the same account', async () => {
    // Simulates cancel-and-resubscribe: a different subscription id, a
    // different invoice, a different event - the only thing that stayed the
    // same is the ACCOUNT, which is exactly what the guard is keyed on.
    const f = fakeStore();
    const firstSub = await applySubscriptionCredit(
      f.store,
      subGrant({ eventId: 'evt_sub_a_create', billingReason: 'subscription_create', providerTxnId: 'in_sub_a_1' }),
    );
    const secondSub = await applySubscriptionCredit(
      f.store,
      subGrant({ eventId: 'evt_sub_b_create', billingReason: 'subscription_create', providerTxnId: 'in_sub_b_1' }),
    );

    expect(firstSub).toEqual({ status: 'granted', credits: 5, balance: 5 });
    // NOT refused, NOT another 5 - the renewal amount, because the account
    // already spent its one bonus. The payment is real and still grants
    // something; it just does not grant the bonus twice.
    expect(secondSub).toEqual({ status: 'granted', credits: 2, balance: 7 });
    expect(f.balances.get(USER)).toBe(7);
    expect(f.introBonusGranted.size).toBe(1);
  });

  it('never resets on cancellation: a subscription_cycle after the bonus was spent still grants the renewal amount, not the bonus', async () => {
    const f = fakeStore();
    await applySubscriptionCredit(
      f.store,
      subGrant({ eventId: 'evt_create', billingReason: 'subscription_create', providerTxnId: 'in_1' }),
    );
    const laterCycle = await applySubscriptionCredit(
      f.store,
      subGrant({ eventId: 'evt_cycle', billingReason: 'subscription_cycle', providerTxnId: 'in_2' }),
    );
    expect(laterCycle).toEqual({ status: 'granted', credits: 2, balance: 7 });
  });

  it('is scoped to the ACCOUNT, not the event or the subscription: two different accounts each get their own bonus', async () => {
    const f = fakeStore();
    const forUser1 = await applySubscriptionCredit(
      f.store,
      subGrant({ eventId: 'evt_u1', billingReason: 'subscription_create', providerTxnId: 'in_u1', userId: USER }),
    );
    const forUser2 = await applySubscriptionCredit(
      f.store,
      subGrant({ eventId: 'evt_u2', billingReason: 'subscription_create', providerTxnId: 'in_u2', userId: USER2 }),
    );
    expect(forUser1).toEqual({ status: 'granted', credits: 5, balance: 5 });
    expect(forUser2).toEqual({ status: 'granted', credits: 5, balance: 5 });
    expect(f.introBonusGranted.size).toBe(2);
  });
});

describe('applySubscriptionCredit: money that cannot be applied', () => {
  it('records an unrecognised billing_reason as needs-attention and grants nothing', async () => {
    // A paid invoice for a product this app sells, but not a first invoice or
    // a renewal of it - a plan change, a threshold invoice. Money moved and
    // nothing was granted, refused rather than guessed at.
    const f = fakeStore();
    const out = await applySubscriptionCredit(f.store, subGrant({ billingReason: 'subscription_update' }));

    expect(out).toEqual({ status: 'unknown_product' });
    expect(f.calls.grantSubscription).toBe(0);
    const row = [...f.rows.values()][0];
    expect(row.status).toBe('unknown_product');
    expect(NEEDS_ATTENTION_STATUSES).toContain(row.status);
    expect(f.events.some((e) => e.name === 'purchase_needs_attention')).toBe(true);
  });

  it('records a purchase with no resolvable account and grants nothing', async () => {
    const f = fakeStore();
    const out = await applySubscriptionCredit(f.store, subGrant({ userId: null }));

    expect(out).toEqual({ status: 'no_user' });
    expect(f.calls.grantSubscription).toBe(0);
    expect([...f.rows.values()][0].status).toBe('user_unknown');
  });

  it('records a purchase whose price matched no product and grants nothing', async () => {
    const f = fakeStore();
    const out = await applySubscriptionCredit(f.store, subGrant({ productKey: null }));

    expect(out).toEqual({ status: 'unknown_product' });
    expect(f.calls.grantSubscription).toBe(0);
  });

  it('marks the row grant_failed when the credit write fails, and does not spend the bonus', async () => {
    const f = fakeStore({ addCreditsFails: 'no profile row for that account' });
    const out = await applySubscriptionCredit(
      f.store,
      subGrant({ billingReason: 'subscription_create' }),
    );

    expect(out.status).toBe('grant_failed');
    expect([...f.rows.values()][0].status).toBe('grant_failed');
    // The bonus flag is only set INSIDE the same statement that grants -
    // a failed grant must not have burned the one-time bonus for nothing.
    expect(f.introBonusGranted.size).toBe(0);
    expect(f.events.some((e) => e.name === 'purchase_needs_attention')).toBe(true);
  });
});
