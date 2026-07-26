// Cloud sync engine: persisted-outbox -> debounced-batch-upsert -> delta-pull,
// bolted onto the side of the existing offline-first store. PURELY ADDITIVE —
// nothing in this file is imported by App.tsx/main.tsx yet (that wiring is
// done elsewhere); until something calls initSync(), this module does
// nothing at all.
//
// Design assumption (see docs): single-writer. One person, one device, one
// project during a shoot. True concurrent multi-device editing on the SAME
// project is rare, so last-write-wins keyed on the SERVER-stamped
// `updated_at` (see the migration's BEFORE INSERT OR UPDATE trigger) is
// sufficient — this is deliberately NOT a CRDT / version-vector scheme.
//
// Best-effort everywhere: every exported entry point swallows its own
// errors. A dead network, an expired session, or a Supabase outage degrades
// to "nothing syncs right now" — it never throws into the app, and it never
// touches the local store's own read/write paths (those live in
// src/store/index.ts and are untouched by this file).

import { supabase } from './supabase';
import { getAccessToken } from './auth';
import { rawDelete, rawPut, store } from '../store';
import {
  clearDirtyProjectIds,
  clearTombstones,
  getCursor,
  listDirtyProjectIds,
  listTombstones,
  onOutboxWrite,
  pendingCount,
  setCursor,
  SYNC_TABLES,
  type SyncTable,
  type Tombstone,
} from '../store/outbox';
import type { Moment, Project, ProjectBundle, Slate, Take } from '../types';

// ============================================================================
// Pure logic — the part of this file that's unit-testable without a network.
// Every function below takes plain data in, returns plain data out, and
// touches neither Supabase nor IndexedDB. src/net/sync.test.ts exercises
// these directly.
// ============================================================================

/** Split an array into chunks of at most `size` (Supabase upserts are capped to keep request bodies reasonable). */
export function chunk<T>(items: readonly T[], size: number): T[][] {
  if (size <= 0) return [items.slice()];
  const out: T[][] = [];
  for (let i = 0; i < items.length; i += size) out.push(items.slice(i, i + size));
  return out;
}

/** One row as the `projects`/`slates`/`takes`/`moments` tables store it. */
export interface SyncRow {
  id: string;
  owner_id: string;
  project_id: string | null;
  data: unknown;
  deleted_at: null;
}

/**
 * Turn a full project bundle into the per-table row batches a push writes.
 * Pure — no network. `updated_at` is deliberately never included: the
 * server's trigger stamps it, so the client can never skew the LWW cursor
 * with a drifted device clock (see the migration's §3 comment).
 */
export function buildProjectRows(
  bundle: ProjectBundle,
  ownerId: string,
): { table: SyncTable; rows: SyncRow[] }[] {
  const groups: { table: SyncTable; rows: SyncRow[] }[] = [
    {
      table: 'projects',
      rows: [{ id: bundle.project.id, owner_id: ownerId, project_id: null, data: bundle.project, deleted_at: null }],
    },
    {
      table: 'slates',
      rows: bundle.slates.map((s) => ({
        id: s.id,
        owner_id: ownerId,
        project_id: s.projectId,
        data: s,
        deleted_at: null,
      })),
    },
    {
      table: 'takes',
      rows: bundle.takes.map((t) => ({
        id: t.id,
        owner_id: ownerId,
        project_id: t.projectId,
        data: t,
        deleted_at: null,
      })),
    },
    {
      table: 'moments',
      // Moment doesn't carry a projectId of its own — every moment in this
      // bundle belongs to bundle.project by construction (getBundle(id) only
      // ever returns that one project's rows).
      rows: bundle.moments.map((m) => ({
        id: m.id,
        owner_id: ownerId,
        project_id: bundle.project.id,
        data: m,
        deleted_at: null,
      })),
    },
  ];
  return groups.filter((g) => g.rows.length > 0);
}

/** Group a flat tombstone list by table. Pure. */
export function groupTombstonesByTable(
  tombstones: readonly Tombstone[],
): Partial<Record<SyncTable, Tombstone[]>> {
  const out: Partial<Record<SyncTable, Tombstone[]>> = {};
  for (const t of tombstones) {
    (out[t.table] ??= []).push(t);
  }
  return out;
}

/** A row as it comes back from a delta-pull select. */
export interface PullRow {
  id: string;
  project_id: string | null;
  data: unknown;
  updated_at: string;
  deleted_at: string | null;
}

export type ApplyPlan =
  | { op: 'delete'; table: SyncTable; id: string }
  | { op: 'put'; table: SyncTable; entity: Project | Slate | Take | Moment };

/** Decide what a pulled row means for local storage: a tombstone -> delete, else -> put its data. Pure. */
export function planPullApply(table: SyncTable, row: PullRow): ApplyPlan {
  if (row.deleted_at) return { op: 'delete', table, id: row.id };
  return { op: 'put', table, entity: row.data as Project | Slate | Take | Moment };
}

/** The delta-pull cursor only ever moves forward: the max `updated_at` (epoch ms) seen across a page of rows, floored at `current`. Pure. */
export function advanceCursor(current: number, rows: readonly { updated_at: string }[]): number {
  let max = current;
  for (const r of rows) {
    const t = Date.parse(r.updated_at);
    if (Number.isFinite(t) && t > max) max = t;
  }
  return max;
}

/**
 * Exponential backoff with FULL jitter: a uniformly random delay between 0
 * and `min(cap, base * 2^(attempt-1))`. `attempt` is 1-based (the first
 * failure is attempt 1). `rand` is injectable so tests can assert exact
 * values instead of just bounds.
 */
export function backoffDelayMs(
  attempt: number,
  base = 1000,
  cap = 30_000,
  rand: () => number = Math.random,
): number {
  const exp = Math.min(cap, base * 2 ** Math.max(0, attempt - 1));
  return Math.floor(rand() * exp);
}

export const MAX_FLUSH_ATTEMPTS = 9;

export interface RetryState {
  failureCount: number;
  /** true the run that just tipped over MAX_FLUSH_ATTEMPTS — the caller parks the op (keeps it queued, stops the tight retry loop) rather than dropping it. */
  parked: boolean;
}

/** Pure state transition for the backoff attempt counter. A success resets it (call with `{ failureCount: 0, parked: false }` again, i.e. just start over). */
export function nextRetryState(state: RetryState, maxAttempts: number = MAX_FLUSH_ATTEMPTS): RetryState {
  const failureCount = state.failureCount + 1;
  if (failureCount >= maxAttempts) return { failureCount: 0, parked: true };
  return { failureCount, parked: false };
}

/**
 * A debounced trigger with a max-wait cap: `ping()` (re)starts a `debounceMs`
 * timer, but a burst of pings can never push `run()` out past `maxWaitMs`
 * from the FIRST ping in the burst. This is what lets continuous logging
 * (moment taps every few seconds) still flush every 5s instead of never,
 * while a quiet moment after the last write flushes quickly (500ms).
 */
export function createDebouncedTrigger(run: () => void, debounceMs = 500, maxWaitMs = 5000) {
  let debounceTimer: ReturnType<typeof setTimeout> | null = null;
  let maxWaitTimer: ReturnType<typeof setTimeout> | null = null;

  function clear(): void {
    if (debounceTimer) {
      clearTimeout(debounceTimer);
      debounceTimer = null;
    }
    if (maxWaitTimer) {
      clearTimeout(maxWaitTimer);
      maxWaitTimer = null;
    }
  }

  function ping(): void {
    if (debounceTimer) clearTimeout(debounceTimer);
    debounceTimer = setTimeout(() => {
      clear();
      run();
    }, debounceMs);
    if (!maxWaitTimer) {
      maxWaitTimer = setTimeout(() => {
        clear();
        run();
      }, maxWaitMs);
    }
  }

  return { ping, cancel: clear };
}

// ============================================================================
// Status signal — a tiny subscribable the UI can read (another agent wires
// this into the UI; this file only ever writes to it).
// ============================================================================

export interface SyncStatus {
  state: 'idle' | 'syncing' | 'offline' | 'error';
  pending: number;
}

let status: SyncStatus = { state: 'idle', pending: 0 };
const statusListeners = new Set<(s: SyncStatus) => void>();

export function getSyncStatus(): SyncStatus {
  return status;
}

export function onSyncStatusChange(cb: (s: SyncStatus) => void): () => void {
  statusListeners.add(cb);
  return () => statusListeners.delete(cb);
}

function setStatus(patch: Partial<SyncStatus>): void {
  status = { ...status, ...patch };
  for (const cb of statusListeners) {
    try {
      cb(status);
    } catch {
      /* a listener's own bug must never break the sync engine */
    }
  }
}

// ============================================================================
// Network glue — everything below actually talks to Supabase / IndexedDB and
// is intentionally NOT unit tested (per the brief: extract pure cores for
// that; this is just wiring around them). Every entry point is best-effort.
// ============================================================================

/**
 * Single-flusher lock across tabs: if the Web Locks API is available, only
 * one tab at a time runs `fn`; a tab that can't get the lock immediately
 * just skips this round (the next trigger — debounce, sweep, reconnect —
 * tries again, so nothing is lost, just deferred). Falls back to running
 * unlocked if Web Locks isn't supported.
 */
async function withFlushLock(fn: () => Promise<void>): Promise<void> {
  const locks = typeof navigator !== 'undefined' ? navigator.locks : undefined;
  if (!locks || typeof locks.request !== 'function') {
    await fn();
    return;
  }
  try {
    await locks.request('clapper-sync-flush', { ifAvailable: true }, async (lock) => {
      if (!lock) return; // another tab holds it this round — skip, don't block
      await fn();
    });
  } catch {
    // Some environments advertise Web Locks but throw on use (rare) — don't
    // let that take sync down entirely.
    await fn();
  }
}

async function currentOwnerId(): Promise<string | null> {
  const { data } = await supabase.auth.getSession();
  return data.session?.user.id ?? null;
}

/** Push every queued tombstone. Children (moments/takes/slates) first via soft-delete upsert, `projects` last via a real hard DELETE (its FK cascade removes any children a soft-delete upsert just re-created). */
async function pushTombstones(ownerId: string): Promise<void> {
  const tombstones = await listTombstones();
  if (tombstones.length === 0) return;
  const grouped = groupTombstonesByTable(tombstones);

  for (const table of ['moments', 'takes', 'slates'] as const) {
    const items = grouped[table];
    if (!items || items.length === 0) continue;
    for (const batch of chunk(items, 500)) {
      const rows = batch.map((t) => ({
        id: t.id,
        owner_id: ownerId,
        project_id: t.projectId,
        data: t.data,
        deleted_at: new Date().toISOString(),
      }));
      const { error } = await supabase.from(table).upsert(rows, { onConflict: 'id' });
      if (error) throw error;
    }
    await clearTombstones(items.map((t) => ({ table: t.table, id: t.id })));
  }

  const projectItems = grouped.projects ?? [];
  for (const batch of chunk(projectItems, 500)) {
    const ids = batch.map((t) => t.id);
    const { error } = await supabase.from('projects').delete().in('id', ids);
    if (error) throw error;
    await clearTombstones(batch.map((t) => ({ table: 'projects' as const, id: t.id })));
  }
}

/** Push every dirty project's full bundle. */
async function pushDirtyProjects(ownerId: string): Promise<void> {
  const projectIds = await listDirtyProjectIds();
  for (const projectId of projectIds) {
    let bundle: ProjectBundle;
    try {
      bundle = await store.getBundle(projectId);
    } catch (err) {
      // The project was deleted locally after being marked dirty but before
      // this flush ran (deleteProject already queued its own tombstone for
      // it) — nothing left to push, just drop the stale dirty flag.
      if (err instanceof Error && /not found/i.test(err.message)) {
        await clearDirtyProjectIds([projectId]);
        continue;
      }
      throw err;
    }

    for (const { table, rows } of buildProjectRows(bundle, ownerId)) {
      for (const batch of chunk(rows, 500)) {
        const { error } = await supabase.from(table).upsert(batch, { onConflict: 'id' });
        if (error) throw error;
      }
    }
    await clearDirtyProjectIds([projectId]);
  }
}

let retryState: RetryState = { failureCount: 0, parked: false };
let retryTimer: ReturnType<typeof setTimeout> | null = null;

/** One push attempt: tombstones, then dirty bundles. Best-effort with backoff on failure; never throws out. */
async function flush(): Promise<void> {
  const token = await getAccessToken();
  if (!token) {
    setStatus({ state: 'offline', pending: await pendingCount() });
    return; // no session -> sync is a no-op, not an error
  }
  if (typeof navigator !== 'undefined' && navigator.onLine === false) {
    setStatus({ state: 'offline', pending: await pendingCount() });
    return; // being offline isn't a failure worth burning a backoff attempt on
  }

  try {
    await withFlushLock(async () => {
      const ownerId = await currentOwnerId();
      if (!ownerId) return;
      setStatus({ state: 'syncing', pending: await pendingCount() });
      await pushTombstones(ownerId);
      await pushDirtyProjects(ownerId);
    });

    retryState = { failureCount: 0, parked: false };
    if (retryTimer) {
      clearTimeout(retryTimer);
      retryTimer = null;
    }
    setStatus({ state: 'idle', pending: await pendingCount() });
  } catch (err) {
    console.warn('Clapper sync: push failed (will retry with backoff).', err);
    retryState = nextRetryState(retryState);
    setStatus({ state: 'error', pending: await pendingCount() });

    if (retryState.parked) {
      // Attempt budget spent for this burst. The failed rows stay queued —
      // NEVER dropped — and get another full attempt budget the next time
      // something pings us (a new local write, reconnect, the periodic
      // sweep, or the app reopening).
      return;
    }

    const delay = backoffDelayMs(retryState.failureCount);
    if (retryTimer) clearTimeout(retryTimer);
    retryTimer = setTimeout(() => {
      retryTimer = null;
      void flush();
    }, delay);
  }
}

/** Delta-pull one table forward from its persisted cursor, paginating 1000 rows at a time. */
async function pullTable(table: SyncTable): Promise<void> {
  let cursor = await getCursor(table);
  // Cap pagination so a pathological backlog can't spin this forever in one
  // call — the periodic sweep / next trigger picks up wherever this leaves off.
  for (let page = 0; page < 50; page++) {
    const { data, error } = await supabase
      .from(table)
      .select('id, project_id, data, updated_at, deleted_at')
      .gt('updated_at', new Date(cursor).toISOString())
      .order('updated_at', { ascending: true })
      .limit(1000);
    if (error) throw error;
    const rows = (data ?? []) as PullRow[];
    if (rows.length === 0) break;

    for (const row of rows) {
      const plan = planPullApply(table, row);
      if (plan.op === 'delete') await rawDelete(plan.table, plan.id);
      else await rawPut(plan.table, plan.entity);
    }

    cursor = advanceCursor(cursor, rows);
    await setCursor(table, cursor);
    if (rows.length < 1000) break; // last page
  }
}

/** Full delta pull across all four tables. Fresh device (cursor=0) hydrates everything. */
export async function pull(): Promise<void> {
  const token = await getAccessToken();
  if (!token) return; // no session -> nothing to pull, not an error
  try {
    setStatus({ state: 'syncing', pending: await pendingCount() });
    for (const table of SYNC_TABLES) {
      await pullTable(table);
    }
    setStatus({ state: 'idle', pending: await pendingCount() });
  } catch (err) {
    console.warn('Clapper sync: pull failed (will retry on the next trigger).', err);
    setStatus({ state: 'error', pending: await pendingCount() });
  }
}

let initialized = false;

/**
 * Wire up the sync engine: subscribes to local-write notifications (debounced
 * flush, 500ms/5s-max-wait), `online`, `visibilitychange`->hidden, `pagehide`,
 * and a periodic safety sweep, then kicks an initial pull. Idempotent — safe
 * to call more than once (e.g. a hot-reloading dev session); only the first
 * call does anything. Call this once the app is ready to sync (deliberately
 * NOT wired into App.tsx/main.tsx by this file — the caller decides when).
 */
export function initSync(): void {
  if (initialized) return;
  initialized = true;
  if (typeof window === 'undefined') return; // no-op outside a browser (e.g. under test)

  const trigger = createDebouncedTrigger(() => void flush(), 500, 5_000);
  onOutboxWrite(() => trigger.ping());

  window.addEventListener('online', () => {
    void pull();
    void flush();
  });
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'hidden') void flush();
  });
  window.addEventListener('pagehide', () => {
    void flush();
  });
  // Safety sweep: catches anything the event-driven triggers missed (e.g. a
  // failed flush that got parked, or a write that happened while this tab
  // was backgrounded and never fired 'visibilitychange' again).
  setInterval(() => void flush(), 45_000);

  // A session may not exist yet when initSync runs — on a cold load the OAuth
  // PKCE return is still resolving, and sync no-ops without a token. Re-run
  // pull+flush whenever a session actually appears or its token refreshes, so
  // signing in on a fresh device hydrates existing projects without a manual
  // reload. (INITIAL_SESSION is intentionally skipped — the initial pull below
  // already covers the persisted-session reload, and it also fires with a null
  // session, which would just no-op.)
  supabase.auth.onAuthStateChange((event) => {
    if (event === 'SIGNED_IN' || event === 'TOKEN_REFRESHED') {
      void pull();
      void flush();
    }
  });

  void pull(); // initial hydrate / catch-up on app open (persisted session)
}
