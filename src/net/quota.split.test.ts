// Pins the 2026-08-26 split of one free-tier counter into two.
//
// The bug: supabase/functions/breakdown serves two features - the shot-list
// breakdown (mode 'shots') and the call-sheet parse (mode 'callsheet') - and
// both spent `usage.script_uses` against one FREE_LIMIT of 5. Meanwhile this
// file's FREE_LIMITS said `script: 1` and the whole public site said 1, so a
// user could be shown "4 of 1", and a first AD who loaded four call sheets in a
// week had silently burned the shot-list breakdown they never used.
//
// The server side of the split lives in Deno and in plpgsql and cannot be
// reached from this runner. What CAN be pinned here, and is, is the client
// contract those two depend on:
//
//   1. The two limits exist, are separate, and are the numbers the servers
//      enforce (script 1 in MODE_QUOTA, callsheet 5 in MODE_QUOTA).
//   2. getUsage reports them as INDEPENDENT counters - spending every last
//      breakdown leaves the call sheets untouched, and the other way round.
//   3. `callsheet_uses` is read in its OWN query, so an unmigrated database
//      cannot take the other four counters down with it. That is the
//      `is_suspended` failure (see supabase/functions/_shared/suspension.ts)
//      reintroduced in a new place, and it is the single most likely way for
//      this change to break production.
//
// This is a separate file rather than an addition to quota.test.ts or
// quota.suspended.test.ts, both of which own their own branches of gateExport.

import { beforeEach, describe, expect, it, vi, type Mock } from 'vitest';

vi.mock('./supabase', () => ({
  supabase: {
    auth: { getSession: vi.fn() },
    from: vi.fn(),
    functions: { invoke: vi.fn() },
  },
}));

import { supabase } from './supabase';
import { FREE_LIMITS, FREE_LIMIT, getUsage } from './quota';

const getSession = supabase.auth.getSession as unknown as Mock;
const from = supabase.from as unknown as Mock;

/** One `usage` row as the four-column select would return it. */
interface FourColumns {
  script_uses: number;
  premiere_uses: number;
  pdf_uses: number | null;
  csv_uses: number;
}

/**
 * Stand in for the PostgREST query builder. `getUsage` makes TWO calls now: the
 * four-column select it always made, and a separate one-column select for
 * `callsheet_uses`. They are told apart by the column list, exactly as the real
 * client sees them, so a future edit that folds the second query back into the
 * first fails here rather than in production on an unmigrated database.
 */
function mockUsage(opts: {
  row: FourColumns | null;
  rowError?: unknown;
  callsheet?: { callsheet_uses: number | null } | null;
  callsheetError?: unknown;
  callsheetThrows?: boolean;
}): { selects: string[] } {
  const selects: string[] = [];
  from.mockImplementation((table: string) => {
    expect(table).toBe('usage');
    return {
      select(columns: string) {
        selects.push(columns);
        const wantsCallsheet = columns.includes('callsheet_uses');
        return {
          maybeSingle() {
            if (wantsCallsheet) {
              if (opts.callsheetThrows) throw new Error('network');
              return Promise.resolve({
                data: opts.callsheet ?? null,
                error: opts.callsheetError ?? null,
              });
            }
            return Promise.resolve({ data: opts.row, error: opts.rowError ?? null });
          },
        };
      },
    };
  });
  return { selects };
}

beforeEach(() => {
  vi.clearAllMocks();
  getSession.mockResolvedValue({ data: { session: { user: { id: 'u1' } } } });
});

describe('the free tier prices two Script Mode features, not one', () => {
  it('script is 1 and callsheet is 5, and they are different numbers', () => {
    // 1 is what the app, the Account screen and every page of the public site
    // have said for weeks. 5 is a per-shoot-day allowance: capping today's call
    // sheet at 1 for the life of an account reads as broken on day two.
    expect(FREE_LIMITS.script).toBe(1);
    expect(FREE_LIMITS.callsheet).toBe(5);
    expect(FREE_LIMITS.script).not.toBe(FREE_LIMITS.callsheet);
  });

  it('leaves the export limits exactly where they were', () => {
    expect(FREE_LIMITS.premiere).toBe(2);
    expect(FREE_LIMITS.pdf).toBe(5);
    expect(FREE_LIMITS.csv).toBe(5);
  });

  it('keeps FREE_LIMIT singular pointing at the CSV/PDF number its call sites read', () => {
    // The name is kept deliberately. Changing what it means would move the
    // number under ProjectScreen's export copy without touching that file.
    expect(FREE_LIMIT).toBe(FREE_LIMITS.csv);
    expect(FREE_LIMIT).toBe(5);
  });
});

describe('getUsage: the two counters are independent', () => {
  it('a fully spent shot-list breakdown leaves every call sheet available', async () => {
    mockUsage({
      row: { script_uses: 1, premiere_uses: 0, pdf_uses: 0, csv_uses: 0 },
      callsheet: { callsheet_uses: 0 },
    });
    const usage = await getUsage();
    expect(usage?.script).toEqual({ used: 1, left: 0 });
    expect(usage?.callsheet).toEqual({ used: 0, left: 5 });
  });

  it('a fully spent call-sheet counter leaves the shot-list breakdown available', async () => {
    mockUsage({
      row: { script_uses: 0, premiere_uses: 0, pdf_uses: 0, csv_uses: 0 },
      callsheet: { callsheet_uses: 5 },
    });
    const usage = await getUsage();
    expect(usage?.callsheet).toEqual({ used: 5, left: 0 });
    expect(usage?.script).toEqual({ used: 0, left: 1 });
  });

  it('counts each against its OWN limit, so neither can be read off the other', async () => {
    // 1 use out of each. Same number spent, different number left, which is the
    // whole point: one counter cannot answer for both.
    mockUsage({
      row: { script_uses: 1, premiere_uses: 1, pdf_uses: 1, csv_uses: 1 },
      callsheet: { callsheet_uses: 1 },
    });
    const usage = await getUsage();
    expect(usage?.script.left).toBe(0);
    expect(usage?.callsheet.left).toBe(4);
    expect(usage?.premiere.left).toBe(1);
    expect(usage?.pdf.left).toBe(4);
    expect(usage?.csv.left).toBe(4);
  });

  it('never reports a negative remainder, however far over a counter has run', async () => {
    // Real rows in production already sit above the current limits: the tier
    // was repriced under accounts that had already spent against the old one.
    mockUsage({
      row: { script_uses: 8, premiere_uses: 9, pdf_uses: 9, csv_uses: 9 },
      callsheet: { callsheet_uses: 40 },
    });
    const usage = await getUsage();
    expect(usage?.script.left).toBe(0);
    expect(usage?.callsheet.left).toBe(0);
    expect(usage?.premiere.left).toBe(0);
  });
});

describe('callsheet_uses is read on its own, and a failure to read it fails open', () => {
  it('asks for it in a SECOND query, never inside the four-column select', async () => {
    const { selects } = mockUsage({
      row: { script_uses: 0, premiere_uses: 0, pdf_uses: 0, csv_uses: 0 },
      callsheet: { callsheet_uses: 2 },
    });
    await getUsage();
    expect(selects).toHaveLength(2);
    const [four, one] = selects.sort((a, b) => b.length - a.length);
    // The select that carries the four shipped columns must NOT name the new
    // one. PostgREST resolves the whole column list before it runs anything, so
    // one unknown column fails the ENTIRE select with 42703 and returns null -
    // which would blank four counters that read perfectly well.
    expect(four).toContain('script_uses');
    expect(four).toContain('premiere_uses');
    expect(four).toContain('pdf_uses');
    expect(four).toContain('csv_uses');
    expect(four).not.toContain('callsheet_uses');
    expect(one).toContain('callsheet_uses');
  });

  it('an unmigrated database (42703 on the new column) still reports the other four', async () => {
    mockUsage({
      row: { script_uses: 1, premiere_uses: 1, pdf_uses: 2, csv_uses: 3 },
      callsheet: null,
      callsheetError: { code: '42703', message: 'column usage.callsheet_uses does not exist' },
    });
    const usage = await getUsage();
    expect(usage).not.toBeNull();
    expect(usage?.script).toEqual({ used: 1, left: 0 });
    expect(usage?.premiere).toEqual({ used: 1, left: 1 });
    expect(usage?.pdf).toEqual({ used: 2, left: 3 });
    expect(usage?.csv).toEqual({ used: 3, left: 2 });
    // Fails OPEN at zero used. These numbers are display only; the server
    // refuses a call sheet whether or not this read worked, so the worst case
    // is a screen that is optimistic by a few, not a screen full of dashes.
    expect(usage?.callsheet).toEqual({ used: 0, left: 5 });
  });

  it('a thrown network error on the second query is the same answer as a returned one', async () => {
    mockUsage({
      row: { script_uses: 0, premiere_uses: 0, pdf_uses: 0, csv_uses: 0 },
      callsheetThrows: true,
    });
    const usage = await getUsage();
    expect(usage?.callsheet).toEqual({ used: 0, left: 5 });
    expect(usage?.csv).toEqual({ used: 0, left: 5 });
  });

  it('still returns null when the FOUR-column select is the one that fails', async () => {
    // The new query fails open; the old one does not change behaviour. If the
    // row itself is unreadable there is nothing honest to show.
    mockUsage({
      row: null,
      rowError: { message: 'boom' },
      callsheet: { callsheet_uses: 0 },
    });
    expect(await getUsage()).toBeNull();
  });

  it('signed out reads nothing at all, including the new column', async () => {
    getSession.mockResolvedValue({ data: { session: null } });
    const { selects } = mockUsage({
      row: { script_uses: 0, premiere_uses: 0, pdf_uses: 0, csv_uses: 0 },
      callsheet: { callsheet_uses: 0 },
    });
    expect(await getUsage()).toBeNull();
    expect(selects).toHaveLength(0);
  });
});
