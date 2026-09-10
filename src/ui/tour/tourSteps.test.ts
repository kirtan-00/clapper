import { describe, expect, it } from 'vitest';
import {
  DIRECTOR_RESUMABLE_STEP_IDS,
  DIRECTOR_STEPS,
  EXPORT_RESUMABLE_STEP_IDS,
  EXPORT_STEPS,
  SETUP_RESUMABLE_STEP_IDS,
  SETUP_STEPS,
  TOUR_IDS,
  type TourStep,
} from './tourSteps';

describe('DIRECTOR_STEPS', () => {
  it('every step id is unique', () => {
    const ids = DIRECTOR_STEPS.map((s) => s.id);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it('every step names a real body and title - no blank captions', () => {
    for (const step of DIRECTOR_STEPS) {
      expect(step.title.trim().length).toBeGreaterThan(0);
      expect(step.body.trim().length).toBeGreaterThan(0);
    }
  });

  it('matches the on-screen flow: scene, roll, mark, mark-out, name-range, tags, cut, keep', () => {
    expect(DIRECTOR_STEPS.map((s) => s.id)).toEqual([
      'scene',
      'roll',
      'mark',
      'mark-out',
      'name-range',
      'tags',
      'cut',
      'keep',
    ]);
  });

  it("'tags' sits before 'cut' - the tag pads live inside RollingScreen's rolling-only block and are gone from the DOM once a take is cut", () => {
    const tagsIndex = DIRECTOR_STEPS.findIndex((s) => s.id === 'tags');
    const cutIndex = DIRECTOR_STEPS.findIndex((s) => s.id === 'cut');
    expect(tagsIndex).toBeGreaterThanOrEqual(0);
    expect(cutIndex).toBeGreaterThan(tagsIndex);
  });

  // 'roll'/'cut' share TOUR_IDS.rollCut and 'mark'/'mark-out' share
  // TOUR_IDS.markIn — both are the SAME physical button on RollingScreen.tsx
  // relabelling itself. Every other pair of steps must NOT collide, or
  // TourSpotlight's on-action listener would advance the wrong step off one
  // real tap.
  it('shares a target between roll/cut and mark/mark-out only - no other accidental collisions', () => {
    const byTarget = new Map<string, string[]>();
    for (const step of DIRECTOR_STEPS) {
      const list = byTarget.get(step.target) ?? [];
      list.push(step.id);
      byTarget.set(step.target, list);
    }
    const shared = [...byTarget.entries()]
      .filter(([, ids]) => ids.length > 1)
      .map(([, ids]) => ids)
      .sort();
    expect(shared).toEqual([
      ['mark', 'mark-out'],
      ['roll', 'cut'],
    ]);
  });

  // The chapter deliberately ends on an on-action step: Director's own last
  // real move is tapping Keep, and chapter completion (see
  // TourController.tsx's advance()) returns to the chapter menu on its own
  // once that tap lands - nothing here needs one more read-and-dismiss step
  // tacked on after it just to end on 'next-button'.
  it('ends on the real Keep tap, not a caption', () => {
    const last = DIRECTOR_STEPS[DIRECTOR_STEPS.length - 1];
    expect(last.id).toBe('keep');
    expect(last.advance).toBe('on-action');
  });

  it('every resumable id names a real step in this chapter', () => {
    const ids = new Set(DIRECTOR_STEPS.map((s) => s.id));
    for (const id of DIRECTOR_RESUMABLE_STEP_IDS) {
      expect(ids.has(id)).toBe(true);
    }
  });

  // Phase A: every earlier step needs a live take or an open sheet a reload
  // cannot hand back. Kept as its own assertion (rather than folded into the
  // one above) so it stays honest and fails loudly the day Phase B's Export
  // chapter - or a future Director step - actually earns a resumable entry.
  it('carries no resumable steps yet - nothing in this chapter is reachable from a cold reload', () => {
    expect(DIRECTOR_RESUMABLE_STEP_IDS.size).toBe(0);
  });

  it('every step target names a real TOUR_IDS anchor', () => {
    const known = new Set(Object.values(TOUR_IDS));
    for (const step of DIRECTOR_STEPS) {
      expect(known.has(step.target)).toBe(true);
    }
  });
});

/** Shared across SETUP_STEPS and EXPORT_STEPS below - both chapters open a
 *  door with their first step ('on-action' on a target that lives on
 *  ProjectScreen with no sheet open), then walk steps whose targets only
 *  exist once that sheet (or, for Export's last step, the Setup sheet it
 *  borrows - see TourController.tsx's 'export' branch in `advance`) is up. */
function expectBasicStepShape(steps: readonly TourStep[]): void {
  const ids = steps.map((s) => s.id);
  expect(new Set(ids).size).toBe(ids.length);
  const known = new Set(Object.values(TOUR_IDS));
  for (const step of steps) {
    expect(step.title.trim().length).toBeGreaterThan(0);
    expect(step.body.trim().length).toBeGreaterThan(0);
    expect(known.has(step.target)).toBe(true);
  }
}

describe('SETUP_STEPS', () => {
  it('matches the on-screen flow: setup-door, setup-cameras, setup-tags', () => {
    expect(SETUP_STEPS.map((s) => s.id)).toEqual(['setup-door', 'setup-cameras', 'setup-tags']);
  });

  it('every step id is unique, every target real, no blank captions', () => {
    expectBasicStepShape(SETUP_STEPS);
  });

  it("opens on the real door tap, not a caption - 'setup-door' is on-action", () => {
    const door = SETUP_STEPS[0];
    expect(door.id).toBe('setup-door');
    expect(door.advance).toBe('on-action');
    expect(door.target).toBe(TOUR_IDS.setupDoor);
  });

  it('every step after the door is a caption read (next-button) - none of them fire their own real navigation', () => {
    for (const step of SETUP_STEPS.slice(1)) {
      expect(step.advance).toBe('next-button');
    }
  });

  it("'setup-cameras' and 'setup-tags' target elements that only exist once the Setup sheet the door step opens is up - neither collides with the door's own target", () => {
    const door = SETUP_STEPS[0].target;
    for (const step of SETUP_STEPS.slice(1)) {
      expect(step.target).not.toBe(door);
    }
  });

  it('every resumable id names a real step in this chapter', () => {
    const ids = new Set(SETUP_STEPS.map((s) => s.id));
    for (const id of SETUP_RESUMABLE_STEP_IDS) {
      expect(ids.has(id)).toBe(true);
    }
  });

  it("carries only 'setup-door' as resumable - the other two need the Setup sheet a reload cannot hand back", () => {
    expect([...SETUP_RESUMABLE_STEP_IDS]).toEqual(['setup-door']);
  });
});

describe('EXPORT_STEPS', () => {
  it('matches the on-screen flow: export-tile, export-formats, export-folder', () => {
    expect(EXPORT_STEPS.map((s) => s.id)).toEqual(['export-tile', 'export-formats', 'export-folder']);
  });

  it('every step id is unique, every target real, no blank captions', () => {
    expectBasicStepShape(EXPORT_STEPS);
  });

  it("opens on the real tile tap, not a caption - 'export-tile' is on-action", () => {
    const tile = EXPORT_STEPS[0];
    expect(tile.id).toBe('export-tile');
    expect(tile.advance).toBe('on-action');
    expect(tile.target).toBe(TOUR_IDS.exportTile);
  });

  it('every step after the tile is a caption read (next-button)', () => {
    for (const step of EXPORT_STEPS.slice(1)) {
      expect(step.advance).toBe('next-button');
    }
  });

  it("'export-formats' targets the Export sheet and 'export-folder' targets the Setup sheet it borrows - three distinct targets, none shared", () => {
    const targets = EXPORT_STEPS.map((s) => s.target);
    expect(new Set(targets).size).toBe(targets.length);
    expect(EXPORT_STEPS[1].target).toBe(TOUR_IDS.exportCsv);
    expect(EXPORT_STEPS[2].target).toBe(TOUR_IDS.exportFolder);
  });

  it('every resumable id names a real step in this chapter', () => {
    const ids = new Set(EXPORT_STEPS.map((s) => s.id));
    for (const id of EXPORT_RESUMABLE_STEP_IDS) {
      expect(ids.has(id)).toBe(true);
    }
  });

  it("carries only 'export-tile' as resumable - 'export-formats' needs the Export sheet and 'export-folder' needs the Setup sheet in its place, neither survives a reload", () => {
    expect([...EXPORT_RESUMABLE_STEP_IDS]).toEqual(['export-tile']);
  });
});

describe('cross-chapter target hygiene', () => {
  it('setup and export never collide on a target with each other or with Director - every id above spends its own anchor', () => {
    const byTarget = new Map<string, string[]>();
    for (const step of [...DIRECTOR_STEPS, ...SETUP_STEPS, ...EXPORT_STEPS]) {
      const list = byTarget.get(step.target) ?? [];
      list.push(step.id);
      byTarget.set(step.target, list);
    }
    // Director's own roll/cut and mark/mark-out pairs are the only sanctioned
    // shares (see DIRECTOR_STEPS' file header) - nothing SETUP or EXPORT adds
    // should introduce a new one.
    const shared = [...byTarget.entries()].filter(([, ids]) => ids.length > 1);
    for (const [, ids] of shared) {
      expect([...ids].sort()).toSatisfy(
        (sorted: string[]) =>
          (sorted[0] === 'mark' && sorted[1] === 'mark-out') || (sorted[0] === 'cut' && sorted[1] === 'roll'),
      );
    }
  });
});
