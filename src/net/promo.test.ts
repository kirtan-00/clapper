import { describe, it, expect } from 'vitest';
import {
  PROMO_PRODUCT_KEY,
  PROMO_SLOTS,
  isPromoProduct,
  readPromoState,
} from '../../supabase/functions/_shared/promo.ts';
import { getProduct } from '../../supabase/functions/_shared/products.ts';

// The launch offer sells 5 credits for INR 100 against a list price of INR
// 2,399 for the same five. The cap is therefore not a nicety: every unit sold
// past the tenth is a 96% discount nobody authorised, and it looks exactly
// like a successful purchase in every log. So the counting is pinned here,
// including the two mistakes that would be invisible in production until the
// bill arrived: counting a person's own in-flight reservation against them,
// and counting one person twice because they appear in both tables.

/** The narrowest fake that satisfies what readPromoState actually calls:
 *  .from(table).select(cols) then a chain of filters, awaited for {data,error}.
 *  Deliberately not a mock library - the shape under test is small and a
 *  hand-written double makes the query being asserted legible. */
function fakeAdmin(opts: {
  purchases?: Array<{ user_id: string | null }>;
  purchasesError?: string;
  events?: Array<{ user_id: string | null }>;
  eventsError?: string;
}) {
  const make = (rows: Array<{ user_id: string | null }> | undefined, err: string | undefined) => {
    const result = err ? { data: null, error: { message: err } } : { data: rows ?? [], error: null };
    const chain: Record<string, unknown> = {};
    // Every filter returns the same thenable, so the call order under test
    // does not have to be replicated here.
    for (const m of ['select', 'eq', 'gte']) {
      chain[m] = () => chain;
    }
    chain.then = (resolve: (v: unknown) => unknown) => Promise.resolve(result).then(resolve);
    return chain;
  };
  return {
    from(table: string) {
      if (table === 'purchases') return make(opts.purchases, opts.purchasesError);
      if (table === 'events') return make(opts.events, opts.eventsError);
      throw new Error(`unexpected table ${table}`);
    },
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
  } as any;
}

const ME = 'user-me';
const other = (n: number) => `user-${n}`;

describe('the launch offer', () => {
  it('is a real catalogue product at the advertised price', () => {
    const p = getProduct(PROMO_PRODUCT_KEY);
    expect(p).not.toBeNull();
    expect(p?.kind).toBe('one_time');
    expect(p?.credits).toBe(5);
    // Paise. INR 100.
    expect(p?.amountCents).toBe(10000);
    expect(p?.currency).toBe('INR');
    expect(PROMO_SLOTS).toBe(10);
  });

  it('only caps itself, not the standing products', () => {
    expect(isPromoProduct(PROMO_PRODUCT_KEY)).toBe(true);
    expect(isPromoProduct('credit_1')).toBe(false);
    expect(isPromoProduct('bundle_5')).toBe(false);
    expect(isPromoProduct('studio_plus')).toBe(false);
  });

  it('offers all ten when nobody has claimed', async () => {
    const s = await readPromoState(fakeAdmin({}), ME);
    expect(s.remaining).toBe(10);
    expect(s.eligible).toBe(true);
    expect(s.alreadyClaimed).toBe(false);
  });

  it('refuses a second helping to somebody who already bought it', async () => {
    const s = await readPromoState(fakeAdmin({ purchases: [{ user_id: ME }] }), ME);
    expect(s.alreadyClaimed).toBe(true);
    expect(s.eligible).toBe(false);
  });

  it('does not count a person against their own eligibility', async () => {
    // The bug this stops: opening the checkout writes a checkout_started
    // event, which would otherwise make the buyer ineligible to complete the
    // very purchase they just started.
    const s = await readPromoState(fakeAdmin({ events: [{ user_id: ME }] }), ME);
    expect(s.eligible).toBe(true);
  });

  it('counts one person once even when they appear in both tables', async () => {
    // A paid claim always leaves a checkout_started behind it. Adding the two
    // counts rather than unioning them would burn through the ten at double
    // speed and shut the offer at five real sales.
    const rows = [{ user_id: other(1) }];
    const s = await readPromoState(fakeAdmin({ purchases: rows, events: rows }), ME);
    expect(s.remaining).toBe(9);
  });

  it('counts an open checkout against the ten, so ten simultaneous taps cannot all win', async () => {
    const holders = Array.from({ length: 10 }, (_, i) => ({ user_id: other(i) }));
    const s = await readPromoState(fakeAdmin({ events: holders }), ME);
    expect(s.remaining).toBe(0);
    expect(s.eligible).toBe(false);
  });

  it('counts a purchase that needs attention, because the money still moved', async () => {
    // readPromoState does not filter on status on purpose: a purchase
    // recorded as unknown_product or grant_failed still took somebody's
    // hundred rupees and still owes them five credits.
    const s = await readPromoState(fakeAdmin({ purchases: [{ user_id: other(1) }] }), ME);
    expect(s.remaining).toBe(9);
  });

  it('closes the offer rather than guessing when the ledger is unreadable', async () => {
    // The safe direction: a refused buyer can still pay list price. An
    // over-sold buyer has already been charged.
    const s = await readPromoState(fakeAdmin({ purchasesError: 'boom' }), ME);
    expect(s.remaining).toBe(0);
    expect(s.eligible).toBe(false);
  });

  it('still sells when only the soft reservation half fails', async () => {
    // Losing reservations widens the race back to what it would be without
    // them. Losing the paid half would mean not knowing what was sold at all,
    // which is why only that one is fatal.
    const s = await readPromoState(
      fakeAdmin({ purchases: [{ user_id: other(1) }], eventsError: 'boom' }),
      ME,
    );
    expect(s.remaining).toBe(9);
    expect(s.eligible).toBe(true);
  });

  it('ignores rows with no user id rather than counting them as a claimant', async () => {
    // events.user_id is nullable (anonymous analytics). A null must not eat
    // a slot, and must not collapse several nulls into one phantom person.
    const s = await readPromoState(
      fakeAdmin({ events: [{ user_id: null }, { user_id: null }] }),
      ME,
    );
    expect(s.remaining).toBe(10);
    expect(s.eligible).toBe(true);
  });
});
