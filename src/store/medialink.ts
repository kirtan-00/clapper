// Where a picked footage folder's walk is kept between exports.
//
// Its OWN IndexedDB database (`clapper-media`), the same way the sync outbox
// keeps its own (`clapper-sync`) — so this can gain stores or bump its
// version without ever touching the main data DB's upgrade path, and a
// failure here can never take the shoot log down with it.
//
// DELIBERATELY NOT ON THE PROJECT ROW, and therefore deliberately not synced.
// A footage folder is a property of the MACHINE holding the cards, not of the
// production: the phone that logged the day and the edit box that ingests it
// are two different devices with two different disks, and pushing one's walk
// onto the other would describe a folder that does not exist there. The
// project keeps the one piece that IS production-wide — `mediaRoot`, the
// absolute path a human typed — and the walk stays here, local.
//
// Everything is best-effort and never throws: a device where IndexedDB is
// blocked (private windows, some file:// sandboxes) simply re-picks the
// folder each session, which is a small annoyance, not a broken export.

import { openDB, type DBSchema, type IDBPDatabase } from 'idb';
import type { MediaIndex } from '../export/medialink';

interface MediaRow {
  projectId: string;
  index: MediaIndex;
}

interface MediaDB extends DBSchema {
  walks: { key: string; value: MediaRow };
}

let dbPromise: Promise<IDBPDatabase<MediaDB> | null> | null = null;

/** Open (or reuse) the media DB. Resolves `null` — never rejects — when
 *  IndexedDB is unavailable, matching the outbox's contract. */
function openMediaDb(): Promise<IDBPDatabase<MediaDB> | null> {
  if (!dbPromise) {
    dbPromise = (async () => {
      try {
        if (typeof indexedDB === 'undefined') return null;
        const db = await openDB<MediaDB>('clapper-media', 1, {
          upgrade(database) {
            database.createObjectStore('walks', { keyPath: 'projectId' });
          },
        });
        // Prove the handle actually works before trusting it for the session
        // (mirrors idb.ts's file:// sandbox guard).
        await db.getAllKeys('walks');
        return db;
      } catch (err) {
        console.warn('Clapper: media folder index unavailable this session.', err);
        return null;
      }
    })();
  }
  return dbPromise;
}

/** Remember this project's folder walk so a re-export doesn't force a
 *  re-pick. Returns false when it could not be persisted — the caller can
 *  still use the index it holds in memory for this session. */
export async function saveMediaIndex(projectId: string, index: MediaIndex): Promise<boolean> {
  try {
    const db = await openMediaDb();
    if (!db) return false;
    await db.put('walks', { projectId, index });
    return true;
  } catch {
    return false;
  }
}

export async function loadMediaIndex(projectId: string): Promise<MediaIndex | undefined> {
  try {
    const db = await openMediaDb();
    if (!db) return undefined;
    return (await db.get('walks', projectId))?.index;
  } catch {
    return undefined;
  }
}

/** Forget the walk. What "the cards moved" looks like — the next export goes
 *  back to writing bare clip names rather than pointing at a disk that is no
 *  longer there. */
export async function clearMediaIndex(projectId: string): Promise<void> {
  try {
    const db = await openMediaDb();
    if (db) await db.delete('walks', projectId);
  } catch {
    /* best-effort: a walk we failed to delete is stale, not dangerous */
  }
}
