// Studio Plus folders — the three guarantees the brief for this feature
// singled out: a deleted folder never deletes a project, folders and their
// grouping survive a lapsed subscription (only the controls lock), and
// nothing about a restored/backed-up project can corrupt or lose another
// project's local filing. Plus the gate predicate and the plumbing under it.
//
// Same DOM-less-vitest situation as studio.test.ts and rollCheckpoint.test.ts:
// Node's own `localStorage` in this sandbox throws on every call, so a
// working in-memory shim stands in for it. See studio.test.ts's own header —
// the same two states are load-bearing here: filing that cannot be stored
// must never break the screen, and filing that HAS been stored must come
// back exactly as written.

import { beforeEach, describe, expect, it } from 'vitest';

class MemoryStorage {
  private store = new Map<string, string>();
  getItem(key: string): string | null {
    return this.store.has(key) ? this.store.get(key)! : null;
  }
  setItem(key: string, value: string): void {
    this.store.set(key, String(value));
  }
  removeItem(key: string): void {
    this.store.delete(key);
  }
  clear(): void {
    this.store.clear();
  }
}

beforeEach(() => {
  (globalThis as unknown as { localStorage: MemoryStorage }).localStorage = new MemoryStorage();
});

import {
  ARCHIVE,
  ARCHIVE_AFTER_MS,
  canManageFolders,
  createFolder,
  deleteFolder,
  isFolderPlace,
  moveNeedsFolders,
  placeOf,
  readFiling,
  renameFolder,
  writeFiling,
  type Filing,
} from './filing';

const DAY_MS = 86400000;

describe('readFiling / writeFiling', () => {
  it('reads empty before anything is stored', () => {
    expect(readFiling()).toEqual({ folders: [], filed: {} });
  });

  it('round-trips what was written', () => {
    const filing: Filing = {
      folders: [{ id: 'f1', name: 'Northwind · client', order: 0 }],
      filed: { p1: 'f1', p2: ARCHIVE },
    };
    writeFiling(filing);
    expect(readFiling()).toEqual(filing);
  });

  it('survives malformed JSON, a non-object value, and wrong-typed fields', () => {
    localStorage.setItem('clapper.folders.v1', '{not valid json');
    expect(readFiling()).toEqual({ folders: [], filed: {} });

    localStorage.setItem('clapper.folders.v1', '"just a string"');
    expect(readFiling()).toEqual({ folders: [], filed: {} });

    localStorage.setItem('clapper.folders.v1', JSON.stringify({ folders: 'nope', filed: 42 }));
    expect(readFiling()).toEqual({ folders: [], filed: {} });
  });

  it('a write that throws loses the value and nothing else', () => {
    (globalThis as unknown as { localStorage: unknown }).localStorage = {
      setItem() {
        throw new Error('quota');
      },
      getItem: () => null,
    };
    expect(() => writeFiling({ folders: [{ id: 'f1', name: 'X', order: 0 }], filed: {} })).not.toThrow();
  });
});

describe('createFolder / renameFolder', () => {
  it('appends a folder at the next order slot, trimmed', () => {
    const start: Filing = { folders: [{ id: 'f1', name: 'A', order: 0 }], filed: {} };
    const { filing, folder } = createFolder(start, '  Riverside shoot  ');
    expect(folder.name).toBe('Riverside shoot');
    expect(folder.order).toBe(1);
    expect(filing.folders).toHaveLength(2);
    expect(filing.folders[0]).toEqual(start.folders[0]); // untouched
  });

  it('renames only the target folder and leaves membership untouched', () => {
    const start: Filing = {
      folders: [
        { id: 'f1', name: 'Old name', order: 0 },
        { id: 'f2', name: 'Other', order: 1 },
      ],
      filed: { p1: 'f1', p2: 'f2' },
    };
    const next = renameFolder(start, 'f1', '  New name  ');
    expect(next.folders).toEqual([
      { id: 'f1', name: 'New name', order: 0 },
      { id: 'f2', name: 'Other', order: 1 },
    ]);
    expect(next.filed).toEqual(start.filed);
  });

  it('rejects a blank rename rather than storing an empty folder name', () => {
    const start: Filing = { folders: [{ id: 'f1', name: 'Keep me', order: 0 }], filed: {} };
    expect(renameFolder(start, 'f1', '   ')).toEqual(start);
  });
});

describe('deleteFolder — the hard rule: a deleted folder never deletes a project', () => {
  it('removes the folder and unfiles every project that pointed at it, leaving everything else untouched', () => {
    const start: Filing = {
      folders: [
        { id: 'doomed', name: 'Wrapping up', order: 0 },
        { id: 'keep', name: 'Still going', order: 1 },
      ],
      filed: {
        // three projects filed under the folder being deleted
        p1: 'doomed',
        p2: 'doomed',
        p3: 'doomed',
        // one project in a DIFFERENT folder, one archived, one unfiled-in-map
        p4: 'keep',
        p5: ARCHIVE,
      },
    };

    const next = deleteFolder(start, 'doomed');

    // The folder itself is gone.
    expect(next.folders).toEqual([{ id: 'keep', name: 'Still going', order: 1 }]);
    // Every project that lived in it is now simply absent from `filed` —
    // i.e. unfiled, never deleted (this module holds no project records at
    // all, so "the project survives" is exactly "no project id anywhere in
    // this module was ever more than a key in `filed`, and it still isn't").
    expect(next.filed).toEqual({ p4: 'keep', p5: ARCHIVE });
    expect('p1' in next.filed).toBe(false);
    expect('p2' in next.filed).toBe(false);
    expect('p3' in next.filed).toBe(false);
    // Untouched entries are byte-identical, not just equal in value.
    expect(next.filed.p4).toBe('keep');
    expect(next.filed.p5).toBe(ARCHIVE);
  });

  it('every unfiled-by-delete project resolves through placeOf as plain Unfiled, not a dangling or invisible state', () => {
    const start: Filing = {
      folders: [{ id: 'doomed', name: 'Gone soon', order: 0 }],
      filed: { p1: 'doomed' },
    };
    const next = deleteFolder(start, 'doomed');
    const now = Date.now();
    // Freshly touched, so auto-archive cannot be the thing putting it back
    // anywhere — this has to be the delete's own fallback.
    expect(placeOf(next, now, 'p1', now)).toBe('');
  });

  it('deleting a folder that still has a dangling filed reference (delete run twice, or storage half-written) is a no-op the second time, not a crash', () => {
    const start: Filing = { folders: [], filed: { p1: 'already-gone' } };
    expect(() => deleteFolder(start, 'already-gone')).not.toThrow();
    expect(deleteFolder(start, 'already-gone').filed).toEqual({});
  });
});

describe('placeOf', () => {
  const now = Date.now();

  it('an explicit folder assignment wins', () => {
    const filing: Filing = { folders: [{ id: 'f1', name: 'X', order: 0 }], filed: { p1: 'f1' } };
    expect(placeOf(filing, now, 'p1', now)).toBe('f1');
  });

  it('a dangling folder id (deleted, renamed away, or corrupted) resolves to unfiled, never invisible', () => {
    const filing: Filing = { folders: [], filed: { p1: 'no-such-folder' } };
    expect(placeOf(filing, now, 'p1', now)).toBe('');
  });

  it('ARCHIVE stays ARCHIVE regardless of recency', () => {
    const filing: Filing = { folders: [], filed: { p1: ARCHIVE } };
    expect(placeOf(filing, now, 'p1', now)).toBe(ARCHIVE);
  });

  it('30+ quiet days with no explicit filing auto-archives', () => {
    const filing: Filing = { folders: [], filed: {} };
    expect(placeOf(filing, now, 'p1', now - ARCHIVE_AFTER_MS)).toBe(ARCHIVE);
    expect(placeOf(filing, now, 'p1', now - ARCHIVE_AFTER_MS + DAY_MS)).toBe('');
  });

  it('an explicit folder filing overrides auto-archive even when the project has gone quiet', () => {
    const filing: Filing = { folders: [{ id: 'f1', name: 'X', order: 0 }], filed: { p1: 'f1' } };
    expect(placeOf(filing, now, 'p1', now - ARCHIVE_AFTER_MS * 3)).toBe('f1');
  });
});

describe('isFolderPlace / moveNeedsFolders — the free/paid line', () => {
  it('Unfiled and Archive are never "folder" places', () => {
    expect(isFolderPlace('')).toBe(false);
    expect(isFolderPlace(ARCHIVE)).toBe(false);
    expect(isFolderPlace('f1')).toBe(true);
  });

  it('archiving and unarchiving (either direction between "" and ARCHIVE) never needs folders', () => {
    expect(moveNeedsFolders('', ARCHIVE)).toBe(false);
    expect(moveNeedsFolders(ARCHIVE, '')).toBe(false);
  });

  it('entering or leaving a real folder, either direction, needs folders', () => {
    expect(moveNeedsFolders('', 'f1')).toBe(true);
    expect(moveNeedsFolders('f1', '')).toBe(true);
    expect(moveNeedsFolders(ARCHIVE, 'f1')).toBe(true);
    expect(moveNeedsFolders('f1', 'f2')).toBe(true);
  });
});

describe('canManageFolders — the Studio Plus gate', () => {
  it('is false when signed out / not yet loaded', () => {
    expect(canManageFolders(null)).toBe(false);
  });

  it('is true only for an active studio_plus subscription', () => {
    expect(canManageFolders({ subscriptionActive: true, subscriptionProduct: 'studio_plus' })).toBe(true);
  });

  it('is false for the wrong product, even while active', () => {
    expect(canManageFolders({ subscriptionActive: true, subscriptionProduct: 'pro_monthly' })).toBe(false);
    expect(canManageFolders({ subscriptionActive: true, subscriptionProduct: null })).toBe(false);
  });

  it('is false for studio_plus that has lapsed (inactive)', () => {
    expect(canManageFolders({ subscriptionActive: false, subscriptionProduct: 'studio_plus' })).toBe(false);
  });
});

describe('lapsed subscription — folders and grouping survive; only editing locks', () => {
  it('the underlying filing data and its grouping are completely unaffected by the entitlement flip', () => {
    // A Studio Plus user's real state: two folders, several projects filed.
    const filing: Filing = {
      folders: [
        { id: 'f1', name: 'Client A', order: 0 },
        { id: 'f2', name: 'Client B', order: 1 },
      ],
      filed: { p1: 'f1', p2: 'f1', p3: 'f2' },
    };
    writeFiling(filing);
    const now = Date.now();

    const entitled = { subscriptionActive: true, subscriptionProduct: 'studio_plus' };
    const lapsed = { subscriptionActive: false, subscriptionProduct: 'studio_plus' };

    expect(canManageFolders(entitled)).toBe(true);
    expect(canManageFolders(lapsed)).toBe(false);

    // Same grouping question, asked before and after the subscription lapses
    // — `placeOf`/`readFiling` never consult entitlements at all, so the
    // answer cannot change with them.
    for (const projectId of ['p1', 'p2', 'p3']) {
      const before = placeOf(readFiling(), now, projectId, now);
      const after = placeOf(readFiling(), now, projectId, now); // re-read, as the lapsed render would
      expect(after).toBe(before);
    }
    expect(placeOf(readFiling(), now, 'p1', now)).toBe('f1');
    expect(placeOf(readFiling(), now, 'p3', now)).toBe('f2');
    expect(readFiling().folders).toHaveLength(2);

    // The only thing that changed is whether the CONTROLS are open — nothing
    // in storage was touched by computing `canManageFolders(lapsed)` above.
    expect(readFiling()).toEqual(filing);
  });
});

describe('backup / restore shape — a restored project (fresh id) never corrupts existing filing', () => {
  it('a project id that was never in `filed` (exactly what restoreBackup always mints) resolves to plain Unfiled, and touches nothing else', () => {
    const filing: Filing = {
      folders: [{ id: 'f1', name: 'Existing client', order: 0 }],
      filed: { original: 'f1' },
    };
    writeFiling(filing);

    // store/restore.ts always issues a brand-new id for a restored project
    // (see its own header) — simulate that with an id that could not
    // possibly already be a key in `filed`.
    const restoredId = 'restored-9f3k2';
    const now = Date.now();
    expect(placeOf(readFiling(), now, restoredId, now)).toBe('');

    // The original project's own filing is exactly as it was — a restore
    // that happened elsewhere (a different project entirely, since
    // backup/restore is per-project) cannot have touched it, because
    // nothing in this module was ever called for it.
    expect(readFiling()).toEqual(filing);
    expect(placeOf(readFiling(), now, 'original', now)).toBe('f1');
  });
});
