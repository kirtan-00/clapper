import { openDB, type DBSchema, type IDBPDatabase } from 'idb';
import type { Moment, Project, ProjectBundle, Slate, Store, Take } from '../types';
import {
  buildTakeClips,
  bundleTakeComparator,
  newId,
  nextTakeNumber,
  notFound,
  reassignTakeTo,
  rebaseClipNumbers,
  reclaimClipNumbers,
  reorderSlateList,
  shotOrderIndex,
  summarizeProject,
} from './util';
import type { RawStore, SyncTable } from './outbox';

interface ClapperDB extends DBSchema {
  projects: { key: string; value: Project };
  slates: { key: string; value: Slate; indexes: { byProject: string } };
  // `byShot` holds ONLY shot-scoped takes: IndexedDB skips any record whose key
  // path is undefined, so a legacy take with no `shotId` is simply not in it.
  // That is exactly what per-shot take numbering wants — but it also means this
  // index can never be used to find a scene-level take. Those go through
  // `bySlate` (which every take is in, shot-scoped or not) with an explicit
  // "no shotId" filter.
  takes: { key: string; value: Take; indexes: { bySlate: string; byShot: string; byProject: string } };
  moments: { key: string; value: Moment; indexes: { byTake: string } };
}

/**
 * Schema version. Bumped 1 -> 2 to add the `byShot` index on `takes`.
 *
 * Every block in `upgrade` below is guarded on `oldVersion` because this
 * callback runs on EXISTING installs too: a fresh browser arrives with
 * oldVersion 0 and needs the stores created, while a device that already has
 * data arrives with oldVersion 1, already owns all four stores, and would throw
 * ConstraintError the moment we called createObjectStore again.
 */
const DB_VERSION = 2;

/**
 * Open the IndexedDB database and return a Store bound to it. Rejects if
 * IndexedDB is unavailable, blocked, or the open request errors (as happens in
 * some browsers on file:// or in private windows). The picker in index.ts
 * catches that rejection and falls back to the localStorage store.
 */
export async function openIdbStore(): Promise<Store & RawStore> {
  if (typeof indexedDB === 'undefined') {
    throw new Error('IndexedDB unavailable');
  }

  const db: IDBPDatabase<ClapperDB> = await openDB<ClapperDB>('clapper', DB_VERSION, {
    upgrade(database, oldVersion, _newVersion, transaction) {
      // v1: the original four stores. Runs only on a database that doesn't
      // have them yet (oldVersion 0 — a browser that has never opened Clapper).
      if (oldVersion < 1) {
        database.createObjectStore('projects', { keyPath: 'id' });
        const slates = database.createObjectStore('slates', { keyPath: 'id' });
        slates.createIndex('byProject', 'projectId');
        const takes = database.createObjectStore('takes', { keyPath: 'id' });
        takes.createIndex('bySlate', 'slateId');
        takes.createIndex('byProject', 'projectId');
        const moments = database.createObjectStore('moments', { keyPath: 'id' });
        moments.createIndex('byTake', 'takeId');
      }

      // v2: per-shot take numbering needs to find a shot's takes without
      // scanning the scene. The `takes` store already exists here — either the
      // block above just made it, or the device has been carrying it since v1 —
      // so we reach it through the version-change transaction and add the index
      // in place. `createObjectStore` would throw ConstraintError. Existing rows
      // are back-filled by the browser automatically; the legacy ones have no
      // `shotId`, so they are skipped and the index holds only shot-scoped
      // takes, which is precisely the intent.
      if (oldVersion < 2) {
        transaction.objectStore('takes').createIndex('byShot', 'shotId');
      }
    },
  });

  // Prove the connection actually works (a bad file:// sandbox can hand back a
  // db handle that throws on first use). If this read fails we reject and the
  // caller falls back to localStorage.
  await db.getAll('projects');

  return {
    async listProjects() {
      return db.getAll('projects');
    },

    async getProject(id) {
      return db.get('projects', id);
    },

    async createProject(p) {
      const now = Date.now();
      const project: Project = { ...p, id: newId(), createdAt: now, updatedAt: now };
      await db.put('projects', project);
      return project;
    },

    async updateProject(id, patch) {
      const tx = db.transaction('projects', 'readwrite');
      const existing = (await tx.store.get(id)) ?? notFound('project', id);
      const updated: Project = { ...existing, ...patch, id, updatedAt: Date.now() };
      await tx.store.put(updated);
      await tx.done;
      return updated;
    },

    async deleteProject(id) {
      const tx = db.transaction(['projects', 'slates', 'takes', 'moments'], 'readwrite');
      const slateIds = await tx.objectStore('slates').index('byProject').getAllKeys(id);
      const takeIds = await tx.objectStore('takes').index('byProject').getAllKeys(id);
      const moments = tx.objectStore('moments');
      for (const takeId of takeIds) {
        const momentIds = await moments.index('byTake').getAllKeys(takeId);
        await Promise.all(momentIds.map((m) => moments.delete(m)));
      }
      await Promise.all(takeIds.map((t) => tx.objectStore('takes').delete(t)));
      await Promise.all(slateIds.map((s) => tx.objectStore('slates').delete(s)));
      await tx.objectStore('projects').delete(id);
      await tx.done;
    },

    async listSlates(projectId) {
      const slates = await db.getAllFromIndex('slates', 'byProject', projectId);
      return slates.sort((a, b) => a.order - b.order);
    },

    async createSlate(projectId, name) {
      const tx = db.transaction('slates', 'readwrite');
      const existing = await tx.store.index('byProject').getAll(projectId);
      const order = existing.reduce((max, s) => Math.max(max, s.order), -1) + 1;
      const now = Date.now();
      const slate: Slate = { id: newId(), projectId, name, order, createdAt: now, updatedAt: now };
      await tx.store.put(slate);
      await tx.done;
      return slate;
    },

    async updateSlate(id, patch) {
      const tx = db.transaction('slates', 'readwrite');
      const existing = (await tx.store.get(id)) ?? notFound('slate', id);
      const updated: Slate = { ...existing, ...patch, id, updatedAt: Date.now() };
      await tx.store.put(updated);
      await tx.done;
      return updated;
    },

    async deleteSlate(id) {
      const tx = db.transaction(['slates', 'takes', 'moments'], 'readwrite');
      const takeIds = await tx.objectStore('takes').index('bySlate').getAllKeys(id);
      const moments = tx.objectStore('moments');
      for (const takeId of takeIds) {
        const momentIds = await moments.index('byTake').getAllKeys(takeId);
        await Promise.all(momentIds.map((m) => moments.delete(m)));
      }
      await Promise.all(takeIds.map((t) => tx.objectStore('takes').delete(t)));
      await tx.objectStore('slates').delete(id);
      await tx.done;
    },

    async reorderSlates(projectId, orderedSlateIds) {
      const tx = db.transaction('slates', 'readwrite');
      const all = await tx.store.index('byProject').getAll(projectId);
      const changed = reorderSlateList(all, orderedSlateIds, Date.now());
      for (const s of changed) await tx.store.put(s);
      await tx.done;
      return changed;
    },

    async listTakes(slateId) {
      const takes = await db.getAllFromIndex('takes', 'bySlate', slateId);
      return takes.sort((a, b) => a.number - b.number);
    },

    async deleteTake(id) {
      const tx = db.transaction(['takes', 'moments', 'projects'], 'readwrite');
      const takes = tx.objectStore('takes');
      const moments = tx.objectStore('moments');

      // Deleting says the camera never wrote this file, so hand its clip
      // number back: later shots on the units it consumed slide down one.
      const doomed = (await takes.get(id)) ?? notFound('take', id);
      const projects = tx.objectStore('projects');
      const project = await projects.get(doomed.projectId);
      if (project) {
        const all = await takes.index('byProject').getAll(doomed.projectId);
        const freed = reclaimClipNumbers(project, all, id, Date.now());
        for (const t of freed.takes) await takes.put(t);
        await projects.put(freed.project);
      }

      const momentIds = await moments.index('byTake').getAllKeys(id);
      await Promise.all(momentIds.map((m) => moments.delete(m)));
      await takes.delete(id);
      await tx.done;
    },

    async createTake(input) {
      const tx = db.transaction(['takes', 'projects'], 'readwrite');
      const projects = tx.objectStore('projects');
      const takes = tx.objectStore('takes');

      const project = (await projects.get(input.projectId)) ?? notFound('project', input.projectId);
      // Take numbers run per SHOT when the take names one and per SCENE when it
      // doesn't, so 5.31 gets takes 1,2,3 and 5.32 starts at 1 again. The two
      // sequences are independent on purpose: takes already logged against a
      // bare scene must not be shifted or joined by shots added later, so the
      // legacy branch counts only takes with no shotId. `byShot` contains
      // nothing else (see the schema note), so the first branch needs no filter.
      const siblings =
        input.shotId !== undefined
          ? await takes.index('byShot').getAll(input.shotId)
          : (await takes.index('bySlate').getAll(input.slateId)).filter(
              (t) => t.shotId === undefined,
            );
      const number = nextTakeNumber(siblings);
      const now = Date.now();

      const built = buildTakeClips(project, number, input, now);
      await takes.put(built.take);
      await projects.put(built.project);
      await tx.done;
      return built.take;
    },

    async updateTake(id, patch) {
      const tx = db.transaction('takes', 'readwrite');
      const existing = (await tx.store.get(id)) ?? notFound('take', id);
      const updated: Take = { ...existing, ...patch, id, updatedAt: Date.now() };
      await tx.store.put(updated);
      await tx.done;
      return updated;
    },

    async reassignTake(takeId, destination) {
      // ONE readwrite transaction over `takes`, so the destination's sibling
      // scan and the write of the renumbered take cannot be interleaved by a
      // concurrent CUT — exactly the reason createTake computes its number
      // inside its own transaction rather than reading first and writing after.
      // Nothing else is touched: no clip counters (the clip name doesn't move),
      // no cascades (moments hang off takeId, which is unchanged).
      const tx = db.transaction('takes', 'readwrite');
      const takes = tx.store;

      const existing = (await takes.get(takeId)) ?? notFound('take', takeId);
      // Same sibling rule as createTake, applied to the DESTINATION: `byShot`
      // holds only shot-scoped takes, so a scene-level destination has to go
      // through `bySlate` with an explicit "no shotId" filter.
      const siblings =
        destination.shotId !== undefined
          ? await takes.index('byShot').getAll(destination.shotId)
          : (await takes.index('bySlate').getAll(destination.slateId)).filter(
              (t) => t.shotId === undefined,
            );

      const moved = reassignTakeTo(existing, siblings, destination, Date.now());
      if (moved !== existing) await takes.put(moved); // unchanged reference = already there
      await tx.done;
      return moved;
    },

    async rebaseClips(projectId, takeId, newNumbers, soundNumber) {
      const tx = db.transaction(['takes', 'projects'], 'readwrite');
      const projects = tx.objectStore('projects');
      const takes = tx.objectStore('takes');

      const project = (await projects.get(projectId)) ?? notFound('project', projectId);
      const all = await takes.index('byProject').getAll(projectId);
      const result = rebaseClipNumbers(project, all, takeId, newNumbers, Date.now(), soundNumber);

      for (const t of result.takes) await takes.put(t);
      await projects.put(result.project);
      await tx.done;
      return { project: result.project, shifted: Math.max(0, result.takes.length - 1) };
    },

    async listMoments(takeId) {
      const moments = await db.getAllFromIndex('moments', 'byTake', takeId);
      return moments.sort((a, b) => a.atMs - b.atMs);
    },

    async createMoment(m) {
      const now = Date.now();
      const moment: Moment = { ...m, id: newId(), createdAt: now, updatedAt: now };
      await db.put('moments', moment);
      return moment;
    },

    async updateMoment(id, patch) {
      const tx = db.transaction('moments', 'readwrite');
      const existing = (await tx.store.get(id)) ?? notFound('moment', id);
      const updated: Moment = { ...existing, ...patch, id, updatedAt: Date.now() };
      await tx.store.put(updated);
      await tx.done;
      return updated;
    },

    async deleteMoment(id) {
      await db.delete('moments', id);
    },

    async getBundle(projectId) {
      const project = (await db.get('projects', projectId)) ?? notFound('project', projectId);
      const slates = (await db.getAllFromIndex('slates', 'byProject', projectId)).sort(
        (a, b) => a.order - b.order,
      );
      const slateOrder = new Map(slates.map((s) => [s.id, s.order]));
      const shotOrder = shotOrderIndex(slates);
      const takes = (await db.getAllFromIndex('takes', 'byProject', projectId)).sort(
        bundleTakeComparator(slateOrder, shotOrder),
      );
      const momentsPerTake = await Promise.all(
        takes.map((t) => db.getAllFromIndex('moments', 'byTake', t.id)),
      );
      const moments = momentsPerTake.flatMap((ms) => ms.sort((a, b) => a.atMs - b.atMs));
      const bundle: ProjectBundle = { project, slates, takes, moments };
      return bundle;
    },

    // Projects list's cheap read: two indexed getAll's (slates, takes), no
    // per-take fan-out into moments - that N+1 (one query per take) is
    // getBundle's real cost, and something the Projects list never reads.
    // See summarizeProject in util.ts for the actual counting.
    async getProjectSummary(projectId) {
      const slates = await db.getAllFromIndex('slates', 'byProject', projectId);
      const takes = await db.getAllFromIndex('takes', 'byProject', projectId);
      return summarizeProject(slates, takes);
    },

    // ---------------------------------------------------------- sync raw ---
    // Low-level bypass path for the sync engine (src/net/sync.ts) ONLY: a
    // plain get/put/delete on the named object store with no business logic
    // (no clip counters, no cascades, no updatedAt stamping). Used to (a)
    // cheaply look up a parent record's projectId when tombstoning a delete
    // in index.ts, and (b) apply a pulled server row straight to local
    // storage without re-enqueueing it back into the outbox. Never called
    // from UI code — always go through the Store methods above for that.

    async rawGet(table: SyncTable, id: string) {
      switch (table) {
        case 'projects':
          return db.get('projects', id);
        case 'slates':
          return db.get('slates', id);
        case 'takes':
          return db.get('takes', id);
        case 'moments':
          return db.get('moments', id);
      }
    },

    async rawPut(table: SyncTable, entity: Project | Slate | Take | Moment) {
      switch (table) {
        case 'projects':
          await db.put('projects', entity as Project);
          return;
        case 'slates':
          await db.put('slates', entity as Slate);
          return;
        case 'takes':
          await db.put('takes', entity as Take);
          return;
        case 'moments':
          await db.put('moments', entity as Moment);
          return;
      }
    },

    async rawDelete(table: SyncTable, id: string) {
      switch (table) {
        case 'projects':
          await db.delete('projects', id);
          return;
        case 'slates':
          await db.delete('slates', id);
          return;
        case 'takes':
          await db.delete('takes', id);
          return;
        case 'moments':
          await db.delete('moments', id);
          return;
      }
    },
  };
}
