import { openDB, type DBSchema, type IDBPDatabase } from 'idb';
import type { Moment, Project, ProjectBundle, Slate, Store, Take } from '../types';

interface ClapperDB extends DBSchema {
  projects: { key: string; value: Project };
  slates: { key: string; value: Slate; indexes: { byProject: string } };
  takes: { key: string; value: Take; indexes: { bySlate: string; byProject: string } };
  moments: { key: string; value: Moment; indexes: { byTake: string } };
}

let dbPromise: Promise<IDBPDatabase<ClapperDB>> | null = null;

function getDB(): Promise<IDBPDatabase<ClapperDB>> {
  if (!dbPromise) {
    dbPromise = openDB<ClapperDB>('clapper', 1, {
      upgrade(db) {
        db.createObjectStore('projects', { keyPath: 'id' });
        const slates = db.createObjectStore('slates', { keyPath: 'id' });
        slates.createIndex('byProject', 'projectId');
        const takes = db.createObjectStore('takes', { keyPath: 'id' });
        takes.createIndex('bySlate', 'slateId');
        takes.createIndex('byProject', 'projectId');
        const moments = db.createObjectStore('moments', { keyPath: 'id' });
        moments.createIndex('byTake', 'takeId');
      },
    });
  }
  return dbPromise;
}

function newId(): string {
  return crypto.randomUUID();
}

function notFound(entity: string, id: string): never {
  throw new Error(`${entity} not found: ${id}`);
}

export const store: Store = {
  async listProjects() {
    const db = await getDB();
    return db.getAll('projects');
  },

  async getProject(id) {
    const db = await getDB();
    return db.get('projects', id);
  },

  async createProject(p) {
    const db = await getDB();
    const now = Date.now();
    const project: Project = { ...p, id: newId(), createdAt: now, updatedAt: now };
    await db.put('projects', project);
    return project;
  },

  async updateProject(id, patch) {
    const db = await getDB();
    const tx = db.transaction('projects', 'readwrite');
    const existing = (await tx.store.get(id)) ?? notFound('project', id);
    const updated: Project = { ...existing, ...patch, id, updatedAt: Date.now() };
    await tx.store.put(updated);
    await tx.done;
    return updated;
  },

  async deleteProject(id) {
    const db = await getDB();
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
    const db = await getDB();
    const slates = await db.getAllFromIndex('slates', 'byProject', projectId);
    return slates.sort((a, b) => a.order - b.order);
  },

  async createSlate(projectId, name) {
    const db = await getDB();
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
    const db = await getDB();
    const tx = db.transaction('slates', 'readwrite');
    const existing = (await tx.store.get(id)) ?? notFound('slate', id);
    const updated: Slate = { ...existing, ...patch, id, updatedAt: Date.now() };
    await tx.store.put(updated);
    await tx.done;
    return updated;
  },

  async deleteSlate(id) {
    const db = await getDB();
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

  async listTakes(slateId) {
    const db = await getDB();
    const takes = await db.getAllFromIndex('takes', 'bySlate', slateId);
    return takes.sort((a, b) => a.number - b.number);
  },

  async createTake(input) {
    const db = await getDB();
    const tx = db.transaction(['takes', 'projects'], 'readwrite');
    const projects = tx.objectStore('projects');
    const takes = tx.objectStore('takes');

    const project = (await projects.get(input.projectId)) ?? notFound('project', input.projectId);
    const siblings = await takes.index('bySlate').getAll(input.slateId);
    const number = siblings.reduce((max, t) => Math.max(max, t.number), 0) + 1;

    const clipNumber = project.nextClipNumber;
    const clipName = project.clipPrefix + String(clipNumber).padStart(project.clipPadding, '0');
    const now = Date.now();

    const take: Take = {
      id: newId(),
      slateId: input.slateId,
      projectId: input.projectId,
      number,
      clipName,
      status: 'good',
      startedAt: input.startedAt,
      durationMs: input.durationMs,
      ...(input.cameraTC !== undefined ? { cameraTC: input.cameraTC } : {}),
      ...(input.note !== undefined ? { note: input.note } : {}),
      createdAt: now,
      updatedAt: now,
    };

    await takes.put(take);
    await projects.put({ ...project, nextClipNumber: clipNumber + 1, updatedAt: now });
    await tx.done;
    return take;
  },

  async updateTake(id, patch) {
    const db = await getDB();
    const tx = db.transaction('takes', 'readwrite');
    const existing = (await tx.store.get(id)) ?? notFound('take', id);
    const updated: Take = { ...existing, ...patch, id, updatedAt: Date.now() };
    await tx.store.put(updated);
    await tx.done;
    return updated;
  },

  async listMoments(takeId) {
    const db = await getDB();
    const moments = await db.getAllFromIndex('moments', 'byTake', takeId);
    return moments.sort((a, b) => a.atMs - b.atMs);
  },

  async createMoment(m) {
    const db = await getDB();
    const now = Date.now();
    const moment: Moment = { ...m, id: newId(), createdAt: now, updatedAt: now };
    await db.put('moments', moment);
    return moment;
  },

  async updateMoment(id, patch) {
    const db = await getDB();
    const tx = db.transaction('moments', 'readwrite');
    const existing = (await tx.store.get(id)) ?? notFound('moment', id);
    const updated: Moment = { ...existing, ...patch, id, updatedAt: Date.now() };
    await tx.store.put(updated);
    await tx.done;
    return updated;
  },

  async deleteMoment(id) {
    const db = await getDB();
    await db.delete('moments', id);
  },

  async getBundle(projectId) {
    const db = await getDB();
    const project = (await db.get('projects', projectId)) ?? notFound('project', projectId);
    const slates = (await db.getAllFromIndex('slates', 'byProject', projectId)).sort(
      (a, b) => a.order - b.order,
    );
    const slateOrder = new Map(slates.map((s) => [s.id, s.order]));
    const takes = (await db.getAllFromIndex('takes', 'byProject', projectId)).sort(
      (a, b) =>
        (slateOrder.get(a.slateId) ?? 0) - (slateOrder.get(b.slateId) ?? 0) ||
        a.number - b.number,
    );
    const momentsPerTake = await Promise.all(
      takes.map((t) => db.getAllFromIndex('moments', 'byTake', t.id)),
    );
    const moments = momentsPerTake.flatMap((ms) => ms.sort((a, b) => a.atMs - b.atMs));
    const bundle: ProjectBundle = { project, slates, takes, moments };
    return bundle;
  },
};
