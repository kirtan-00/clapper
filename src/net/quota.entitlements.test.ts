// Pins getEntitlements(), the client half of the 2026-08-27 rework that
// replaced five per-format export counters (script/callsheet/premiere/pdf/
// csv, each a lifetime cap read off `usage`) with a single read of the
// caller's own `profiles` row.
//
// REPLACES src/net/quota.split.test.ts, which pinned the OLD getUsage's
// two-query split (four columns, then a separate callsheet_uses query,
// because that column arrived in a later migration than the other four and
// naming it in the same select would 42703 the whole thing on an unmigrated
// database). getEntitlements needs no such split: every column it reads
// arrives in the SAME migration (20260827120000_project_metering.sql), so a
// single query is correct - but this file still pins the same class of bug
// its predecessor did: every field defensively falls back to a safe default
// (0, not-active, free-tier minutes) rather than letting one odd value blank
// the whole screen, and a genuinely unreadable row returns null rather than
// half an answer.

import { beforeEach, describe, expect, it, vi, type Mock } from 'vitest';

vi.mock('./supabase', () => ({
  supabase: {
    auth: { getSession: vi.fn() },
    from: vi.fn(),
    functions: { invoke: vi.fn() },
  },
}));

import { supabase } from './supabase';
import {
  getEntitlements,
  FREE_PROJECT_LIMIT,
  PODCAST_MINUTES_FREE_PER_MONTH,
  PODCAST_MINUTES_STUDIO_PER_MONTH,
  PODCAST_MINUTES_STUDIO_PLUS_PER_MONTH,
} from './quota';

const getSession = supabase.auth.getSession as unknown as Mock;
const from = supabase.from as unknown as Mock;

interface Row {
  is_pro: boolean;
  pro_until: string | null;
  free_projects_used: number | null;
  project_credits: number | null;
  subscription_status: string | null;
  subscription_product: string | null;
  podcast_seconds_used: number | null;
}

function mockProfile(row: Row | null, error?: unknown): { selected: string } {
  let selected = '';
  from.mockImplementation((table: string) => {
    expect(table).toBe('profiles');
    return {
      select(columns: string) {
        selected = columns;
        return {
          maybeSingle() {
            return Promise.resolve({ data: row, error: error ?? null });
          },
        };
      },
    };
  });
  return { get selected() {
    return selected;
  } };
}

beforeEach(() => {
  vi.clearAllMocks();
  getSession.mockResolvedValue({ data: { session: { user: { id: 'u1' } } } });
});

describe('getEntitlements: signed out and unreadable rows', () => {
  it('signed out reads nothing and returns null', async () => {
    getSession.mockResolvedValue({ data: { session: null } });
    mockProfile({
      is_pro: false,
      pro_until: null,
      free_projects_used: 0,
      project_credits: 0,
      subscription_status: null,
      subscription_product: null,
      podcast_seconds_used: 0,
    });
    expect(await getEntitlements()).toBeNull();
    expect(from).not.toHaveBeenCalled();
  });

  it('an unreadable row (query error) returns null rather than a half-filled answer', async () => {
    mockProfile(null, { message: 'boom' });
    expect(await getEntitlements()).toBeNull();
  });

  it('a genuinely missing row returns null', async () => {
    mockProfile(null);
    expect(await getEntitlements()).toBeNull();
  });
});

describe('getEntitlements: a free account, straightforward reads', () => {
  it('a fresh free account: 0 of 2 projects used, no credits, free podcast minutes', async () => {
    mockProfile({
      is_pro: false,
      pro_until: null,
      free_projects_used: 0,
      project_credits: 0,
      subscription_status: null,
      subscription_product: null,
      podcast_seconds_used: 0,
    });
    const ent = await getEntitlements();
    expect(ent?.isPro).toBe(false);
    expect(ent?.freeProjectsUsed).toBe(0);
    expect(ent?.freeProjectsLimit).toBe(FREE_PROJECT_LIMIT);
    expect(ent?.projectCredits).toBe(0);
    expect(ent?.subscriptionActive).toBe(false);
    expect(ent?.podcastMinutesLimit).toBe(PODCAST_MINUTES_FREE_PER_MONTH);
    expect(ent?.podcastMinutesUsed).toBe(0);
  });

  it('a free account with both slots spent reads 2 of 2, not a negative or an error', async () => {
    mockProfile({
      is_pro: false,
      pro_until: null,
      free_projects_used: 2,
      project_credits: 0,
      subscription_status: null,
      subscription_product: null,
      podcast_seconds_used: 0,
    });
    const ent = await getEntitlements();
    expect(ent?.freeProjectsUsed).toBe(2);
    expect(ent?.freeProjectsLimit).toBe(2);
  });

  it('an account with unspent project credits reports them regardless of source (free bundle, purchase, or subscription grant)', async () => {
    mockProfile({
      is_pro: false,
      pro_until: null,
      free_projects_used: 2,
      project_credits: 4,
      subscription_status: null,
      subscription_product: null,
      podcast_seconds_used: 0,
    });
    const ent = await getEntitlements();
    expect(ent?.projectCredits).toBe(4);
  });
});

describe('getEntitlements: defensive fallbacks for null columns', () => {
  it('null free_projects_used, project_credits and podcast_seconds_used all read as 0, not null or NaN', async () => {
    mockProfile({
      is_pro: false,
      pro_until: null,
      free_projects_used: null,
      project_credits: null,
      subscription_status: null,
      subscription_product: null,
      podcast_seconds_used: null,
    });
    const ent = await getEntitlements();
    expect(ent?.freeProjectsUsed).toBe(0);
    expect(ent?.projectCredits).toBe(0);
    expect(ent?.podcastMinutesUsed).toBe(0);
  });
});

describe('getEntitlements: the legacy is_pro account', () => {
  it('is_pro with no pro_until reads as pro - predates the column, must not be cut off', async () => {
    mockProfile({
      is_pro: true,
      pro_until: null,
      free_projects_used: 0,
      project_credits: 0,
      subscription_status: null,
      subscription_product: null,
      podcast_seconds_used: 0,
    });
    const ent = await getEntitlements();
    expect(ent?.isPro).toBe(true);
    expect(ent?.proUntil).toBeNull();
  });

  it('is_pro is reported as-is even with a lapsed pro_until - demotion is the UI/edge-function decision, not this read', async () => {
    mockProfile({
      is_pro: true,
      pro_until: '2020-01-01T00:00:00Z',
      free_projects_used: 0,
      project_credits: 0,
      subscription_status: null,
      subscription_product: null,
      podcast_seconds_used: 0,
    });
    const ent = await getEntitlements();
    expect(ent?.isPro).toBe(true);
    expect(ent?.proUntil).toBe('2020-01-01T00:00:00Z');
  });
});

describe('getEntitlements: a subscriber mid-cycle', () => {
  it('an active Studio ("pro_monthly") subscription reports subscriptionActive and Studio podcast minutes', async () => {
    mockProfile({
      is_pro: false,
      pro_until: null,
      free_projects_used: 2,
      project_credits: 3,
      subscription_status: 'active',
      subscription_product: 'pro_monthly',
      podcast_seconds_used: 1800, // 30 minutes spent this cycle
    });
    const ent = await getEntitlements();
    expect(ent?.subscriptionActive).toBe(true);
    expect(ent?.subscriptionProduct).toBe('pro_monthly');
    expect(ent?.podcastMinutesLimit).toBe(PODCAST_MINUTES_STUDIO_PER_MONTH);
    expect(ent?.podcastMinutesUsed).toBe(30);
    // The free-grant counters are untouched by a subscription - they are a
    // separate, already-exhausted bucket (see gate.test.ts).
    expect(ent?.freeProjectsUsed).toBe(2);
  });

  it('an active Studio Plus subscription reports the larger podcast allowance', async () => {
    mockProfile({
      is_pro: false,
      pro_until: null,
      free_projects_used: 2,
      project_credits: 10,
      subscription_status: 'trialing',
      subscription_product: 'studio_plus',
      podcast_seconds_used: 0,
    });
    const ent = await getEntitlements();
    expect(ent?.podcastMinutesLimit).toBe(PODCAST_MINUTES_STUDIO_PLUS_PER_MONTH);
  });

  it('a cancelled subscription reads as free-tier podcast minutes even with a product still on file', async () => {
    mockProfile({
      is_pro: false,
      pro_until: null,
      free_projects_used: 2,
      project_credits: 0,
      subscription_status: 'canceled',
      subscription_product: 'pro_monthly',
      podcast_seconds_used: 0,
    });
    const ent = await getEntitlements();
    expect(ent?.subscriptionActive).toBe(false);
    expect(ent?.podcastMinutesLimit).toBe(PODCAST_MINUTES_FREE_PER_MONTH);
  });
});
