// The entitlement-decision tests. These pin the four scenarios the rework
// spec calls out by name - a free account with slots left, the same account
// at zero, a legacy is_pro account, and a subscriber mid-cycle - against the
// pure decision functions in _shared/gate.ts, which is the layer that used
// to be untestable from vitest (the equivalent logic lived inline in two Deno
// edge functions with no injection point). See _shared/entitlements.ts for
// the precedent this follows.

import { describe, it, expect } from 'vitest';
import {
  decideExport,
  decideProjectAccess,
  proBypass,
  type ProAccess,
} from '../../supabase/functions/_shared/gate.ts';

const NOT_PRO: ProAccess = { isPro: false, proUntil: null };

describe('proBypass', () => {
  it('false for a non-pro account regardless of proUntil', () => {
    expect(proBypass({ isPro: false, proUntil: '2099-01-01T00:00:00Z' })).toBe(false);
  });

  it('true for is_pro with no pro_until - predates the column, must not be cut off', () => {
    expect(proBypass({ isPro: true, proUntil: null })).toBe(true);
  });

  it('true for is_pro with a pro_until still in the future', () => {
    const now = new Date('2026-08-27T00:00:00Z').getTime();
    expect(proBypass({ isPro: true, proUntil: '2026-09-01T00:00:00Z' }, now)).toBe(true);
  });

  it('false for is_pro whose pro_until has lapsed - demoted to free, not left uncapped', () => {
    const now = new Date('2026-08-27T00:00:00Z').getTime();
    expect(proBypass({ isPro: true, proUntil: '2026-01-01T00:00:00Z' }, now)).toBe(false);
  });
});

describe('decideExport', () => {
  it('CSV is free for a signed-in, non-suspended free account - no project needed', () => {
    const result = decideExport({
      format: 'csv',
      isSuspended: false,
      pro: NOT_PRO,
      projectUnlocked: false,
    });
    expect(result).toEqual({ allow: true });
  });

  it('PDF is refused for a free account on a project that has not been bought', () => {
    const result = decideExport({
      format: 'pdf',
      isSuspended: false,
      pro: NOT_PRO,
      projectUnlocked: false,
    });
    expect(result).toEqual({ allow: false, reason: 'project_locked' });
  });

  it('Premiere/Resolve is allowed once the project is unlocked, on a free account', () => {
    const result = decideExport({
      format: 'premiere',
      isSuspended: false,
      pro: NOT_PRO,
      projectUnlocked: true,
    });
    expect(result).toEqual({ allow: true });
  });

  it('a legacy is_pro account gets pdf/premiere with no project unlock at all', () => {
    const pro: ProAccess = { isPro: true, proUntil: null };
    expect(decideExport({ format: 'pdf', isSuspended: false, pro, projectUnlocked: false })).toEqual({ allow: true });
    expect(decideExport({ format: 'premiere', isSuspended: false, pro, projectUnlocked: false })).toEqual({
      allow: true,
    });
  });

  it('suspension refuses even CSV, and outranks an unlocked project', () => {
    const result = decideExport({
      format: 'csv',
      isSuspended: true,
      pro: NOT_PRO,
      projectUnlocked: true,
    });
    expect(result).toEqual({ allow: false, reason: 'suspended' });
  });
});

describe('decideProjectAccess', () => {
  it('free account, 2 of 2 slots left: a brand new project gets access and consumes one', () => {
    const result = decideProjectAccess({
      isSuspended: false,
      pro: NOT_PRO,
      projectUnlocked: false,
      projectFreeGranted: false,
      freeProjectsUsed: 0,
      freeProjectsLimit: 2,
    });
    expect(result).toEqual({ allow: true, consumesFreeSlot: true });
  });

  it('free account, 1 of 2 slots left: a second new project still gets access and consumes the last one', () => {
    const result = decideProjectAccess({
      isSuspended: false,
      pro: NOT_PRO,
      projectUnlocked: false,
      projectFreeGranted: false,
      freeProjectsUsed: 1,
      freeProjectsLimit: 2,
    });
    expect(result).toEqual({ allow: true, consumesFreeSlot: true });
  });

  it('free account, 0 of 2 slots left: a third new project is refused, honestly and finally', () => {
    const result = decideProjectAccess({
      isSuspended: false,
      pro: NOT_PRO,
      projectUnlocked: false,
      projectFreeGranted: false,
      freeProjectsUsed: 2,
      freeProjectsLimit: 2,
    });
    expect(result).toEqual({ allow: false, reason: 'no_free_projects' });
  });

  it('free account, 0 slots left, but THIS project already claimed one: allowed, consumes nothing new', () => {
    const result = decideProjectAccess({
      isSuspended: false,
      pro: NOT_PRO,
      projectUnlocked: false,
      projectFreeGranted: true,
      freeProjectsUsed: 2,
      freeProjectsLimit: 2,
    });
    expect(result).toEqual({ allow: true, consumesFreeSlot: false });
  });

  it('legacy is_pro account: unlimited project access, free grant never touched', () => {
    const result = decideProjectAccess({
      isSuspended: false,
      pro: { isPro: true, proUntil: null },
      projectUnlocked: false,
      projectFreeGranted: false,
      freeProjectsUsed: 2,
      freeProjectsLimit: 2,
    });
    expect(result).toEqual({ allow: true, consumesFreeSlot: false });
  });

  it('a lapsed is_pro account is demoted to ordinary free-tier rules', () => {
    const now = new Date('2026-08-27T00:00:00Z').getTime();
    const result = decideProjectAccess({
      isSuspended: false,
      pro: { isPro: true, proUntil: '2026-01-01T00:00:00Z' },
      projectUnlocked: false,
      projectFreeGranted: false,
      freeProjectsUsed: 2,
      freeProjectsLimit: 2,
      now,
    });
    expect(result).toEqual({ allow: false, reason: 'no_free_projects' });
  });

  it('subscriber mid-cycle: a project already unlocked with this month\'s credits keeps working', () => {
    // "Studio" grants 6 credits/month, spent one project at a time via
    // unlock_project (untouched by this rework). Two projects already
    // unlocked this cycle read as projectUnlocked:true regardless of the
    // free-grant counters, which this account may have exhausted long ago.
    const result = decideProjectAccess({
      isSuspended: false,
      pro: NOT_PRO,
      projectUnlocked: true,
      projectFreeGranted: false,
      freeProjectsUsed: 2,
      freeProjectsLimit: 2,
    });
    expect(result).toEqual({ allow: true, consumesFreeSlot: false });
  });

  it('subscriber mid-cycle: a THIRD, never-unlocked project is not free - the free grant is a separate, exhausted bucket', () => {
    // This is deliberate: decideProjectAccess never auto-spends a
    // project_credit. Unlocking a new project mid-cycle is the existing,
    // explicit unlock_project flow, not something Script Mode triggers on
    // its own. See the file header for why that stays a separate action.
    const result = decideProjectAccess({
      isSuspended: false,
      pro: NOT_PRO,
      projectUnlocked: false,
      projectFreeGranted: false,
      freeProjectsUsed: 2,
      freeProjectsLimit: 2,
    });
    expect(result).toEqual({ allow: false, reason: 'no_free_projects' });
  });

  it('suspension refuses even a project with slots remaining', () => {
    const result = decideProjectAccess({
      isSuspended: true,
      pro: NOT_PRO,
      projectUnlocked: false,
      projectFreeGranted: false,
      freeProjectsUsed: 0,
      freeProjectsLimit: 2,
    });
    expect(result).toEqual({ allow: false, reason: 'suspended' });
  });
});
