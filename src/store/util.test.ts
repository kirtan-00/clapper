// Take-number tests for the shared store helpers. These are the numbering
// authority both backends run on, so the rules that matter on set — numbers are
// per parent, a moved take joins the destination's sequence, and the hole it
// leaves behind is never closed up — are pinned here rather than in idb.ts or
// local.ts, which are just transaction wrappers around this logic.

import { describe, expect, it } from 'vitest';
import { nextTakeNumber, reassignTakeTo } from './util';
import type { Take } from '../types';

/** A logged take. `shotId` is only written when given, matching a real row. */
function take(
  id: string,
  number: number,
  slateId: string,
  shotId?: string,
  clipName = `C${String(number).padStart(4, '0')}`,
): Take {
  return {
    id,
    slateId,
    ...(shotId !== undefined ? { shotId } : {}),
    projectId: 'p1',
    number,
    clipName,
    status: 'good',
    startedAt: 0,
    durationMs: 1000,
    createdAt: 0,
    updatedAt: 0,
  };
}

describe('nextTakeNumber', () => {
  it('starts a fresh parent at 1', () => {
    expect(nextTakeNumber([])).toBe(1);
  });

  it('follows the highest number, not the count', () => {
    // A scene that lost take 2 (deleted, or moved to another setup) hands out
    // 4 next, never 3 — spoken numbers are not reissued.
    expect(nextTakeNumber([take('a', 1, 's1'), take('c', 3, 's1')])).toBe(4);
  });
});

describe('reassignTakeTo', () => {
  const shotA = 'shot-5-30';
  const shotB = 'shot-5-31';

  it('joins the destination shot at its next free number', () => {
    const moving = take('t2', 2, 's1', shotA, 'C0184');
    const moved = reassignTakeTo(moving, [take('x', 1, 's1', shotB)], { slateId: 's1', shotId: shotB }, 99);
    expect(moved.shotId).toBe(shotB);
    expect(moved.number).toBe(2);
    expect(moved.updatedAt).toBe(99);
  });

  it('never touches the clip name or anything else the camera wrote', () => {
    const moving: Take = {
      ...take('t2', 2, 's1', shotA, 'C0184'),
      clips: [
        { unit: 'A', clipName: 'C0184' },
        { unit: 'B', clipName: 'B0091' },
      ],
      sound: { fileName: 'SND_0042' },
      status: 'discarded',
      note: 'flub',
    };
    const moved = reassignTakeTo(moving, [], { slateId: 's2', shotId: shotB }, 99);
    expect(moved.clipName).toBe('C0184');
    expect(moved.clips).toEqual(moving.clips);
    expect(moved.sound).toEqual(moving.sound);
    expect(moved.status).toBe('discarded');
    expect(moved.note).toBe('flub');
    expect(moved.createdAt).toBe(moving.createdAt);
  });

  it('leaves the gap behind: the source siblings are not the caller’s problem', () => {
    // Takes 1,2,3 on 5.30; move 2 away. The helper only ever returns the ONE
    // moved take, so there is nothing a backend could write back over 5.30's
    // takes 1 and 3 — the sequence stays 1, 3 by construction.
    const source = [take('t1', 1, 's1', shotA), take('t2', 2, 's1', shotA), take('t3', 3, 's1', shotA)];
    const moved = reassignTakeTo(source[1], [], { slateId: 's1', shotId: shotB }, 99);
    expect(moved.number).toBe(1);
    expect(source[0].number).toBe(1);
    expect(source[2].number).toBe(3);
  });

  it('drops the shotId key entirely when moving to a scene with no shots', () => {
    const moving = take('t2', 2, 's1', shotA);
    const moved = reassignTakeTo(moving, [take('y', 7, 's2')], { slateId: 's2' }, 99);
    expect(moved.slateId).toBe('s2');
    expect(moved.number).toBe(8);
    // Absent, not `undefined`: a present-but-empty key would read as "has a
    // shot" to every optional check, and would index differently in IndexedDB.
    expect('shotId' in moved).toBe(false);
  });

  it('numbers a scene-level destination against scene-level takes only', () => {
    // Shot-scoped takes in the same scene are a different sequence and must not
    // raise the number handed to a take filed against the bare scene. Callers
    // pass only true siblings, so the helper counting what it is given is the
    // contract being checked here.
    const moved = reassignTakeTo(take('t2', 2, 's1', shotA), [take('y', 1, 's2')], { slateId: 's2' }, 99);
    expect(moved.number).toBe(2);
  });

  it('ignores the moved take when it is already among the destination siblings', () => {
    // Moving 5.30 take 3 to 5.31, where the app happened to hand us the full
    // shot list including the take itself: it must not renumber against itself.
    const moving = take('t3', 3, 's1', shotA);
    const moved = reassignTakeTo(
      moving,
      [take('x', 1, 's1', shotB), moving],
      { slateId: 's1', shotId: shotB },
      99,
    );
    expect(moved.number).toBe(2);
  });

  it('returns the take untouched when it is already where you are sending it', () => {
    const moving = take('t2', 2, 's1', shotA);
    expect(reassignTakeTo(moving, [take('x', 1, 's1', shotA)], { slateId: 's1', shotId: shotA }, 99)).toBe(
      moving,
    );
    const loose = take('t9', 4, 's1');
    expect(reassignTakeTo(loose, [], { slateId: 's1' }, 99)).toBe(loose);
  });
});
