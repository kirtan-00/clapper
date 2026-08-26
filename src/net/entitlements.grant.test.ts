import { describe, it, expect } from 'vitest';
import {
  applyCreditPurchase,
  NEEDS_ATTENTION_STATUSES,
  type CreditPurchase,
  type EntitlementStore,
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
