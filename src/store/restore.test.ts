// Restore's contract, exercised through the real store facade (in Node/test
// this resolves to the in-memory localStorage-fallback backend — see
// store/index.ts's pickBackend — so these run with no browser, no mocks of
// the storage layer itself). Four guarantees pinned here, matching the brief:
//
//   1. a full round trip preserves every optional field verbatim
//   2. id remapping leaves NO original id anywhere in the restored data
//   3. restoring the SAME backup twice produces two fully independent projects
//   4. a restore that fails partway through leaves NOTHING behind — no half
//      -built project sitting in the list looking real

import { describe, expect, it, vi } from 'vitest';
import { store } from './index';
import { restoreBackup } from './restore';
import type { Moment, Project, ProjectBundle, Shot, Slate, Take } from '../types';

/** A deliberately field-heavy bundle: every optional field this feature has
 * to preserve gets a non-default value, so a dropped field shows up as a
 * failing assertion rather than a silent `undefined`. */
function richBundle(projectId: string): ProjectBundle {
  const project: Project = {
    id: projectId,
    name: 'Bhoot',
    fps: 24,
    clipPrefix: 'C',
    nextClipNumber: 42,
    clipPadding: 4,
    clipSuffix: '_A',
    clipExt: '.MP4',
    camera: 'sony',
    sound: {
      filePrefix: 'SND_',
      nextFileNumber: 10,
      filePadding: 4,
      fileExt: '.WAV',
      recorder: 'MixPre-6',
      operator: 'Priya',
    },
    tags: ['GOLD', 'NOISE'],
    openShootDay: { index: 2, date: '2026-07-30', firstTakeAt: 500, lastTakeAt: 900 },
    clipStart: 1,
    createdAt: 111,
    updatedAt: 222,
  };

  const shot1: Shot = {
    id: 'shot-1',
    code: '5.31',
    order: 0,
    size: 'MCU',
    move: 'STATIC, low',
    action: 'she turns',
    dialogue: 'Where were you?',
    note: 'watch the lamp',
    tags: [{ id: 'tag-1', label: 'GOLD', tier: 'keyMoment', order: 0 }],
  };

  const slate1: Slate = {
    id: 'slate-1',
    projectId,
    name: 'Scene 5',
    order: 0,
    shootOrder: 1,
    summary: 'kitchen scene',
    scriptRef: 'SC 5',
    tags: [{ id: 'stag-1', label: 'WIDE', tier: 'coverage', order: 0 }],
    today: true,
    shots: [shot1],
    createdAt: 10,
    updatedAt: 20,
  };
  const slate2: Slate = { id: 'slate-2', projectId, name: 'Scene 6', order: 1, createdAt: 30, updatedAt: 40 };

  const take1: Take = {
    id: 'take-1',
    slateId: 'slate-1',
    shotId: 'shot-1',
    projectId,
    number: 1,
    clipName: 'C0042_A',
    clips: [{ unit: 'A', clipName: 'C0042_A', startOffsetMs: 0, durationMs: 5000 }],
    sound: { fileName: 'SND_0010', startOffsetMs: 0, durationMs: 5000 },
    status: 'good',
    startedAt: 1000,
    durationMs: 5000,
    cameraTC: '01:00:00:00',
    note: 'good take',
    shootDay: '2026-07-30',
    shootDayIndex: 2,
    createdAt: 1500,
    updatedAt: 1600,
  };
  const take2: Take = {
    id: 'take-2',
    slateId: 'slate-2',
    projectId,
    number: 1,
    clipName: 'C0043_A',
    status: 'discarded',
    startedAt: 2000,
    durationMs: 3000,
    createdAt: 2500,
    updatedAt: 2600,
  };

  const moment1: Moment = {
    id: 'mo-1',
    takeId: 'take-1',
    kind: 'range',
    atMs: 100,
    endMs: 400,
    label: 'door slam',
    tag: 'GOLD',
    createdAt: 1700,
    updatedAt: 1700,
  };
  const moment2: Moment = {
    id: 'mo-2',
    takeId: 'take-2',
    kind: 'point',
    atMs: 50,
    label: '',
    createdAt: 2700,
    updatedAt: 2700,
  };

  return { project, slates: [slate1, slate2], takes: [take1, take2], moments: [moment1, moment2] };
}

describe('restoreBackup — full round trip', () => {
  it('preserves every optional field verbatim, remapping only ids and parent references', async () => {
    const original = richBundle('orig-p1');
    const restored = await restoreBackup(original);

    expect(restored.id).not.toBe(original.project.id);
    expect(restored.name).toBe('Bhoot (restored)'); // obviously the restored copy

    const bundle = await store.getBundle(restored.id);

    expect(bundle.project.fps).toBe(24);
    expect(bundle.project.clipPrefix).toBe('C');
    expect(bundle.project.nextClipNumber).toBe(42); // the physical counter, carried over — never re-derived
    expect(bundle.project.clipSuffix).toBe('_A');
    expect(bundle.project.clipExt).toBe('.MP4');
    expect(bundle.project.camera).toBe('sony');
    expect(bundle.project.sound).toEqual(original.project.sound);
    expect(bundle.project.tags).toEqual(['GOLD', 'NOISE']);
    expect(bundle.project.openShootDay).toEqual(original.project.openShootDay);
    expect(bundle.project.clipStart).toBe(1);

    expect(bundle.slates).toHaveLength(2);
    const s1 = bundle.slates.find((s) => s.name === 'Scene 5')!;
    const s2 = bundle.slates.find((s) => s.name === 'Scene 6')!;
    expect(s1.order).toBe(0);
    expect(s2.order).toBe(1);
    expect(s1.shootOrder).toBe(1);
    expect(s1.summary).toBe('kitchen scene');
    expect(s1.scriptRef).toBe('SC 5');
    expect(s1.tags).toEqual(original.slates[0].tags);
    expect(s1.today).toBe(true);
    expect(s1.shots).toHaveLength(1);
    expect(s1.shots![0]).toMatchObject({
      code: '5.31',
      order: 0,
      size: 'MCU',
      move: 'STATIC, low',
      action: 'she turns',
      dialogue: 'Where were you?',
      note: 'watch the lamp',
      tags: original.slates[0].shots![0].tags,
    });
    // A scene with no breakdown/shootOrder/etc must come back with those keys
    // ABSENT, not present-and-undefined (the house "legacy means absent" rule).
    expect('shots' in s2).toBe(false);
    expect('shootOrder' in s2).toBe(false);
    expect('summary' in s2).toBe(false);
    expect('scriptRef' in s2).toBe(false);
    expect('tags' in s2).toBe(false);
    expect('today' in s2).toBe(false);

    expect(bundle.takes).toHaveLength(2);
    const t1 = bundle.takes.find((t) => t.clipName === 'C0042_A')!;
    const t2 = bundle.takes.find((t) => t.clipName === 'C0043_A')!;
    expect(t1.slateId).toBe(s1.id);
    expect(t1.shotId).toBe(s1.shots![0].id);
    expect(t1.number).toBe(1);
    expect(t1.clips).toEqual(original.takes[0].clips);
    expect(t1.sound).toEqual(original.takes[0].sound);
    expect(t1.status).toBe('good');
    expect(t1.startedAt).toBe(1000);
    expect(t1.durationMs).toBe(5000);
    expect(t1.cameraTC).toBe('01:00:00:00');
    expect(t1.note).toBe('good take');
    expect(t1.shootDay).toBe('2026-07-30');
    expect(t1.shootDayIndex).toBe(2);
    // createdAt/updatedAt are a physical fact (CUT-order position other store
    // logic keys on — see util.ts's inCutOrder), so takes preserve them too.
    expect(t1.createdAt).toBe(1500);
    expect(t1.updatedAt).toBe(1600);

    expect(t2.slateId).toBe(s2.id);
    expect('shotId' in t2).toBe(false); // legacy scene-level take stays scene-level
    expect(t2.status).toBe('discarded');

    expect(bundle.moments).toHaveLength(2);
    const m1 = bundle.moments.find((m) => m.label === 'door slam')!;
    const m2 = bundle.moments.find((m) => m.atMs === 50)!;
    expect(m1.takeId).toBe(t1.id);
    expect(m1.kind).toBe('range');
    expect(m1.endMs).toBe(400);
    expect(m1.tag).toBe('GOLD');
    expect(m2.takeId).toBe(t2.id);
    expect('tag' in m2).toBe(false);
    expect('endMs' in m2).toBe(false);
  });

  it('leaves no original id anywhere in the restored data', async () => {
    const original = richBundle('orig-p2');
    const restored = await restoreBackup(original);
    const bundle = await store.getBundle(restored.id);

    const originalIds = new Set<string>([
      original.project.id,
      ...original.slates.map((s) => s.id),
      ...original.slates.flatMap((s) => (s.shots ?? []).map((sh) => sh.id)),
      ...original.takes.map((t) => t.id),
      ...original.moments.map((m) => m.id),
    ]);

    const restoredIds = [
      bundle.project.id,
      ...bundle.slates.map((s) => s.id),
      ...bundle.slates.flatMap((s) => (s.shots ?? []).map((sh) => sh.id)),
      ...bundle.takes.map((t) => t.id),
      ...bundle.moments.map((m) => m.id),
    ];

    for (const id of restoredIds) {
      expect(originalIds.has(id)).toBe(false);
    }
  });
});

describe('restoreBackup — isolation', () => {
  it('restoring the exact same backup twice produces two independent projects', async () => {
    const original = richBundle('orig-p3');
    const a = await restoreBackup(original);
    const b = await restoreBackup(original);

    expect(a.id).not.toBe(b.id);

    const bundleA = await store.getBundle(a.id);
    const bundleB = await store.getBundle(b.id);
    const idsA = new Set(bundleA.takes.map((t) => t.id));
    const idsB = new Set(bundleB.takes.map((t) => t.id));
    for (const id of idsA) expect(idsB.has(id)).toBe(false);

    // Editing one must never reach the other.
    await store.updateProject(a.id, { name: 'Changed only on A' });
    const freshB = await store.getProject(b.id);
    expect(freshB!.name).toBe('Bhoot (restored)');

    await store.deleteSlate(bundleA.slates[0].id);
    const stillThereOnB = await store.listSlates(b.id);
    expect(stillThereOnB).toHaveLength(2);
  });
});

describe('restoreBackup — never partially writes', () => {
  it('rolls back the whole project if a write fails partway through', async () => {
    const original = richBundle('orig-p4');
    const beforeIds = new Set((await store.listProjects()).map((p) => p.id));

    const spy = vi.spyOn(store, 'createSlate').mockRejectedValueOnce(new Error('boom'));
    await expect(restoreBackup(original)).rejects.toThrow('boom');
    spy.mockRestore();

    // No orphaned project left sitting in the list looking real — the id
    // createRestoredProject minted must not survive the rollback.
    const after = await store.listProjects();
    const leftBehind = after.filter((p) => !beforeIds.has(p.id));
    expect(leftBehind).toHaveLength(0);
  });

  it('drops a take that references a scene missing from its own bundle, rather than corrupting the rest', async () => {
    const original = richBundle('orig-p5');
    original.takes.push({
      id: 'ghost',
      slateId: 'no-such-slate',
      projectId: original.project.id,
      number: 99,
      clipName: 'C9999',
      status: 'good',
      startedAt: 0,
      durationMs: 0,
      createdAt: 0,
      updatedAt: 0,
    });

    const restored = await restoreBackup(original);
    const bundle = await store.getBundle(restored.id);
    expect(bundle.takes.map((t) => t.clipName).sort()).toEqual(['C0042_A', 'C0043_A']);
  });
});
