// The sync outbox: a small, best-effort persistence layer the store facade
// (index.ts) writes into after every local mutation, and the sync engine
// (src/net/sync.ts) drains. This is ADDITIVE plumbing bolted onto the side of
// the real local store — it never blocks, delays, or can fail a local write.
//
// Lives in its OWN IndexedDB database (`clapper-sync`), separate from the
// main `clapper` data DB in idb.ts. That keeps this module free to add
// stores / bump its own version without ever touching the main DB's
// upgrade path (and vice versa) — the two are wired together only by the
// entity ids and timestamps they both know about.
//
// Everything here is designed to survive an app crash / a phone dying
// mid-shoot: a dirty-project mark, a tombstone, or a pull cursor written here
// is still on disk the next time the PWA boots, so a flush that never
// finished before the crash still gets tried again.

import { openDB, type DBSchema, type IDBPDatabase } from 'idb';
import type { Moment, Project, ProjectBundle, Slate, Take } from '../types';

// ---------------------------------------------------------------- shapes ---

/** The four entity tables the sync engine mirrors, 1:1 with the Supabase migration. */
export type SyncTable = 'projects' | 'slates' | 'takes' | 'moments';

export const SYNC_TABLES: readonly SyncTable[] = ['projects', 'slates', 'takes', 'moments'];

/**
 * A queued delete. Captured BEFORE the local delete runs (the facade reads
 * the doomed row first — see index.ts's deleteMoment/deleteTake/deleteSlate/
 * deleteProject), so `data` is a snapshot of the entity as it last existed
 * locally. That snapshot travels with the tombstone so the push side can
 * satisfy the server's `data jsonb not null` constraint on a soft-delete
 * upsert without a network round trip to fetch "what was this row" first —
 * the content doesn't matter once deleted_at is set, only that it's valid.
 */
export interface Tombstone {
  table: SyncTable;
  id: string;
  // The project this row belonged to. Always present, even for a `projects`
  // tombstone itself (where it equals that project's own id) — the field
  // that lets project_id ride along on every row the same way.
  projectId: string;
  deletedAt: number; // epoch ms this device recorded the delete (informational — the server's own trigger-stamped updated_at is authoritative)
  data: unknown;      // last known local snapshot of the entity (Project | Slate | Take | Moment)
}

/**
 * Low-level per-backend operations the sync engine needs that the normal
 * Store contract doesn't expose: a cheap single-record lookup by id (used to
 * walk id -> parent id, e.g. a moment's takeId -> that take's projectId,
 * without loading a whole bundle), and a way to apply a server row to local
 * storage / remove a local row WITHOUT going through the enqueue-wrapped
 * Store methods in index.ts (that would re-dirty the very row we're pulling
 * down, and loop forever). Both idb.ts and local.ts implement this on top of
 * their existing backend — plain storage ops, no business logic (no clip
 * counters, no cascades).
 */
export interface RawStore {
  rawGet(table: SyncTable, id: string): Promise<Project | Slate | Take | Moment | undefined>;
  rawPut(table: SyncTable, entity: Project | Slate | Take | Moment): Promise<void>;
  rawDelete(table: SyncTable, id: string): Promise<void>;
}

// ------------------------------------------------------------ IDB schema ---

interface DirtyRow {
  projectId: string;
  markedAt: number;
}

interface TombstoneRow extends Tombstone {
  key: string; // `${table}:${id}` — the object store's keyPath
}

interface CursorRow {
  table: SyncTable;
  updatedAtMs: number;
}

interface SyncDB extends DBSchema {
  dirty: { key: string; value: DirtyRow };
  tombstones: { key: string; value: TombstoneRow };
  cursors: { key: string; value: CursorRow };
}

function tombstoneKey(table: SyncTable, id: string): string {
  return `${table}:${id}`;
}

let dbPromise: Promise<IDBPDatabase<SyncDB> | null> | null = null;

/**
 * Open (or reuse) the outbox's own IndexedDB database. Resolves `null` —
 * never rejects — if IndexedDB is unavailable or misbehaves, matching the
 * "sync is best-effort, never breaks the app" principle: every public
 * function in this file treats a null db as "outbox unavailable this
 * session" and quietly no-ops rather than surfacing an error.
 */
function openOutboxDb(): Promise<IDBPDatabase<SyncDB> | null> {
  if (!dbPromise) {
    dbPromise = (async () => {
      try {
        if (typeof indexedDB === 'undefined') return null;
        const db = await openDB<SyncDB>('clapper-sync', 1, {
          upgrade(database) {
            database.createObjectStore('dirty', { keyPath: 'projectId' });
            database.createObjectStore('tombstones', { keyPath: 'key' });
            database.createObjectStore('cursors', { keyPath: 'table' });
          },
        });
        // Prove the handle actually works (mirrors idb.ts's file:// sandbox
        // guard) before we trust it for the rest of the session.
        await db.getAll('dirty');
        return db;
      } catch (err) {
        console.warn('Clapper sync: outbox IndexedDB unavailable; sync will sit idle this session.', err);
        return null;
      }
    })();
  }
  return dbPromise;
}

// ------------------------------------------------------- pure dirty-set ---

/**
 * Pure set-add: fold a newly-dirtied project id into an existing list,
 * deduped. This is the coalescing contract N rapid edits to the same project
 * rely on — real persistence below achieves the same result "for free" via
 * an IndexedDB `put` keyed by projectId (a second put for the same id just
 * overwrites the first), but this pure form is what makes that contract
 * directly unit-testable without a browser.
 */
export function coalesceDirty(existingIds: readonly string[], projectId: string): string[] {
  return existingIds.includes(projectId) ? existingIds.slice() : [...existingIds, projectId];
}

// --------------------------------------------------------- write pub/sub ---
// The facade (index.ts) and the sync engine (src/net/sync.ts) never import
// each other — that would be a cycle (sync.ts already needs the facade's
// store + raw ops). Instead the facade tells THIS module "something
// changed", and the sync engine subscribes here to know when to (re)start
// its debounce timer. Neither side needs to know the other exists.

type WriteListener = () => void;
const writeListeners = new Set<WriteListener>();

/** Sync engine hook: fires after every markProjectDirty/addTombstones call. */
export function onOutboxWrite(cb: WriteListener): () => void {
  writeListeners.add(cb);
  return () => writeListeners.delete(cb);
}

function notifyWrite(): void {
  for (const cb of writeListeners) {
    try {
      cb();
    } catch {
      /* a listener's own bug must never break the write path that called us */
    }
  }
}

// -------------------------------------------------------------- dirty API --

/** Mark a project as having local changes the sync engine should push. Best-effort, never throws. */
export async function markProjectDirty(projectId: string): Promise<void> {
  try {
    const db = await openOutboxDb();
    if (db) await db.put('dirty', { projectId, markedAt: Date.now() });
  } catch {
    /* best-effort — the local write already succeeded regardless */
  }
  notifyWrite();
}

export async function listDirtyProjectIds(): Promise<string[]> {
  try {
    const db = await openOutboxDb();
    if (!db) return [];
    const rows = await db.getAll('dirty');
    // Defensive dedupe through the same pure rule markProjectDirty relies on
    // (IDB's keyPath put already prevents duplicates in the common case; this
    // just makes sure a caller never sees one even if that ever changes).
    let ids: string[] = [];
    for (const row of rows) ids = coalesceDirty(ids, row.projectId);
    return ids;
  } catch {
    return [];
  }
}

export async function clearDirtyProjectIds(ids: readonly string[]): Promise<void> {
  if (ids.length === 0) return;
  try {
    const db = await openOutboxDb();
    if (!db) return;
    const tx = db.transaction('dirty', 'readwrite');
    await Promise.all(ids.map((id) => tx.store.delete(id)));
    await tx.done;
  } catch {
    /* best-effort */
  }
}

// --------------------------------------------------------- tombstone API ---

/** Build one tombstone from a doomed entity. Pure — the caller supplies the projectId (already known from the entity itself, or its parent). */
export function tombstone(table: SyncTable, entity: { id: string }, projectId: string, now: number): Tombstone {
  return { table, id: entity.id, projectId, deletedAt: now, data: entity };
}

/** Build one tombstone per entity in a list, same table/projectId/timestamp. Pure. */
export function tombstonesFor<T extends { id: string }>(
  table: SyncTable,
  entities: readonly T[],
  projectId: string,
  now: number,
): Tombstone[] {
  return entities.map((e) => tombstone(table, e, projectId, now));
}

/** Every row in a project bundle, tombstoned at once — the deleteProject case. Pure. */
export function tombstonesForBundle(bundle: ProjectBundle, now: number): Tombstone[] {
  const projectId = bundle.project.id;
  return [
    tombstone('projects', bundle.project, projectId, now),
    ...tombstonesFor('slates', bundle.slates, projectId, now),
    ...tombstonesFor('takes', bundle.takes, projectId, now),
    ...tombstonesFor('moments', bundle.moments, projectId, now),
  ];
}

/** Persist tombstones for the sync engine to push. Best-effort, never throws. */
export async function addTombstones(list: readonly Tombstone[]): Promise<void> {
  if (list.length === 0) return;
  try {
    const db = await openOutboxDb();
    if (db) {
      const tx = db.transaction('tombstones', 'readwrite');
      for (const t of list) {
        await tx.store.put({ ...t, key: tombstoneKey(t.table, t.id) });
      }
      await tx.done;
    }
  } catch {
    /* best-effort */
  }
  notifyWrite();
}

export async function listTombstones(): Promise<Tombstone[]> {
  try {
    const db = await openOutboxDb();
    if (!db) return [];
    const rows = await db.getAll('tombstones');
    return rows.map(({ key: _key, ...t }) => t);
  } catch {
    return [];
  }
}

export async function clearTombstones(items: readonly { table: SyncTable; id: string }[]): Promise<void> {
  if (items.length === 0) return;
  try {
    const db = await openOutboxDb();
    if (!db) return;
    const tx = db.transaction('tombstones', 'readwrite');
    await Promise.all(items.map((i) => tx.store.delete(tombstoneKey(i.table, i.id))));
    await tx.done;
  } catch {
    /* best-effort */
  }
}

// ------------------------------------------------------------- cursor API --

/** The delta-pull cursor for one table: the max server updated_at (epoch ms) applied so far. 0 = never pulled (full hydrate). */
export async function getCursor(table: SyncTable): Promise<number> {
  try {
    const db = await openOutboxDb();
    if (!db) return 0;
    const row = await db.get('cursors', table);
    return row?.updatedAtMs ?? 0;
  } catch {
    return 0;
  }
}

export async function setCursor(table: SyncTable, updatedAtMs: number): Promise<void> {
  try {
    const db = await openOutboxDb();
    if (db) await db.put('cursors', { table, updatedAtMs });
  } catch {
    /* best-effort — worst case the next pull re-applies some already-applied rows, which rawPut/rawDelete handle idempotently */
  }
}

// ---------------------------------------------------------- status counts --

/** How many dirty projects + queued tombstones are waiting to be pushed. Best-effort, used only for the status signal — never throws. */
export async function pendingCount(): Promise<number> {
  const [dirty, tombstones] = await Promise.all([listDirtyProjectIds(), listTombstones()]);
  return dirty.length + tombstones.length;
}
