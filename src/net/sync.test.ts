// Pure-logic tests for the sync engine. No network, no real Supabase/IndexedDB
// — these exercise only the pure functions sync.ts exposes: row-shaping for
// push, tombstone grouping, delta-merge planning, cursor advancement, and
// backoff/retry timing. The network glue around them (flush/pull/initSync)
// is deliberately not exercised here — it's thin wiring over these cores.

import { describe, expect, it, vi } from 'vitest';
import {
  advanceCursor,
  backoffDelayMs,
  buildProjectRows,
  chunk,
  createDebouncedTrigger,
  groupTombstonesByTable,
  MAX_FLUSH_ATTEMPTS,
  nextRetryState,
  planPullApply,
  type PullRow,
  type RetryState,
} from './sync';
import type { Tombstone } from '../store/outbox';
import type { Moment, Project, ProjectBundle, Slate, Take } from '../types';

function project(id: string): Project {
  return {
    id,
    name: 'Test',
    fps: 24,
    clipPrefix: 'C',
    nextClipNumber: 3,
    clipPadding: 4,
    tags: [],
    createdAt: 0,
    updatedAt: 0,
  };
}

function slate(id: string, projectId: string): Slate {
  return { id, projectId, name: 'Scene 1', order: 0, createdAt: 0, updatedAt: 0 };
}

function take(id: string, slateId: string, projectId: string): Take {
  return {
    id,
    slateId,
    projectId,
    number: 1,
    clipName: 'C0001',
    status: 'good',
    startedAt: 0,
    durationMs: 1000,
    createdAt: 0,
    updatedAt: 0,
  };
}

function moment(id: string, takeId: string): Moment {
  return { id, takeId, kind: 'point', atMs: 500, label: '', createdAt: 0, updatedAt: 0 };
}

// ---------------------------------------------------------------- chunk ----

describe('chunk', () => {
  it('splits into batches of the given size', () => {
    expect(chunk([1, 2, 3, 4, 5], 2)).toEqual([[1, 2], [3, 4], [5]]);
  });

  it('one batch when everything fits', () => {
    expect(chunk([1, 2], 500)).toEqual([[1, 2]]);
  });

  it('empty input -> empty output', () => {
    expect(chunk([], 500)).toEqual([]);
  });
});

// --------------------------------------------------------- buildProjectRows -

describe('buildProjectRows', () => {
  it('shapes a full bundle into one row per entity, per table, owner-stamped', () => {
    const bundle: ProjectBundle = {
      project: project('p1'),
      slates: [slate('s1', 'p1')],
      takes: [take('t1', 's1', 'p1')],
      moments: [moment('m1', 't1'), moment('m2', 't1')],
    };
    const groups = buildProjectRows(bundle, 'owner-abc');

    const byTable = Object.fromEntries(groups.map((g) => [g.table, g.rows]));
    expect(byTable.projects).toEqual([
      { id: 'p1', owner_id: 'owner-abc', project_id: null, data: bundle.project, deleted_at: null },
    ]);
    expect(byTable.slates).toEqual([
      { id: 's1', owner_id: 'owner-abc', project_id: 'p1', data: bundle.slates[0], deleted_at: null },
    ]);
    expect(byTable.takes[0]).toMatchObject({ id: 't1', project_id: 'p1', owner_id: 'owner-abc' });
    // Moments carry no projectId of their own — buildProjectRows must derive
    // it from the bundle's own project id.
    expect(byTable.moments).toEqual([
      { id: 'm1', owner_id: 'owner-abc', project_id: 'p1', data: bundle.moments[0], deleted_at: null },
      { id: 'm2', owner_id: 'owner-abc', project_id: 'p1', data: bundle.moments[1], deleted_at: null },
    ]);
  });

  it('omits table groups with zero rows (empty project still pushes its own row)', () => {
    const bundle: ProjectBundle = { project: project('p1'), slates: [], takes: [], moments: [] };
    const groups = buildProjectRows(bundle, 'owner-abc');
    expect(groups.map((g) => g.table)).toEqual(['projects']);
  });
});

// ----------------------------------------------------- groupTombstonesByTable

describe('groupTombstonesByTable', () => {
  it('buckets by table, preserving order within a bucket', () => {
    const tombstones: Tombstone[] = [
      { table: 'moments', id: 'm1', projectId: 'p1', deletedAt: 1, data: {} },
      { table: 'takes', id: 't1', projectId: 'p1', deletedAt: 1, data: {} },
      { table: 'moments', id: 'm2', projectId: 'p1', deletedAt: 1, data: {} },
    ];
    const grouped = groupTombstonesByTable(tombstones);
    expect(grouped.moments?.map((t) => t.id)).toEqual(['m1', 'm2']);
    expect(grouped.takes?.map((t) => t.id)).toEqual(['t1']);
    expect(grouped.slates).toBeUndefined();
    expect(grouped.projects).toBeUndefined();
  });

  it('empty input -> empty groups', () => {
    expect(groupTombstonesByTable([])).toEqual({});
  });
});

// --------------------------------------------------------- planPullApply ---

describe('planPullApply (delta-merge)', () => {
  it('a live row (deleted_at null) plans a local put of its data', () => {
    const row: PullRow = {
      id: 'p1',
      project_id: null,
      data: project('p1'),
      updated_at: '2026-07-26T00:00:00.000Z',
      deleted_at: null,
    };
    expect(planPullApply('projects', row)).toEqual({ op: 'put', table: 'projects', entity: row.data });
  });

  it('a tombstoned row (deleted_at set) plans a local delete', () => {
    const row: PullRow = {
      id: 'm1',
      project_id: 'p1',
      data: { stale: true },
      updated_at: '2026-07-26T00:00:00.000Z',
      deleted_at: '2026-07-26T00:00:01.000Z',
    };
    expect(planPullApply('moments', row)).toEqual({ op: 'delete', table: 'moments', id: 'm1' });
  });
});

// ----------------------------------------------------------- advanceCursor -

describe('advanceCursor', () => {
  it('advances to the max updated_at across a page of rows', () => {
    const rows = [
      { updated_at: '2026-07-26T00:00:01.000Z' },
      { updated_at: '2026-07-26T00:00:05.000Z' },
      { updated_at: '2026-07-26T00:00:03.000Z' },
    ];
    expect(advanceCursor(0, rows)).toBe(Date.parse('2026-07-26T00:00:05.000Z'));
  });

  it('never moves backward from the current cursor', () => {
    const future = Date.parse('2026-08-01T00:00:00.000Z');
    const rows = [{ updated_at: '2026-07-26T00:00:00.000Z' }];
    expect(advanceCursor(future, rows)).toBe(future);
  });

  it('an empty page leaves the cursor unchanged', () => {
    expect(advanceCursor(12345, [])).toBe(12345);
  });

  it('ignores an unparsable timestamp rather than corrupting the cursor', () => {
    const rows = [{ updated_at: 'not-a-date' }, { updated_at: '2026-07-26T00:00:00.000Z' }];
    expect(advanceCursor(0, rows)).toBe(Date.parse('2026-07-26T00:00:00.000Z'));
  });
});

// --------------------------------------------------------- backoffDelayMs --

describe('backoffDelayMs', () => {
  it('attempt 1 is bounded by [0, base)', () => {
    for (const r of [0, 0.5, 0.999]) {
      const d = backoffDelayMs(1, 1000, 30_000, () => r);
      expect(d).toBeGreaterThanOrEqual(0);
      expect(d).toBeLessThan(1000);
    }
  });

  it('doubles the exponent each attempt, still full-jitter down to 0', () => {
    expect(backoffDelayMs(2, 1000, 30_000, () => 0.999)).toBeLessThan(2000);
    expect(backoffDelayMs(3, 1000, 30_000, () => 0.999)).toBeLessThan(4000);
    expect(backoffDelayMs(1, 1000, 30_000, () => 0)).toBe(0);
  });

  it('never exceeds the cap, however high the attempt climbs', () => {
    const d = backoffDelayMs(20, 1000, 30_000, () => 0.999999);
    expect(d).toBeLessThanOrEqual(30_000);
  });

  it('a fixed rng gives a deterministic, reproducible delay', () => {
    expect(backoffDelayMs(4, 1000, 30_000, () => 0.5)).toBe(4000); // base*2^3=8000, *0.5=4000
  });
});

// ------------------------------------------------------------ nextRetryState

describe('nextRetryState', () => {
  it('increments failureCount and stays unparked below the attempt cap', () => {
    let state: RetryState = { failureCount: 0, parked: false };
    for (let i = 1; i < MAX_FLUSH_ATTEMPTS; i++) {
      state = nextRetryState(state);
      expect(state.parked).toBe(false);
      expect(state.failureCount).toBe(i);
    }
  });

  it('parks (and resets, not drops) once the attempt cap is reached', () => {
    let state: RetryState = { failureCount: 0, parked: false };
    for (let i = 0; i < MAX_FLUSH_ATTEMPTS; i++) state = nextRetryState(state);
    expect(state).toEqual({ failureCount: 0, parked: true });
  });

  it('respects a custom attempt cap', () => {
    const parked = nextRetryState({ failureCount: 2, parked: false }, 3);
    expect(parked).toEqual({ failureCount: 0, parked: true });
  });
});

// --------------------------------------------------------- debounce trigger

describe('createDebouncedTrigger', () => {
  it('fires once, debounceMs after the LAST ping in a burst', () => {
    vi.useFakeTimers();
    try {
      const run = vi.fn();
      const trigger = createDebouncedTrigger(run, 500, 5000);

      trigger.ping();
      vi.advanceTimersByTime(300);
      trigger.ping(); // re-arms the 500ms window
      vi.advanceTimersByTime(499);
      expect(run).not.toHaveBeenCalled();
      vi.advanceTimersByTime(1);
      expect(run).toHaveBeenCalledTimes(1);
    } finally {
      vi.useRealTimers();
    }
  });

  it('a continuous burst still flushes at the max-wait cap, not never', () => {
    vi.useFakeTimers();
    try {
      const run = vi.fn();
      const trigger = createDebouncedTrigger(run, 500, 5000);

      // Ping every 400ms — always inside the 500ms debounce window, so it
      // would never fire on debounce alone. The 5s max-wait must still fire.
      for (let elapsed = 0; elapsed < 5000; elapsed += 400) {
        trigger.ping();
        vi.advanceTimersByTime(400);
      }
      expect(run).toHaveBeenCalledTimes(1);
    } finally {
      vi.useRealTimers();
    }
  });

  it('cancel() suppresses a pending run', () => {
    vi.useFakeTimers();
    try {
      const run = vi.fn();
      const trigger = createDebouncedTrigger(run, 500, 5000);
      trigger.ping();
      trigger.cancel();
      vi.advanceTimersByTime(10_000);
      expect(run).not.toHaveBeenCalled();
    } finally {
      vi.useRealTimers();
    }
  });
});
