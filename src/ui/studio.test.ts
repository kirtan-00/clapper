// The parse guard on the stored identity, and the ask-once flag.
//
// Same DOM-less-vitest situation as rollCheckpoint.test.ts: Node's own
// `localStorage` global is wired to an invalid backing path in this sandbox
// and throws on every call, so a working in-memory shim stands in. That is
// not a workaround - both states are load-bearing here. A studio name that
// cannot be stored must never break an export, and a studio name that HAS
// been stored must come back exactly as written.

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

import { getStudio, setStudio, studioAsked, hasStudio } from './studio';

const KEY = 'clapper.studio.v1';

describe('studio.ts', () => {
  it('round-trips what was written', () => {
    setStudio({ name: 'Kirtan', studio: 'Fourside Studio' });
    expect(getStudio()).toEqual({ name: 'Kirtan', studio: 'Fourside Studio' });
  });

  it('reads as two empty strings before anything is stored', () => {
    expect(getStudio()).toEqual({ name: '', studio: '' });
    expect(hasStudio()).toBe(false);
  });

  it('trims, so a trailing space is not a different studio', () => {
    setStudio({ name: '  Kirtan  ', studio: '  Fourside  ' });
    expect(getStudio()).toEqual({ name: 'Kirtan', studio: 'Fourside' });
  });

  it('caps length, so a pasted paragraph cannot run off the PDF cover', () => {
    setStudio({ name: '', studio: 'x'.repeat(500) });
    expect(getStudio().studio.length).toBe(80);
  });

  // The three shapes a hand-edited or half-written value can actually take.
  // Each must degrade to blank rather than reach the PDF writer as a non-string.
  it('survives malformed JSON', () => {
    localStorage.setItem(KEY, '{not valid json');
    expect(getStudio()).toEqual({ name: '', studio: '' });
  });

  it('survives a JSON value that is not an object', () => {
    localStorage.setItem(KEY, '"Fourside"');
    expect(getStudio()).toEqual({ name: '', studio: '' });
  });

  it('survives an object whose fields are the wrong type', () => {
    localStorage.setItem(KEY, JSON.stringify({ name: 42, studio: { a: 1 } }));
    expect(getStudio()).toEqual({ name: '', studio: '' });
  });

  it('counts a SKIP as asked, so the one-time sheet stays one-time', () => {
    expect(studioAsked()).toBe(false);
    setStudio({ name: '', studio: '' });
    expect(studioAsked()).toBe(true);
    // Asked, but nothing to print: the two questions are separate.
    expect(hasStudio()).toBe(false);
  });

  // THE DISMISS RULE, which is where the data loss was. StudioSheet writes
  // blanks on a dismiss ONLY when nothing has been asked yet. The same sheet
  // reopens from Settings, and there a dismiss is a cancel - the stored studio
  // has to survive it. This pins the predicate that decision hangs on.
  it('reports asked=true once a real value is stored, so a later cancel is not a skip', () => {
    setStudio({ name: 'Kirtan', studio: 'Fourside' });
    expect(studioAsked()).toBe(true);
    // Which is what StudioSheet's `if (!studioAsked())` reads. Simulating that
    // branch: the blank write never happens, so the value stands.
    if (!studioAsked()) setStudio({ name: '', studio: '' });
    expect(getStudio().studio).toBe('Fourside');
  });

  it('treats unreadable storage as already asked, rather than asking every load', () => {
    (globalThis as unknown as { localStorage: unknown }).localStorage = {
      getItem() {
        throw new Error('blocked');
      },
    };
    expect(studioAsked()).toBe(true);
    expect(getStudio()).toEqual({ name: '', studio: '' });
  });

  it('a write that throws loses the value and nothing else', () => {
    (globalThis as unknown as { localStorage: unknown }).localStorage = {
      setItem() {
        throw new Error('quota');
      },
      getItem: () => null,
    };
    expect(() => setStudio({ name: 'Kirtan', studio: 'Fourside' })).not.toThrow();
  });
});
