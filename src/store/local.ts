import type { Moment, Project, ProjectBundle, Slate, Store, Take } from '../types';
import { buildTakeClips, newId, notFound, rebaseClipNumbers, reclaimClipNumbers } from './util';

// A localStorage-backed Store, used when IndexedDB cannot be opened (common on
// file:// in some browsers, and in private windows). Data volumes here are tiny
// — a shoot day is hundreds of rows — so we skip indexes entirely: every object
// store is one JSON array under its own key, mirrored into an in-memory Map for
// fast reads. Writes persist the touched table(s) synchronously.
//
// JavaScript is single-threaded, so a method body runs to completion before any
// other store call can interleave. That gives createTake its required atomicity
// for free: the read of nextClipNumber and the write-back happen with no yield
// in between.

const NS = 'clapper:';

interface Tables {
  projects: Map<string, Project>;
  slates: Map<string, Slate>;
  takes: Map<string, Take>;
  moments: Map<string, Moment>;
}

type TableName = keyof Tables;

/**
 * A best-effort localStorage handle. If localStorage itself throws (blocked in
 * a locked-down sandbox), we degrade to a pure in-memory store for the session
 * so the app still works — the file always opens, even if it can't persist.
 */
function safeStorage(): Storage | null {
  try {
    if (typeof localStorage === 'undefined') return null;
    const probe = NS + '__probe__';
    localStorage.setItem(probe, '1');
    localStorage.removeItem(probe);
    return localStorage;
  } catch {
    return null;
  }
}

export function createLocalStore(): Store {
  const ls = safeStorage();

  function loadTable<T extends { id: string }>(name: TableName): Map<string, T> {
    const map = new Map<string, T>();
    if (!ls) return map;
    try {
      const raw = ls.getItem(NS + name);
      if (!raw) return map;
      const arr = JSON.parse(raw) as T[];
      if (Array.isArray(arr)) for (const row of arr) map.set(row.id, row);
    } catch {
      // Corrupt blob: start that table empty rather than crash the app.
    }
    return map;
  }

  const tables: Tables = {
    projects: loadTable<Project>('projects'),
    slates: loadTable<Slate>('slates'),
    takes: loadTable<Take>('takes'),
    moments: loadTable<Moment>('moments'),
  };

  function persist(name: TableName): void {
    if (!ls) return;
    try {
      ls.setItem(NS + name, JSON.stringify([...tables[name].values()]));
    } catch {
      // Quota or blocked mid-session: keep the in-memory copy, drop the write.
    }
  }

  return {
    async listProjects() {
      return [...tables.projects.values()];
    },

    async getProject(id) {
      return tables.projects.get(id);
    },

    async createProject(p) {
      const now = Date.now();
      const project: Project = { ...p, id: newId(), createdAt: now, updatedAt: now };
      tables.projects.set(project.id, project);
      persist('projects');
      return project;
    },

    async updateProject(id, patch) {
      const existing = tables.projects.get(id) ?? notFound('project', id);
      const updated: Project = { ...existing, ...patch, id, updatedAt: Date.now() };
      tables.projects.set(id, updated);
      persist('projects');
      return updated;
    },

    async deleteProject(id) {
      const takeIds = [...tables.takes.values()]
        .filter((t) => t.projectId === id)
        .map((t) => t.id);
      const takeIdSet = new Set(takeIds);
      for (const m of [...tables.moments.values()]) {
        if (takeIdSet.has(m.takeId)) tables.moments.delete(m.id);
      }
      for (const t of takeIds) tables.takes.delete(t);
      for (const s of [...tables.slates.values()]) {
        if (s.projectId === id) tables.slates.delete(s.id);
      }
      tables.projects.delete(id);
      persist('moments');
      persist('takes');
      persist('slates');
      persist('projects');
    },

    async listSlates(projectId) {
      return [...tables.slates.values()]
        .filter((s) => s.projectId === projectId)
        .sort((a, b) => a.order - b.order);
    },

    async createSlate(projectId, name) {
      const existing = [...tables.slates.values()].filter((s) => s.projectId === projectId);
      const order = existing.reduce((max, s) => Math.max(max, s.order), -1) + 1;
      const now = Date.now();
      const slate: Slate = { id: newId(), projectId, name, order, createdAt: now, updatedAt: now };
      tables.slates.set(slate.id, slate);
      persist('slates');
      return slate;
    },

    async updateSlate(id, patch) {
      const existing = tables.slates.get(id) ?? notFound('slate', id);
      const updated: Slate = { ...existing, ...patch, id, updatedAt: Date.now() };
      tables.slates.set(id, updated);
      persist('slates');
      return updated;
    },

    async deleteSlate(id) {
      const takeIds = [...tables.takes.values()].filter((t) => t.slateId === id).map((t) => t.id);
      const takeIdSet = new Set(takeIds);
      for (const m of [...tables.moments.values()]) {
        if (takeIdSet.has(m.takeId)) tables.moments.delete(m.id);
      }
      for (const t of takeIds) tables.takes.delete(t);
      tables.slates.delete(id);
      persist('moments');
      persist('takes');
      persist('slates');
    },

    async listTakes(slateId) {
      return [...tables.takes.values()]
        .filter((t) => t.slateId === slateId)
        .sort((a, b) => a.number - b.number);
    },

    async createTake(input) {
      const project = tables.projects.get(input.projectId) ?? notFound('project', input.projectId);
      const siblings = [...tables.takes.values()].filter((t) => t.slateId === input.slateId);
      const number = siblings.reduce((max, t) => Math.max(max, t.number), 0) + 1;
      const now = Date.now();

      const built = buildTakeClips(project, number, input, now);
      tables.takes.set(built.take.id, built.take);
      tables.projects.set(project.id, built.project);
      persist('takes');
      persist('projects');
      return built.take;
    },

    async updateTake(id, patch) {
      const existing = tables.takes.get(id) ?? notFound('take', id);
      const updated: Take = { ...existing, ...patch, id, updatedAt: Date.now() };
      tables.takes.set(id, updated);
      persist('takes');
      return updated;
    },

    async rebaseClips(projectId, takeId, newNumbers) {
      const project = tables.projects.get(projectId) ?? notFound('project', projectId);
      const all = [...tables.takes.values()].filter((t) => t.projectId === projectId);
      const result = rebaseClipNumbers(project, all, takeId, newNumbers, Date.now());

      for (const t of result.takes) tables.takes.set(t.id, t);
      tables.projects.set(project.id, result.project);
      persist('takes');
      persist('projects');
      return { project: result.project, shifted: Math.max(0, result.takes.length - 1) };
    },

    async deleteTake(id) {
      // Deleting says the camera never wrote this file, so hand its clip
      // number back: later shots on the units it consumed slide down one.
      const doomed = tables.takes.get(id) ?? notFound('take', id);
      const project = tables.projects.get(doomed.projectId);
      if (project) {
        const all = [...tables.takes.values()].filter((t) => t.projectId === doomed.projectId);
        const freed = reclaimClipNumbers(project, all, id, Date.now());
        for (const t of freed.takes) tables.takes.set(t.id, t);
        tables.projects.set(project.id, freed.project);
        persist('projects');
      }
      for (const m of [...tables.moments.values()]) {
        if (m.takeId === id) tables.moments.delete(m.id);
      }
      tables.takes.delete(id);
      persist('moments');
      persist('takes');
    },

    async listMoments(takeId) {
      return [...tables.moments.values()]
        .filter((m) => m.takeId === takeId)
        .sort((a, b) => a.atMs - b.atMs);
    },

    async createMoment(m) {
      const now = Date.now();
      const moment: Moment = { ...m, id: newId(), createdAt: now, updatedAt: now };
      tables.moments.set(moment.id, moment);
      persist('moments');
      return moment;
    },

    async updateMoment(id, patch) {
      const existing = tables.moments.get(id) ?? notFound('moment', id);
      const updated: Moment = { ...existing, ...patch, id, updatedAt: Date.now() };
      tables.moments.set(id, updated);
      persist('moments');
      return updated;
    },

    async deleteMoment(id) {
      tables.moments.delete(id);
      persist('moments');
    },

    async getBundle(projectId) {
      const project = tables.projects.get(projectId) ?? notFound('project', projectId);
      const slates = [...tables.slates.values()]
        .filter((s) => s.projectId === projectId)
        .sort((a, b) => a.order - b.order);
      const slateOrder = new Map(slates.map((s) => [s.id, s.order]));
      const takes = [...tables.takes.values()]
        .filter((t) => t.projectId === projectId)
        .sort(
          (a, b) =>
            (slateOrder.get(a.slateId) ?? 0) - (slateOrder.get(b.slateId) ?? 0) ||
            a.number - b.number,
        );
      // Group moments by take in take order, each take's moments sorted by
      // atMs — matching the idb backend's ordering exactly.
      const momentsByTake = new Map<string, Moment[]>();
      for (const m of tables.moments.values()) {
        const list = momentsByTake.get(m.takeId);
        if (list) list.push(m);
        else momentsByTake.set(m.takeId, [m]);
      }
      const moments = takes.flatMap((t) =>
        (momentsByTake.get(t.id) ?? []).sort((a, b) => a.atMs - b.atMs),
      );
      const bundle: ProjectBundle = { project, slates, takes, moments };
      return bundle;
    },
  };
}
