import { describe, expect, it } from 'vitest';
import type { Project, Slate, Take } from '../types';
import { lastActivity, pickResumeProject, pickShot, pickSlate, scratchName } from './newRoll';

function project(patch: Partial<Project> & { id: string }): Project {
  return {
    name: patch.id,
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

function slate(patch: Partial<Slate> & { id: string }): Slate {
  return {
    projectId: 'p',
    name: patch.id,
    order: 0,
    createdAt: 0,
    updatedAt: 0,
    ...patch,
  };
}

function take(patch: Partial<Take> & { id: string; slateId: string }): Take {
  return {
    projectId: 'p',
    number: 1,
    clipName: 'C0001',
    status: 'good',
    startedAt: 0,
    durationMs: 1000,
    createdAt: 0,
    updatedAt: 0,
    ...patch,
  };
}

describe('pickResumeProject', () => {
  it('is null on an empty phone', () => {
    expect(pickResumeProject([])).toBeNull();
  });

  it('prefers a project with an open shoot day over a newer one without', () => {
    const shooting = project({
      id: 'shooting',
      updatedAt: 100,
      openShootDay: { index: 2, date: '2026-08-14', lastTakeAt: 150 },
    });
    const newer = project({ id: 'newer', updatedAt: 900 });
    expect(pickResumeProject([newer, shooting])?.id).toBe('shooting');
  });

  it('takes the freshest open day when several are open', () => {
    const a = project({ id: 'a', updatedAt: 10, openShootDay: { index: 1, date: 'd', lastTakeAt: 20 } });
    const b = project({ id: 'b', updatedAt: 10, openShootDay: { index: 1, date: 'd', lastTakeAt: 999 } });
    expect(pickResumeProject([a, b])?.id).toBe('b');
  });

  // The deviation from the spec: a real project with no takes yet still beats
  // inventing a scratch one.
  it('falls back to the most recently touched project when nothing is open', () => {
    const old = project({ id: 'old', updatedAt: 5 });
    const fresh = project({ id: 'fresh', updatedAt: 50 });
    expect(pickResumeProject([old, fresh])?.id).toBe('fresh');
  });

  it('counts take timestamps as activity', () => {
    const p = project({ id: 'p', updatedAt: 1, openShootDay: { index: 1, date: 'd', lastTakeAt: 77 } });
    expect(lastActivity(p)).toBe(77);
  });
});

describe('pickSlate', () => {
  it('is null when the project has no scenes', () => {
    expect(pickSlate([], [])).toBeNull();
  });

  it('returns the scene of the most recent take', () => {
    const one = slate({ id: 'one', order: 0 });
    const two = slate({ id: 'two', order: 1 });
    const takes = [
      take({ id: 't1', slateId: 'one', startedAt: 10 }),
      take({ id: 't2', slateId: 'two', startedAt: 40 }),
    ];
    expect(pickSlate([one, two], takes)?.id).toBe('two');
  });

  it("prefers today's scene when nothing has rolled", () => {
    const one = slate({ id: 'one', order: 0 });
    const two = slate({ id: 'two', order: 1, today: true });
    expect(pickSlate([one, two], [])?.id).toBe('two');
  });

  it('respects shooting order over story order', () => {
    const one = slate({ id: 'one', order: 0, shootOrder: 5 });
    const two = slate({ id: 'two', order: 9, shootOrder: 1 });
    expect(pickSlate([one, two], [])?.id).toBe('two');
  });

  it('ignores a take whose scene has since been deleted', () => {
    const one = slate({ id: 'one', order: 0 });
    const takes = [take({ id: 't', slateId: 'gone', startedAt: 99 })];
    expect(pickSlate([one], takes)?.id).toBe('one');
  });
});

describe('pickShot', () => {
  const shots = [
    { id: 's2', code: '1.2', order: 2 },
    { id: 's1', code: '1.1', order: 1 },
  ];

  it('is undefined for a scene with no breakdown', () => {
    expect(pickShot(slate({ id: 'a' }), [])).toBeUndefined();
  });

  it('takes the first shot by order when nothing has rolled', () => {
    expect(pickShot(slate({ id: 'a', shots }), [])?.id).toBe('s1');
  });

  it('resumes the shot of the most recent take on that scene', () => {
    const takes = [
      take({ id: 't1', slateId: 'a', shotId: 's1', startedAt: 5 }),
      take({ id: 't2', slateId: 'a', shotId: 's2', startedAt: 9 }),
      // another scene's newer take must not drag the selection across
      take({ id: 't3', slateId: 'b', shotId: 's1', startedAt: 99 }),
    ];
    expect(pickShot(slate({ id: 'a', shots }), takes)?.id).toBe('s2');
  });

  it('falls back to the first shot when the logged shot is gone', () => {
    const takes = [take({ id: 't', slateId: 'a', shotId: 'deleted', startedAt: 9 })];
    expect(pickShot(slate({ id: 'a', shots }), takes)?.id).toBe('s1');
  });
});

describe('scratchName', () => {
  it('names a scratch project for its day, with nothing a filename dislikes', () => {
    const name = scratchName(Date.UTC(2026, 7, 14, 12));
    expect(name).toBe('Shoot 14 Aug');
    expect(name).not.toMatch(/[/\\:·]/);
  });
});
