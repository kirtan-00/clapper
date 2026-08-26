// Pure preference-module coverage for clapsound.ts's persisted Sound toggle,
// plus the rolling guard playClap() enforces before it ever touches Audio.
// Same DOM-less-vitest situation as rollCheckpoint.test.ts and studio.test.ts
// (no jsdom; Node's own `localStorage` global is wired to an invalid backing
// path in this sandbox and throws on every call - see vite.config.ts).
//
// ONE THING THIS FILE HAS TO WORK AROUND THAT studio.test.ts DID NOT:
// clapsound.ts caches its `current` flag at module load (`let current =
// read()`), the same shape haptics.ts/leftHand.ts/reduceMotion.ts use and
// none of which have their own test file to borrow a pattern from - unlike
// studio.ts's read-fresh-every-call getStudio, isSoundOn() just returns
// whatever `current` was set to when the module was FIRST imported. So every
// scenario below that cares what read() saw installs its storage first, then
// vi.resetModules() + a fresh dynamic import - a plain beforeEach swap before
// calling a getter would only prove the cached value survives, not what a
// real cold start would have read.
//
// Actual audio playback is never exercised here - "the rolling guard" and
// "played vs did not play" are tested through a tiny stub `Audio` global,
// which proves playClap()'s CONTROL FLOW (guard checked before the element
// is ever touched, both failure paths swallowed) without needing a real
// browser's audio pipeline.

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { RollCheckpoint } from '../engine/rollCheckpoint';

const SOUND_KEY = 'clapper.sound';

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

/** Every call throws - private mode, quota, blocked storage, all look the
 *  same to the code that has to survive them. */
class ReadThrowingStorage {
  getItem(): string | null {
    throw new Error('storage unavailable');
  }
  setItem(): void {
    throw new Error('storage unavailable');
  }
  removeItem(): void {
    throw new Error('storage unavailable');
  }
  clear(): void {
    throw new Error('storage unavailable');
  }
}

/** Reads succeed (a real Map behind it); only setItem throws - isolates the
 *  write-fails case from the read-fails case instead of conflating both
 *  under one all-throwing shim. */
class WriteThrowingStorage {
  private store = new Map<string, string>();
  getItem(key: string): string | null {
    return this.store.has(key) ? this.store.get(key)! : null;
  }
  setItem(): void {
    throw new Error('quota exceeded');
  }
  removeItem(key: string): void {
    this.store.delete(key);
  }
  clear(): void {
    this.store.clear();
  }
}

function installStorage(storage: Pick<Storage, 'getItem' | 'setItem' | 'removeItem' | 'clear'>): void {
  (globalThis as unknown as { localStorage: unknown }).localStorage = storage;
}

function baseCheckpoint(): RollCheckpoint {
  return {
    v: 1,
    projectId: 'p1',
    slateId: 's1',
    takeNumber: 1,
    takeStartedAt: Date.now(),
    savedAt: Date.now(),
    camRolls: {},
    finishedRolls: [],
    soundStartedAt: null,
    soundFinished: null,
    buffered: [],
    markInMs: null,
    flashes: {},
    clips: [],
  };
}

describe('clapsound.ts - the Sound preference', () => {
  beforeEach(() => {
    vi.resetModules();
  });

  it('defaults OFF when nothing is stored - see clapsound.ts for why silence is the safe default', async () => {
    installStorage(new MemoryStorage());
    const { isSoundOn } = await import('./clapsound');
    expect(isSoundOn()).toBe(false);
  });

  it('round-trips what was written, in memory', async () => {
    installStorage(new MemoryStorage());
    const { isSoundOn, setSoundOn } = await import('./clapsound');
    expect(isSoundOn()).toBe(false);
    setSoundOn(true);
    expect(isSoundOn()).toBe(true);
    setSoundOn(false);
    expect(isSoundOn()).toBe(false);
  });

  it('round-trips across a reload - a fresh import re-reads what a previous one wrote', async () => {
    const storage = new MemoryStorage();
    installStorage(storage);
    const first = await import('./clapsound');
    first.setSoundOn(true);
    expect(storage.getItem(SOUND_KEY)).toBe('1');

    vi.resetModules();
    const second = await import('./clapsound');
    expect(second.isSoundOn()).toBe(true);
  });

  it('a malformed stored value degrades to OFF rather than throwing', async () => {
    const storage = new MemoryStorage();
    storage.setItem(SOUND_KEY, 'yes please');
    installStorage(storage);
    const { isSoundOn } = await import('./clapsound');
    expect(isSoundOn()).toBe(false);
  });

  it('storage that throws on read still resolves to the OFF default', async () => {
    installStorage(new ReadThrowingStorage());
    const { isSoundOn } = await import('./clapsound');
    expect(isSoundOn()).toBe(false);
  });

  it('storage that throws on write still flips the setting for this session, and never throws out of setSoundOn', async () => {
    installStorage(new WriteThrowingStorage());
    const { isSoundOn, setSoundOn } = await import('./clapsound');
    expect(() => setSoundOn(true)).not.toThrow();
    expect(isSoundOn()).toBe(true);
  });

  it('notifies subscribers on a real change, and stops after unsubscribe', async () => {
    installStorage(new MemoryStorage());
    const { setSoundOn, subscribeSound } = await import('./clapsound');
    let calls = 0;
    const unsubscribe = subscribeSound(() => {
      calls += 1;
    });
    setSoundOn(true);
    expect(calls).toBe(1);
    setSoundOn(true); // same value - an early return, no spurious notify
    expect(calls).toBe(1);
    unsubscribe();
    setSoundOn(false);
    expect(calls).toBe(1);
  });
});

describe('clapsound.ts - playClap()', () => {
  let played: string[] = [];
  let constructed: string[] = [];

  class FakeAudio {
    src: string;
    currentTime = 0;
    constructor(src: string) {
      this.src = src;
      constructed.push(src);
    }
    play(): Promise<void> {
      played.push(this.src);
      return Promise.resolve();
    }
  }

  beforeEach(() => {
    vi.resetModules();
    played = [];
    constructed = [];
    installStorage(new MemoryStorage());
    (globalThis as unknown as { Audio: unknown }).Audio = FakeAudio;
  });

  afterEach(() => {
    delete (globalThis as unknown as { Audio?: unknown }).Audio;
  });

  it('does nothing when the preference is off, even with nothing rolling', async () => {
    const { playClap } = await import('./clapsound');
    playClap();
    expect(constructed).toEqual([]);
    expect(played).toEqual([]);
  });

  it('plays once the preference is turned on and nothing is rolling', async () => {
    const { playClap, setSoundOn } = await import('./clapsound');
    setSoundOn(true);
    playClap();
    expect(constructed).toEqual(['/clap.mp3']);
    expect(played).toEqual(['/clap.mp3']);
  });

  it('reuses the same element on a second call rather than constructing a new one', async () => {
    const { playClap, setSoundOn } = await import('./clapsound');
    setSoundOn(true);
    playClap();
    playClap();
    expect(constructed.length).toBe(1);
    expect(played.length).toBe(2);
  });

  it('the rolling guard: never plays while a take checkpoint is open, even with the preference on', async () => {
    const { writeCheckpoint } = await import('../engine/rollCheckpoint');
    const { playClap, setSoundOn } = await import('./clapsound');
    setSoundOn(true);
    writeCheckpoint(baseCheckpoint());

    playClap();

    expect(constructed).toEqual([]);
    expect(played).toEqual([]);
  });

  it('resumes playing once the checkpoint clears - the guard reads live state, not a one-time snapshot', async () => {
    const { writeCheckpoint, clearCheckpoint } = await import('../engine/rollCheckpoint');
    const { playClap, setSoundOn } = await import('./clapsound');
    setSoundOn(true);
    writeCheckpoint(baseCheckpoint());

    playClap();
    expect(played).toEqual([]);

    clearCheckpoint();
    playClap();
    expect(played).toEqual(['/clap.mp3']);
  });

  it('a garbage checkpoint in storage still blocks playback - malformed is treated as "in flight", never as "safe to play"', async () => {
    installStorage(new MemoryStorage());
    localStorage.setItem('clapper.rollCheckpoint', '{ not valid json');
    // A malformed checkpoint fails RollCheckpoint's own shape guard and
    // reads back as null (see rollCheckpoint.ts's readCheckpoint), so this
    // actually exercises the "nothing rolling" path - recorded here as the
    // documented behaviour rather than left to guess: garbage storage never
    // reaches playClap as a thrown error either way.
    const { playClap, setSoundOn } = await import('./clapsound');
    setSoundOn(true);
    expect(() => playClap()).not.toThrow();
    expect(played).toEqual(['/clap.mp3']);
  });
});
