// Pure-logic coverage for crash recovery. This repo's vitest runs DOM-less
// (see vite.config.ts) - the same split RollingScreen.test.ts already uses
// for isSoleRollingUnit/rollHeadForm, applied here to the decisions that
// actually matter for NOT losing a take: what gets checkpointed, staleness,
// elapsed reconstruction across a gap, and the clip-number guarantee (via
// buildRecoveredTake, which is the one function standing between a
// checkpoint and a second store.createTake call).
//
// Node has its own `localStorage` global (no jsdom needed - see the
// `--localstorage-file` warning vitest prints on startup), but in this
// sandbox it is wired to an invalid backing path and every call throws -
// which is actually a decent stand-in for the private-mode/quota/blocked
// storage this file has to survive, except it means readCheckpoint/
// writeCheckpoint can never be observed SUCCEEDING against it. A tiny
// in-memory Storage shim stands in for a WORKING localStorage below, so the
// round-trip tests exercise real success, not just the fail-safe path.

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
  buildRecoveredTake,
  CHECKPOINT_KEY,
  clearCheckpoint,
  elapsedSince,
  foldMarkIn,
  formatClipsLabel,
  formatElapsedAgo,
  isStale,
  noCameraEverJoined,
  readCheckpoint,
  setPendingResume,
  STALE_MS,
  takePendingResume,
  writeCheckpoint,
  type RollCheckpoint,
} from './rollCheckpoint';

function baseCheckpoint(overrides: Partial<RollCheckpoint> = {}): RollCheckpoint {
  return {
    v: 1,
    projectId: 'p1',
    slateId: 's1',
    takeNumber: 3,
    takeStartedAt: 1_000_000,
    savedAt: 1_000_500,
    camRolls: {},
    finishedRolls: [],
    soundStartedAt: null,
    soundFinished: null,
    buffered: [],
    markInMs: null,
    flashes: {},
    clips: [{ unit: 'A', clipName: 'C0042' }],
    ...overrides,
  };
}

beforeEach(() => {
  clearCheckpoint();
});

// --------------------------------------------------------------- storage ---

describe('writeCheckpoint / readCheckpoint / clearCheckpoint', () => {
  it('round-trips a checkpoint exactly', () => {
    const cp = baseCheckpoint();
    writeCheckpoint(cp);
    expect(readCheckpoint()).toEqual(cp);
  });

  it('reads null when nothing was ever written', () => {
    expect(readCheckpoint()).toBeNull();
  });

  it('clear removes it - a cleared checkpoint reads as absent, never as garbage', () => {
    writeCheckpoint(baseCheckpoint());
    clearCheckpoint();
    expect(readCheckpoint()).toBeNull();
  });

  it('corrupted JSON reads as absent rather than throwing', () => {
    localStorage.setItem(CHECKPOINT_KEY, '{not valid json');
    expect(() => readCheckpoint()).not.toThrow();
    expect(readCheckpoint()).toBeNull();
  });

  it('valid JSON but the wrong shape (missing fields) reads as absent - replace-dont-trust, same rule analytics.ts applies to a corrupted vid', () => {
    localStorage.setItem(CHECKPOINT_KEY, JSON.stringify({ v: 1, projectId: 'p1' }));
    expect(readCheckpoint()).toBeNull();
  });

  it('a future/unknown schema version reads as absent rather than being trusted', () => {
    localStorage.setItem(CHECKPOINT_KEY, JSON.stringify({ ...baseCheckpoint(), v: 2 }));
    expect(readCheckpoint()).toBeNull();
  });
});

// ------------------------------------------------------------- staleness ---

describe('isStale', () => {
  it('fresh checkpoint (just saved): not stale', () => {
    const cp = baseCheckpoint({ savedAt: 1_000_000 });
    expect(isStale(cp, 1_000_000 + 1000)).toBe(false);
  });

  it('right at the threshold: not yet stale (strictly greater-than triggers it)', () => {
    const cp = baseCheckpoint({ savedAt: 1_000_000 });
    expect(isStale(cp, 1_000_000 + STALE_MS)).toBe(false);
  });

  it('one ms past the threshold: stale', () => {
    const cp = baseCheckpoint({ savedAt: 1_000_000 });
    expect(isStale(cp, 1_000_000 + STALE_MS + 1)).toBe(true);
  });

  it('measures against savedAt, NOT takeStartedAt - a long take that keeps checkpointing stays fresh', () => {
    // A three-hour interview: takeStartedAt is three hours ago, but the last
    // checkpoint (savedAt) landed a second ago because the app never died.
    const cp = baseCheckpoint({ takeStartedAt: 1_000_000, savedAt: 1_000_000 + 3 * 60 * 60 * 1000 });
    expect(isStale(cp, 1_000_000 + 3 * 60 * 60 * 1000 + 1000)).toBe(false);
  });
});

// ----------------------------------------------------------- elapsed time ---

describe('elapsedSince', () => {
  it('now minus takeStartedAt', () => {
    const cp = baseCheckpoint({ takeStartedAt: 1_000_000 });
    expect(elapsedSince(cp, 1_005_000)).toBe(5000);
  });

  it('clamped to zero - a clock skew or a stale-but-not-yet-cleared checkpoint must never show negative time', () => {
    const cp = baseCheckpoint({ takeStartedAt: 1_005_000 });
    expect(elapsedSince(cp, 1_000_000)).toBe(0);
  });

  it('reconstructs correctly across a real gap (tab killed for 5 minutes, cold reload)', () => {
    const takeStartedAt = 1_000_000;
    const killedAt = takeStartedAt + 90_000; // 90s into the take when the tab died
    const reloadedAt = killedAt + 5 * 60 * 1000; // 5 minutes dead
    const cp = baseCheckpoint({ takeStartedAt, savedAt: killedAt });
    expect(elapsedSince(cp, reloadedAt)).toBe(90_000 + 5 * 60 * 1000);
  });
});

// -------------------------------------------------------------- MARK IN ---

describe('foldMarkIn', () => {
  it('no armed mark: buffered passes through unchanged', () => {
    const buffered = [{ kind: 'point' as const, atMs: 1000, label: '', tag: 'GOLD' }];
    expect(foldMarkIn(buffered, null, 5000)).toBe(buffered);
  });

  it('an armed mark never closed folds into a range ending at the take boundary', () => {
    const buffered = [{ kind: 'point' as const, atMs: 1000, label: '', tag: 'GOLD' }];
    expect(foldMarkIn(buffered, 2000, 9000)).toEqual([
      ...buffered,
      { kind: 'range', atMs: 2000, endMs: 9000, label: '' },
    ]);
  });
});

// --------------------------------------------------------------- display ---

describe('formatClipsLabel', () => {
  it('one camera: the bare clip name', () => {
    expect(formatClipsLabel(baseCheckpoint({ clips: [{ unit: 'A', clipName: 'C0042' }] }))).toBe('C0042');
  });

  it('multiple cameras: unit-prefixed and joined, matching the two-camera on-screen convention', () => {
    const cp = baseCheckpoint({
      clips: [
        { unit: 'A', clipName: 'C0002' },
        { unit: 'B', clipName: 'C0002' },
      ],
    });
    expect(formatClipsLabel(cp)).toBe('A C0002 · B C0002');
  });

  it('sound file rides along after the camera(s)', () => {
    const cp = baseCheckpoint({ clips: [{ unit: 'A', clipName: 'C0042' }], soundFile: 'SND_0007' });
    expect(formatClipsLabel(cp)).toBe('C0042 · SND_0007');
  });

  it('sound-only (no camera ever joined): the sound file alone', () => {
    const cp = baseCheckpoint({ clips: [], soundFile: 'SND_0007' });
    expect(formatClipsLabel(cp)).toBe('SND_0007');
  });

  it('neither (should not happen, but must never render blank)', () => {
    expect(formatClipsLabel(baseCheckpoint({ clips: [] }))).toBe('a take');
  });
});

describe('formatElapsedAgo', () => {
  it('under a minute: seconds', () => {
    expect(formatElapsedAgo(45_000)).toBe('45s');
  });

  it('minutes', () => {
    expect(formatElapsedAgo(5 * 60 * 1000)).toBe('5 min');
  });

  it('over an hour: h and zero-padded m', () => {
    expect(formatElapsedAgo(2 * 60 * 60 * 1000 + 5 * 60 * 1000)).toBe('2h 05m');
  });
});

// ------------------------------------------------- the clip-number guarantee ---
//
// buildRecoveredTake is the ONLY thing standing between "Cut it now"/"Discard"
// and a second store.createTake call for a take that was already logged (or
// never gets logged at all). It never itself touches the store - it just
// builds the exact input a single createTake call needs - so pinning its
// output pins the guarantee.

describe('buildRecoveredTake', () => {
  it('plain single-cam, no sound: units/sound both OMITTED - createTake documents both as "meaningless there and ignored" for this shape, and passing an empty units array is a DIFFERENT (wrong) instruction', () => {
    const cp = baseCheckpoint({ takeStartedAt: 1_000_000, clips: [{ unit: 'A', clipName: 'C0042' }] });
    const input = buildRecoveredTake(cp, 1_010_000);
    expect(input.units).toBeUndefined();
    expect(input.sound).toBeUndefined();
    expect(input.durationMs).toBe(10_000);
    expect(input.startedAt).toBe(1_000_000);
  });

  it('shotId carries through only when the checkpoint has one - an explicit undefined key is a different (wrong) thing from the key being absent, see store/util.ts', () => {
    const withShot = buildRecoveredTake(baseCheckpoint({ shotId: 'sh1' }), 1_010_000);
    expect(withShot.shotId).toBe('sh1');
    const withoutShot = buildRecoveredTake(baseCheckpoint(), 1_010_000);
    expect('shotId' in withoutShot).toBe(false);
  });

  it('multi-cam, both units still rolling: explicit units, each timed off its OWN start against takeStartedAt', () => {
    const cp = baseCheckpoint({
      takeStartedAt: 1_000_000,
      camRolls: { A: 1_000_000, B: 1_002_000 }, // B joined 2s late
    });
    const input = buildRecoveredTake(cp, 1_010_000);
    expect(input.units).toEqual(
      expect.arrayContaining([
        { unit: 'A', startOffsetMs: 0, durationMs: 10_000 },
        { unit: 'B', startOffsetMs: 2000, durationMs: 8000 },
      ]),
    );
    expect(input.units).toHaveLength(2);
  });

  it('a camera that already cut once this take (finishedRolls) keeps its already-computed timing untouched, even though it is no longer in camRolls', () => {
    const cp = baseCheckpoint({
      takeStartedAt: 1_000_000,
      camRolls: { B: 1_005_000 }, // B rejoined after A's first file closed
      finishedRolls: [{ unit: 'A', startOffsetMs: 0, durationMs: 3000 }],
    });
    const input = buildRecoveredTake(cp, 1_010_000);
    expect(input.units).toEqual(
      expect.arrayContaining([
        { unit: 'A', startOffsetMs: 0, durationMs: 3000 },
        { unit: 'B', startOffsetMs: 5000, durationMs: 5000 },
      ]),
    );
  });

  it('sound already finished before the crash: its stored timing is used verbatim, not recomputed against now', () => {
    const cp = baseCheckpoint({
      takeStartedAt: 1_000_000,
      camRolls: { A: 1_000_000 },
      soundFinished: { startOffsetMs: 0, durationMs: 4000 },
    });
    const input = buildRecoveredTake(cp, 1_010_000);
    expect(input.sound).toEqual({ startOffsetMs: 0, durationMs: 4000 });
  });

  it('sound still rolling at the crash: timed against now like a still-rolling camera', () => {
    const cp = baseCheckpoint({
      takeStartedAt: 1_000_000,
      camRolls: { A: 1_000_000 },
      soundStartedAt: 1_000_000,
    });
    const input = buildRecoveredTake(cp, 1_010_000);
    expect(input.sound).toEqual({ startOffsetMs: 0, durationMs: 10_000 });
  });

  it('single-cam WITH sound (the engine path even though cameras.length is 1): units is still explicit, never omitted, because sound makes this an engine take', () => {
    const cp = baseCheckpoint({ takeStartedAt: 1_000_000, camRolls: { A: 1_000_000 }, soundStartedAt: 1_000_000 });
    const input = buildRecoveredTake(cp, 1_010_000);
    expect(input.units).toEqual([{ unit: 'A', startOffsetMs: 0, durationMs: 10_000 }]);
    expect(input.sound).toBeDefined();
  });

  it('an armed MARK IN folds into the moments, ending at the RECONSTRUCTED duration, not wherever it was when the tab died', () => {
    const cp = baseCheckpoint({ takeStartedAt: 1_000_000, markInMs: 2000, buffered: [] });
    const input = buildRecoveredTake(cp, 1_010_000);
    expect(input.moments).toEqual([{ kind: 'range', atMs: 2000, endMs: 10_000, label: '' }]);
  });

  it('every buffered tag/mark survives verbatim', () => {
    const buffered = [
      { kind: 'point' as const, atMs: 1000, label: '', tag: 'GOLD' },
      { kind: 'range' as const, atMs: 3000, endMs: 4000, label: '' },
    ];
    const cp = baseCheckpoint({ buffered });
    const input = buildRecoveredTake(cp, 1_010_000);
    expect(input.moments).toEqual(buffered);
  });
});

// --------------------------------------- the sound-solo / no-camera guard ---
//
// RollRecovery.tsx refuses to call store.createTake at all when this is true
// AND the project is single-cam AND has a sound unit - see noCameraEverJoined's
// own comment for why (buildTakeClips' single-cam path fabricates a clip
// regardless of what `units` says). Pinned here since the check itself is
// pure; the "and also isMultiCam(project) is false AND hasSound(project) is
// true" half lives in RollRecovery.tsx (a plain single-cam-no-sound
// checkpoint ALSO always has empty camRolls/finishedRolls, so this function
// alone cannot tell that apart from the sound-solo case — see its own
// comment), which this DOM-less suite cannot mount - see the task's own note
// on RollingScreen.test.ts for the same split.

describe('noCameraEverJoined', () => {
  it('sound rolled solo, no camera ever joined: true', () => {
    const cp = baseCheckpoint({ camRolls: {}, finishedRolls: [], soundStartedAt: 1_000_000 });
    expect(noCameraEverJoined(cp)).toBe(true);
  });

  it('a camera is currently rolling: false', () => {
    const cp = baseCheckpoint({ camRolls: { A: 1_000_000 } });
    expect(noCameraEverJoined(cp)).toBe(false);
  });

  it('a camera already finished once this take (even with none CURRENTLY in camRolls): false - it DID roll', () => {
    const cp = baseCheckpoint({ camRolls: {}, finishedRolls: [{ unit: 'A', startOffsetMs: 0, durationMs: 3000 }] });
    expect(noCameraEverJoined(cp)).toBe(false);
  });

  it('plain single-cam-no-sound checkpoint: true (camRolls/finishedRolls are always empty on that path) - RollRecovery must combine this with isMultiCam, never use it alone', () => {
    const cp = baseCheckpoint({ camRolls: {}, finishedRolls: [] });
    expect(noCameraEverJoined(cp)).toBe(true);
  });
});

// ------------------------------------------------------- pending resume ---

describe('setPendingResume / takePendingResume', () => {
  it('handed back exactly once, to the matching slate/shot', () => {
    const cp = baseCheckpoint({ slateId: 's1', shotId: 'sh1' });
    setPendingResume(cp);
    expect(takePendingResume('s1', 'sh1')).toEqual(cp);
    expect(takePendingResume('s1', 'sh1')).toBeNull(); // consumed - never handed back twice
  });

  it('a mismatched slate/shot leaves the mailbox alone for whoever actually matches', () => {
    const cp = baseCheckpoint({ slateId: 's1', shotId: 'sh1' });
    setPendingResume(cp);
    expect(takePendingResume('s2', undefined)).toBeNull();
    expect(takePendingResume('s1', 'sh1')).toEqual(cp); // still there for the real match
  });

  it('nothing pending: null, never throws', () => {
    expect(takePendingResume('s1', undefined)).toBeNull();
  });
});
