// The Projects list's row-formatting and search-match rules, pinned here
// rather than trusted to eye. Both are pure — they take a Project and a Row
// (the already-fetched summary) and return words or a boolean, no store, no
// DOM — which is what lets them live in a plain vitest file next to the
// screen they belong to.

import { describe, expect, it } from 'vitest';
import { matchesQuery, rowMeta, type Row } from './ProjectsScreen';
import type { Project } from '../types';

function project(patch: Partial<Project> = {}): Project {
  return {
    id: 'p1',
    name: 'The Last Monsoon',
    fps: 24,
    clipPrefix: 'C',
    nextClipNumber: 1,
    clipPadding: 4,
    tags: [],
    createdAt: 0,
    updatedAt: 0,
    ...patch,
  };
}

function row(patch: Partial<Row> = {}): Row {
  return {
    project: project(),
    takeCount: 0,
    sceneCount: 0,
    shotTotal: 0,
    shotsInCan: 0,
    scenesLeft: 0,
    sceneNames: [],
    ...patch,
  };
}

describe('rowMeta', () => {
  it('draws no bar and reports the day/takes/scenes line — the "no shot list" example', () => {
    const p = project({ name: 'Bhoot Ki Kahani', openShootDay: { index: 1, date: '2026-08-20' } });
    const r = row({ project: p, takeCount: 17, sceneCount: 3, shotTotal: 0 });
    const m = rowMeta(p, r);
    expect(m.hasBar).toBe(false);
    expect(m.noShotList).toBe(true);
    expect(m.metaLine).toBe('Day 1 · 17 takes · 3 scenes');
  });

  it('draws a bar and reports shots + scenes left — the owner\'s worked example', () => {
    const p = project({ name: 'The Last Monsoon', openShootDay: { index: 3, date: '2026-08-20' } });
    const r = row({ project: p, takeCount: 61, sceneCount: 8, shotTotal: 22, shotsInCan: 14, scenesLeft: 2 });
    const m = rowMeta(p, r);
    expect(m.hasBar).toBe(true);
    expect(m.pct).toBe(64); // round(14/22*100)
    expect(m.fractionLabel).toBe('14/22 shots');
    expect(m.scenesLeftLabel).toBe('2 scenes left');
    expect(m.metaLine).toBe('Day 3 · 61 takes · 2 scenes left');
    expect(m.noShotList).toBe(false);
  });

  it('says "every scene covered" rather than "0 scenes left"', () => {
    const p = project({ openShootDay: { index: 5, date: '2026-08-20' } });
    const r = row({ project: p, takeCount: 40, sceneCount: 4, shotTotal: 10, shotsInCan: 10, scenesLeft: 0 });
    expect(rowMeta(p, r).scenesLeftLabel).toBe('every scene covered');
  });

  it('a project with zero takes reads "No takes yet", never "Day 0"', () => {
    const p = project(); // no openShootDay — nothing has rolled
    const r = row({ project: p, takeCount: 0, sceneCount: 3, shotTotal: 0 });
    const m = rowMeta(p, r);
    expect(m.day).toBe(0);
    expect(m.metaLine).toBe('No takes yet · 3 scenes');
  });

  it('a brand new project (no scenes, no takes) reads just "No takes yet"', () => {
    const p = project();
    const r = row({ project: p });
    expect(rowMeta(p, r).metaLine).toBe('No takes yet');
  });

  it('is wrapped once WRAP DAY has fired and the new day has taken nothing yet', () => {
    // wrapShootDay (store/util.ts) advances `openShootDay` to the NEXT,
    // unwrapped day the instant it wraps — `wrappedAt` never survives onto a
    // project's live state, only into `pendingWrapUndo.previousDay`. So
    // "wrapped, nothing since" is `pendingWrapUndo` present + the new day's
    // `firstTakeAt` still unset, the same test ProjectScreen's own "undo
    // wrap" button runs.
    const justWrapped = project({
      openShootDay: { index: 3, date: '2026-08-20' }, // fresh day 3, untouched
      pendingWrapUndo: { previousDay: { index: 2, date: '2026-08-19', wrappedAt: 999 } },
    });
    expect(rowMeta(justWrapped, row({ project: justWrapped, takeCount: 40 })).wrapped).toBe(true);
  });

  it('stops reading as wrapped the moment a take lands on the new day', () => {
    const rolling = project({
      openShootDay: { index: 3, date: '2026-08-20', firstTakeAt: 111, lastTakeAt: 111 },
      pendingWrapUndo: { previousDay: { index: 2, date: '2026-08-19', wrappedAt: 999 } },
    });
    expect(rowMeta(rolling, row({ project: rolling, takeCount: 41 })).wrapped).toBe(false);
  });

  it('a project that has never been wrapped is never wrapped', () => {
    const open = project({ openShootDay: { index: 2, date: '2026-08-20' } });
    expect(rowMeta(open, row({ project: open, takeCount: 5 })).wrapped).toBe(false);
  });

  it('falls back to Day 1 once a take has landed but no ShootDay was ever stamped (legacy projects)', () => {
    const p = project(); // no openShootDay at all
    const r = row({ project: p, takeCount: 4, sceneCount: 1, shotTotal: 0 });
    expect(rowMeta(p, r).day).toBe(1);
  });
});

describe('matchesQuery', () => {
  const p = project({ name: 'The Last Monsoon' });

  it('matches on the project name, case-insensitively', () => {
    const r = row({ project: p });
    expect(matchesQuery('monsoon', p, r)).toBe(true);
    expect(matchesQuery('MONSOON', p, r)).toBe(true);
    expect(matchesQuery('okkai', p, r)).toBe(false);
  });

  it('matches on a scene name the project name does not contain', () => {
    const r = row({ project: p, sceneNames: ['INT. DINER — NIGHT', 'EXT. ROOFTOP'] });
    expect(matchesQuery('diner', p, r)).toBe(true);
    expect(matchesQuery('rooftop', p, r)).toBe(true);
    expect(matchesQuery('hallway', p, r)).toBe(false);
  });

  it('an empty or whitespace query matches everything', () => {
    const r = row({ project: p });
    expect(matchesQuery('', p, r)).toBe(true);
    expect(matchesQuery('   ', p, r)).toBe(true);
  });
});
