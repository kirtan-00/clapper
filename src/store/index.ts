import type { Moment, Project, Slate, Store, Take } from '../types';
import { openIdbStore } from './idb';
import { createLocalStore } from './local';
import {
  addTombstones,
  markProjectDirty,
  tombstone,
  tombstonesFor,
  tombstonesForBundle,
  type RawStore,
  type SyncTable,
  type Tombstone,
} from './outbox';

// Pick a storage backend at runtime. We prefer IndexedDB (the normal PWA case).
// On file:// in some browsers — and in private windows — IndexedDB is blocked
// or hands back a handle that throws on first use, so we fall back to a
// localStorage-backed store silently. Both implement the same Store contract.
//
// The chosen backend is resolved lazily and memoised, so the pick happens once
// on the first store call and every later call reuses it.
//
// SYNC NOTE: both backends also implement RawStore (rawGet/rawPut/rawDelete —
// see outbox.ts), a low-level bypass the enqueueing below and the sync engine
// (src/net/sync.ts) use. `backend()` returns the richer type internally; the
// exported `store` is still typed as plain `Store`, so every existing caller
// keeps seeing exactly the contract it always has.

let backendPromise: Promise<Store & RawStore> | null = null;

function pickBackend(): Promise<Store & RawStore> {
  return openIdbStore().catch((err) => {
    console.warn('Clapper: IndexedDB unavailable, using localStorage store.', err);
    return createLocalStore();
  });
}

function backend(): Promise<Store & RawStore> {
  if (!backendPromise) backendPromise = pickBackend();
  return backendPromise;
}

// ---------------------------------------------------------------------------
// Sync enqueueing. PURELY ADDITIVE: every helper below runs AFTER a local
// write has already resolved (or, for deletes, reads what it needs BEFORE
// delegating so the row still exists to read — the delete itself is still
// the very next thing that happens, unchanged). None of this can throw into
// the caller (markProjectDirty/addTombstones are best-effort internally) and
// none of it is awaited before a facade method returns its result, so a dead
// network or a broken outbox DB can never slow down or fail a local write.
//
// `void expr` below is deliberate: we're firing the enqueue and moving on,
// not waiting on it.

/** Cheap parent lookup: a moment/take only carries enough to walk UP to its project id (moment -> take.projectId; take already carries projectId directly). */
async function projectIdForTake(b: RawStore, takeId: string): Promise<string | undefined> {
  try {
    const take = (await b.rawGet('takes', takeId)) as Take | undefined;
    return take?.projectId;
  } catch {
    return undefined;
  }
}

/** Fire-and-forget: mark a project dirty so the sync engine pushes its bundle on the next flush. */
function dirty(projectId: string): void {
  void markProjectDirty(projectId);
}

// A thin facade over the resolved backend. Every method awaits the pick, then
// delegates. Consumers keep importing `store` and calling it exactly as before.
export const store: Store = {
  listProjects: async () => (await backend()).listProjects(),
  getProject: async (id) => (await backend()).getProject(id),

  createProject: async (p) => {
    const result = await (await backend()).createProject(p);
    dirty(result.id);
    return result;
  },

  updateProject: async (id, patch) => {
    const result = await (await backend()).updateProject(id, patch);
    dirty(id);
    return result;
  },

  deleteProject: async (id) => {
    const b = await backend();
    // Snapshot the ENTIRE bundle before it's gone — deleteProject tombstones
    // project + every slate/take/moment underneath it in one shot, so a pull
    // on another device (or this one, after a failed push retried later)
    // sees the whole subtree as deleted rather than an orphaned remainder.
    // Best-effort: if this read fails, the local delete still proceeds
    // unchanged — we just lose this device's chance to propagate it.
    let tombstones: Tombstone[] = [];
    try {
      const bundle = await b.getBundle(id);
      tombstones = tombstonesForBundle(bundle, Date.now());
    } catch {
      /* best-effort snapshot only */
    }

    const result = await b.deleteProject(id);

    if (tombstones.length > 0) void addTombstones(tombstones);
    // No dirty(id) here: the project is gone, there's no bundle left to push.
    return result;
  },

  listSlates: async (projectId) => (await backend()).listSlates(projectId),

  createSlate: async (projectId, name) => {
    const result = await (await backend()).createSlate(projectId, name);
    dirty(projectId);
    return result;
  },

  updateSlate: async (id, patch) => {
    const result = await (await backend()).updateSlate(id, patch);
    dirty(result.projectId);
    return result;
  },

  deleteSlate: async (id) => {
    const b = await backend();
    let tombstones: Tombstone[] = [];
    let projectId: string | undefined;
    try {
      const slate = (await b.rawGet('slates', id)) as Slate | undefined;
      if (slate) {
        projectId = slate.projectId;
        const takes = await b.listTakes(id);
        const momentLists = await Promise.all(takes.map((t) => b.listMoments(t.id)));
        const moments = momentLists.flat();
        const now = Date.now();
        tombstones = [
          tombstone('slates', slate, projectId, now),
          ...tombstonesFor('takes', takes, projectId, now),
          ...tombstonesFor('moments', moments, projectId, now),
        ];
      }
    } catch {
      /* best-effort snapshot only; the local delete below still proceeds */
    }

    const result = await b.deleteSlate(id);

    if (tombstones.length > 0) void addTombstones(tombstones);
    if (projectId) dirty(projectId);
    return result;
  },

  reorderSlates: async (projectId, orderedSlateIds) => {
    const result = await (await backend()).reorderSlates(projectId, orderedSlateIds);
    dirty(projectId);
    return result;
  },

  listTakes: async (slateId) => (await backend()).listTakes(slateId),

  createTake: async (input) => {
    const result = await (await backend()).createTake(input);
    dirty(input.projectId);
    return result;
  },

  updateTake: async (id, patch) => {
    const result = await (await backend()).updateTake(id, patch);
    dirty(result.projectId);
    return result;
  },

  rebaseClips: async (projectId, takeId, newNumbers, soundNumber) => {
    const result = await (await backend()).rebaseClips(projectId, takeId, newNumbers, soundNumber);
    dirty(projectId);
    return result;
  },

  deleteTake: async (id) => {
    const b = await backend();
    let tombstones: Tombstone[] = [];
    let projectId: string | undefined;
    try {
      const take = (await b.rawGet('takes', id)) as Take | undefined;
      if (take) {
        projectId = take.projectId;
        const moments = await b.listMoments(id);
        const now = Date.now();
        tombstones = [tombstone('takes', take, projectId, now), ...tombstonesFor('moments', moments, projectId, now)];
      }
    } catch {
      /* best-effort snapshot only; the local delete below still proceeds */
    }

    const result = await b.deleteTake(id);

    if (tombstones.length > 0) void addTombstones(tombstones);
    // deleteTake can also shift sibling takes' clip numbers (reclaimClipNumbers
    // in util.ts) and the project's own counters — mark the project dirty so
    // that surviving, mutated bundle gets pushed too, not just the tombstone.
    if (projectId) dirty(projectId);
    return result;
  },

  listMoments: async (takeId) => (await backend()).listMoments(takeId),

  createMoment: async (m) => {
    const b = await backend();
    const result = await b.createMoment(m);
    void (async () => {
      const projectId = await projectIdForTake(b, result.takeId);
      if (projectId) dirty(projectId);
    })();
    return result;
  },

  updateMoment: async (id, patch) => {
    const b = await backend();
    const result = await b.updateMoment(id, patch);
    void (async () => {
      const projectId = await projectIdForTake(b, result.takeId);
      if (projectId) dirty(projectId);
    })();
    return result;
  },

  deleteMoment: async (id) => {
    const b = await backend();
    let tombstones: Tombstone[] = [];
    let projectId: string | undefined;
    try {
      const moment = (await b.rawGet('moments', id)) as Moment | undefined;
      if (moment) {
        const take = (await b.rawGet('takes', moment.takeId)) as Take | undefined;
        if (take) {
          projectId = take.projectId;
          tombstones = tombstonesFor('moments', [moment], projectId, Date.now());
        }
      }
    } catch {
      /* best-effort snapshot only; the local delete below still proceeds */
    }

    const result = await b.deleteMoment(id);

    if (tombstones.length > 0) void addTombstones(tombstones);
    if (projectId) dirty(projectId);
    return result;
  },

  getBundle: async (projectId) => (await backend()).getBundle(projectId),
};

// ---------------------------------------------------------------------------
// Raw pull-apply path for the sync engine (src/net/sync.ts). Writes a server
// row straight into whichever backend is active, or removes a local row —
// WITHOUT touching the outbox (no dirty mark, no tombstone), so applying a
// pulled row can never loop back into another push. Exported here (rather
// than reaching into idb.ts/local.ts directly) so the sync engine only ever
// needs to import from '../store', same as every other consumer.

export async function rawPut(table: SyncTable, entity: Project | Slate | Take | Moment): Promise<void> {
  const b = await backend();
  await b.rawPut(table, entity);
}

export async function rawDelete(table: SyncTable, id: string): Promise<void> {
  const b = await backend();
  await b.rawDelete(table, id);
}
