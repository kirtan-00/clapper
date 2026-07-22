import type { Store } from '../types';
import { openIdbStore } from './idb';
import { createLocalStore } from './local';

// Pick a storage backend at runtime. We prefer IndexedDB (the normal PWA case).
// On file:// in some browsers — and in private windows — IndexedDB is blocked
// or hands back a handle that throws on first use, so we fall back to a
// localStorage-backed store silently. Both implement the same Store contract.
//
// The chosen backend is resolved lazily and memoised, so the pick happens once
// on the first store call and every later call reuses it.

let backendPromise: Promise<Store> | null = null;

function pickBackend(): Promise<Store> {
  return openIdbStore().catch((err) => {
    console.warn('Clapper: IndexedDB unavailable, using localStorage store.', err);
    return createLocalStore();
  });
}

function backend(): Promise<Store> {
  if (!backendPromise) backendPromise = pickBackend();
  return backendPromise;
}

// A thin facade over the resolved backend. Every method awaits the pick, then
// delegates. Consumers keep importing `store` and calling it exactly as before.
export const store: Store = {
  listProjects: async () => (await backend()).listProjects(),
  getProject: async (id) => (await backend()).getProject(id),
  createProject: async (p) => (await backend()).createProject(p),
  updateProject: async (id, patch) => (await backend()).updateProject(id, patch),
  deleteProject: async (id) => (await backend()).deleteProject(id),

  listSlates: async (projectId) => (await backend()).listSlates(projectId),
  createSlate: async (projectId, name) => (await backend()).createSlate(projectId, name),
  updateSlate: async (id, patch) => (await backend()).updateSlate(id, patch),
  deleteSlate: async (id) => (await backend()).deleteSlate(id),

  listTakes: async (slateId) => (await backend()).listTakes(slateId),
  createTake: async (input) => (await backend()).createTake(input),
  updateTake: async (id, patch) => (await backend()).updateTake(id, patch),
  rebaseClips: async (projectId, takeId, newNumbers) =>
    (await backend()).rebaseClips(projectId, takeId, newNumbers),
  deleteTake: async (id) => (await backend()).deleteTake(id),

  listMoments: async (takeId) => (await backend()).listMoments(takeId),
  createMoment: async (m) => (await backend()).createMoment(m),
  updateMoment: async (id, patch) => (await backend()).updateMoment(id, patch),
  deleteMoment: async (id) => (await backend()).deleteMoment(id),

  getBundle: async (projectId) => (await backend()).getBundle(projectId),
};
