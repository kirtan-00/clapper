// Take-number tests for the shared store helpers. These are the numbering
// authority both backends run on, so the rules that matter on set — numbers are
// per parent, a moved take joins the destination's sequence, and the hole it
// leaves behind is never closed up — are pinned here rather than in idb.ts or
// local.ts, which are just transaction wrappers around this logic.

import { describe, expect, it } from 'vitest';
import { buildTakeClips, nextTakeNumber, reassignTakeTo, rebaseClipNumbers, reclaimClipNumbers } from './util';
import type { TakeInput } from './util';
import type { CameraUnit, CameraUnitLetter, Project, Take, TakeClip } from '../types';

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

/** A three-camera project, every unit sitting on its own next clip number. */
function threeCam(): Project {
  const unit = (letter: 'A' | 'B' | 'C', next: number): CameraUnit => ({
    letter,
    clipPrefix: 'C',
    nextClipNumber: next,
    clipPadding: 4,
  });
  return {
    id: 'p1',
    name: 'Bhoot',
    fps: 24,
    clipPrefix: 'C',
    nextClipNumber: 1,
    clipPadding: 4,
    cameras: [unit('A', 7), unit('B', 12), unit('C', 3)],
    tags: [],
    createdAt: 0,
    updatedAt: 0,
  };
}

const baseInput: TakeInput = {
  slateId: 's1',
  projectId: 'p1',
  startedAt: 0,
  durationMs: 5000,
};

/** A multi-cam logged take: one clip per [unit, number], `createdAt` doubling
 * as the take's CUT-order position (the same field rebaseClipNumbers/
 * reclaimClipNumbers order by). */
function multiTake(
  id: string,
  number: number,
  slateId: string,
  clips: Array<[CameraUnitLetter, number]>,
  createdAt: number,
): Take {
  const takeClips: TakeClip[] = clips.map(([unit, n]) => ({
    unit,
    clipName: `C${String(n).padStart(4, '0')}`,
  }));
  return {
    id,
    slateId,
    projectId: 'p1',
    number,
    clipName: takeClips[0]?.clipName ?? '',
    clips: takeClips,
    status: 'good',
    startedAt: createdAt,
    durationMs: 1000,
    createdAt,
    updatedAt: createdAt,
  };
}

describe('buildTakeClips — what "no camera rolled" means', () => {
  const counters = (p: Project) => (p.cameras ?? []).map((u) => u.nextClipNumber);

  it('burns nothing when the units list is explicitly empty', () => {
    // A sound-only wild line. No camera turned over, so no card advanced, so no
    // counter may advance. This is the on-set bug: every wild line used to push
    // all three cameras one clip ahead of reality, permanently.
    const project = threeCam();
    const { take, project: after } = buildTakeClips(project, 1, { ...baseInput, units: [] }, 0);
    expect(take.clips).toEqual([]);
    expect(counters(after)).toEqual([7, 12, 3]);
  });

  it('still assumes everybody rolled when it was told nothing', () => {
    // Absent `units` is the legacy big-ROLL path and must behave as it always has.
    const { take, project: after } = buildTakeClips(threeCam(), 1, baseInput, 0);
    expect(take.clips?.map((c) => c.clipName)).toEqual(['C0007', 'C0012', 'C0003']);
    expect(counters(after)).toEqual([8, 13, 4]);
  });

  it('advances only the cameras that actually rolled', () => {
    const { take, project: after } = buildTakeClips(
      threeCam(),
      1,
      { ...baseInput, units: [{ unit: 'B', startOffsetMs: 0, durationMs: 5000 }] },
      0,
    );
    expect(take.clips?.map((c) => c.clipName)).toEqual(['C0012']);
    expect(take.clipName).toBe('C0012');
    expect(counters(after)).toEqual([7, 13, 3]);
  });
});

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

describe('rebaseClipNumbers — a per-take correction touches ONLY its own camera', () => {
  // Every take carries all three units (A/B/C) so a "correction" that leaves
  // A and C's typed value equal to their current one, exactly what
  // TakeEditSheet sends (it always includes every unit's current number, not
  // just the one the operator actually edited — see typedNumbers() in
  // TakeEditSheet.tsx), is the realistic input here, not a hand-picked easy
  // case.
  const clipOf = (t: Take, unit: CameraUnitLetter) => t.clips!.find((c) => c.unit === unit)!.clipName;

  it('shifts only the edited camera; the other two keep the exact clip names they already had', () => {
    const project = threeCam(); // next-to-write: A7, B12, C3
    const earlier = multiTake('t0', 1, 's1', [['A', 6], ['B', 11], ['C', 2]], 50);
    const edited = multiTake('t1', 2, 's1', [['A', 7], ['B', 12], ['C', 3]], 100);
    const later = multiTake('t2', 3, 's1', [['A', 8], ['B', 13], ['C', 4]], 200);
    const all = [earlier, edited, later];

    // Camera B was mis-logged as 12, corrected to 20 — A and C are handed
    // back their OWN current values, same as the real UI does.
    const result = rebaseClipNumbers(project, all, edited.id, { A: 7, B: 20, C: 3 }, 999);
    const byId = new Map(result.takes.map((t) => [t.id, t]));

    // Edited take: B changed, A and C byte-identical to what they were.
    const gotEdited = byId.get(edited.id)!;
    expect(clipOf(gotEdited, 'B')).toBe('C0020');
    expect(clipOf(gotEdited, 'A')).toBe(clipOf(edited, 'A'));
    expect(clipOf(gotEdited, 'C')).toBe(clipOf(edited, 'C'));

    // Later take: B carries the same +8 delta forward, A and C are NOT in the
    // changed set at all — untouched, not "touched but equal".
    const gotLater = byId.get(later.id)!;
    expect(clipOf(gotLater, 'B')).toBe('C0021');
    expect(byId.has(later.id)).toBe(true); // it DID change (B moved)…
    expect(clipOf(gotLater, 'A')).toBe(clipOf(later, 'A'));
    expect(clipOf(gotLater, 'C')).toBe(clipOf(later, 'C'));

    // Earlier take: never touched at all, on ANY camera — not present in the
    // returned changed set.
    expect(byId.has(earlier.id)).toBe(false);

    // The live counters: only B's shifts, by the same delta.
    const cam = (letter: CameraUnitLetter) => result.project.cameras!.find((c) => c.letter === letter)!;
    expect(cam('A').nextClipNumber).toBe(7);
    expect(cam('B').nextClipNumber).toBe(20);
    expect(cam('C').nextClipNumber).toBe(3);
  });

  it('walks the WHOLE PROJECT for the edited camera, crossing into a later scene on another day — by design, not by accident', () => {
    // A camera's card counter runs across every scene until the card is
    // swapped, so a correction here is meant to reach a take shot on a
    // different slate entirely. This is the behaviour flagged in the task:
    // confirmed intentional (rebaseClipNumbers/reclaimClipNumbers both key
    // off ALL of the project's takes, not the current scene's), and it is
    // never applied without the caller showing a preview first — see
    // TakeEditSheet's pendingShift confirmation, which lists exactly which
    // takes move before committing.
    const project = threeCam();
    const today = multiTake('t1', 1, 's-today', [['A', 7], ['B', 12], ['C', 3]], 100);
    const threeDaysAgo = multiTake('t2', 1, 's-old', [['A', 8], ['B', 13], ['C', 4]], 200);
    const all = [today, threeDaysAgo];

    const result = rebaseClipNumbers(project, all, today.id, { A: 7, B: 20, C: 3 }, 999);
    const other = result.takes.find((t) => t.id === threeDaysAgo.id);

    expect(other).toBeDefined();
    expect(other!.slateId).toBe('s-old'); // a different scene, a different day
    expect(clipOf(other!, 'B')).toBe('C0021'); // shifted anyway
    expect(clipOf(other!, 'A')).toBe(clipOf(threeDaysAgo, 'A')); // A never moves
    expect(clipOf(other!, 'C')).toBe(clipOf(threeDaysAgo, 'C')); // C never moves
  });

  it('a delta of zero (reformat only) still writes the edited take but nothing downstream', () => {
    const project = threeCam();
    const edited = multiTake('t1', 1, 's1', [['A', 7], ['B', 12], ['C', 3]], 100);
    const later = multiTake('t2', 2, 's1', [['A', 8], ['B', 13], ['C', 4]], 200);
    const result = rebaseClipNumbers(project, [edited, later], edited.id, { A: 7, B: 12, C: 3 }, 999);
    expect(result.takes.map((t) => t.id)).toEqual([edited.id]); // later never enters the changed set
  });
});

describe('reclaimClipNumbers — DELETE only reclaims the cameras that actually rolled', () => {
  const clipOf = (t: Take, unit: CameraUnitLetter) => t.clips!.find((c) => c.unit === unit)!.clipName;

  it('a take where only B rolled slides B down on every later take, and never touches A or C anywhere', () => {
    const project = threeCam();
    const bOnly = multiTake('t1', 1, 's1', [['B', 12]], 100); // wild line: only B joined
    const later = multiTake('t2', 2, 's2', [['A', 8], ['B', 13], ['C', 4]], 200); // different scene
    const result = reclaimClipNumbers(project, [bOnly, later], bOnly.id, 999);
    const changed = result.takes.find((t) => t.id === later.id)!;

    expect(changed).toBeDefined();
    expect(clipOf(changed, 'B')).toBe('C0012'); // slid down one
    expect(clipOf(changed, 'A')).toBe(clipOf(later, 'A')); // A untouched
    expect(clipOf(changed, 'C')).toBe(clipOf(later, 'C')); // C untouched

    const cam = (letter: CameraUnitLetter) => result.project.cameras!.find((c) => c.letter === letter)!;
    expect(cam('A').nextClipNumber).toBe(7); // unchanged: A never consumed a number here
    expect(cam('B').nextClipNumber).toBe(11); // 12 - 1
    expect(cam('C').nextClipNumber).toBe(3); // unchanged
  });

  it('an earlier take is never touched, even on the camera that got reclaimed', () => {
    const project = threeCam();
    const earlier = multiTake('t0', 1, 's1', [['A', 6], ['B', 11], ['C', 2]], 50);
    const doomed = multiTake('t1', 2, 's1', [['A', 7], ['B', 12], ['C', 3]], 100);
    const result = reclaimClipNumbers(project, [earlier, doomed], doomed.id, 999);
    expect(result.takes.find((t) => t.id === earlier.id)).toBeUndefined();
  });
});
