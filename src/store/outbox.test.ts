// Pure-logic tests for the sync outbox. No network, no real IndexedDB — these
// exercise only the pure functions outbox.ts exposes (the IDB-backed public
// API around them is a thin, best-effort persistence wrapper we can't
// meaningfully unit test without a browser, and isn't where the interesting
// logic lives).

import { describe, expect, it } from 'vitest';
import {
  coalesceDirty,
  tombstone,
  tombstonesFor,
  tombstonesForBundle,
} from './outbox';
import type { Moment, Project, ProjectBundle, Slate, Take } from '../types';

function project(id: string): Project {
  return {
    id,
    name: 'Test',
    fps: 24,
    clipPrefix: 'C',
    nextClipNumber: 1,
    clipPadding: 4,
    tags: [],
    createdAt: 0,
    updatedAt: 0,
  };
}

function slate(id: string, projectId: string): Slate {
  return { id, projectId, name: 'Scene 1', order: 0, createdAt: 0, updatedAt: 0 };
}

function take(id: string, slateId: string, projectId: string): Take {
  return {
    id,
    slateId,
    projectId,
    number: 1,
    clipName: 'C0001',
    status: 'good',
    startedAt: 0,
    durationMs: 1000,
    createdAt: 0,
    updatedAt: 0,
  };
}

function moment(id: string, takeId: string): Moment {
  return { id, takeId, kind: 'point', atMs: 500, label: '', createdAt: 0, updatedAt: 0 };
}

describe('coalesceDirty', () => {
  it('adds a new project id to an empty set', () => {
    expect(coalesceDirty([], 'p1')).toEqual(['p1']);
  });

  it('N edits to the same project collapse to one dirty entry', () => {
    let dirty: string[] = [];
    for (let i = 0; i < 25; i++) dirty = coalesceDirty(dirty, 'p1');
    expect(dirty).toEqual(['p1']);
  });

  it('keeps distinct projects separate', () => {
    let dirty: string[] = [];
    dirty = coalesceDirty(dirty, 'p1');
    dirty = coalesceDirty(dirty, 'p2');
    dirty = coalesceDirty(dirty, 'p1'); // repeat — must not duplicate or reorder
    expect(dirty).toEqual(['p1', 'p2']);
  });

  it('never mutates the input array', () => {
    const original = ['p1'];
    const result = coalesceDirty(original, 'p2');
    expect(original).toEqual(['p1']);
    expect(result).toEqual(['p1', 'p2']);
    expect(result).not.toBe(original);
  });
});

describe('tombstone / tombstonesFor', () => {
  it('captures a snapshot of the entity as `data`', () => {
    const m = moment('m1', 't1');
    const t = tombstone('moments', m, 'p1', 1000);
    expect(t).toEqual({ table: 'moments', id: 'm1', projectId: 'p1', deletedAt: 1000, data: m });
  });

  it('builds one tombstone per entity, same table/project/timestamp', () => {
    const moments = [moment('m1', 't1'), moment('m2', 't1')];
    const result = tombstonesFor('moments', moments, 'p1', 5000);
    expect(result).toHaveLength(2);
    expect(result.map((t) => t.id)).toEqual(['m1', 'm2']);
    expect(result.every((t) => t.table === 'moments' && t.projectId === 'p1' && t.deletedAt === 5000)).toBe(true);
  });

  it('returns an empty list for an empty input', () => {
    expect(tombstonesFor('takes', [], 'p1', 0)).toEqual([]);
  });
});

describe('tombstonesForBundle (delete-cascade capture)', () => {
  it('tombstones the whole subtree: project + every slate/take/moment underneath it', () => {
    const p = project('p1');
    const s1 = slate('s1', 'p1');
    const s2 = slate('s2', 'p1');
    const t1 = take('t1', 's1', 'p1');
    const t2 = take('t2', 's2', 'p1');
    const m1 = moment('m1', 't1');
    const m2 = moment('m2', 't1');
    const m3 = moment('m3', 't2');
    const bundle: ProjectBundle = { project: p, slates: [s1, s2], takes: [t1, t2], moments: [m1, m2, m3] };

    const tombstones = tombstonesForBundle(bundle, 42);

    // 1 project + 2 slates + 2 takes + 3 moments = 8, nothing dropped.
    expect(tombstones).toHaveLength(8);
    expect(tombstones.every((t) => t.projectId === 'p1' && t.deletedAt === 42)).toBe(true);

    const byTable = (table: string) => tombstones.filter((t) => t.table === table).map((t) => t.id);
    expect(byTable('projects')).toEqual(['p1']);
    expect(byTable('slates').sort()).toEqual(['s1', 's2']);
    expect(byTable('takes').sort()).toEqual(['t1', 't2']);
    expect(byTable('moments').sort()).toEqual(['m1', 'm2', 'm3']);
  });

  it('an empty project (no slates/takes/moments) tombstones only itself', () => {
    const bundle: ProjectBundle = { project: project('p1'), slates: [], takes: [], moments: [] };
    const tombstones = tombstonesForBundle(bundle, 1);
    expect(tombstones).toHaveLength(1);
    expect(tombstones[0]).toMatchObject({ table: 'projects', id: 'p1' });
  });
});
