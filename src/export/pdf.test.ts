// Smoke test for the DATE column added to the PDF's take bands / GOLD
// summary / discarded appendix. The column layout is exact-width-sum
// arithmetic (see the comments in pdf.ts) — this pins that it still renders
// without throwing for legacy takes (no shootDay), shootDay-stamped takes,
// GOLD moments and discarded takes all in the same document.

import { describe, expect, it } from 'vitest';
import { toPdf } from './pdf';
import type { Moment, Project, ProjectBundle, Slate, Take } from '../types';

function project(): Project {
  return {
    id: 'p1',
    name: 'Bhoot',
    fps: 24,
    clipPrefix: 'C',
    nextClipNumber: 1,
    clipPadding: 4,
    clipExt: '.MP4',
    tags: [],
    createdAt: 0,
    updatedAt: 0,
  };
}

function slate(): Slate {
  return { id: 's1', projectId: 'p1', name: 'Scene 1', order: 0, createdAt: 0, updatedAt: 0 };
}

describe('pdf.ts — DATE column does not break layout', () => {
  it('renders a legacy take, a shootDay-stamped take, a GOLD moment and a discarded take without throwing', async () => {
    const takes: Take[] = [
      {
        id: 't1', slateId: 's1', projectId: 'p1', number: 1, clipName: 'C0001',
        status: 'good', startedAt: 0, durationMs: 5000, createdAt: 0, updatedAt: 0,
      },
      {
        id: 't2', slateId: 's1', projectId: 'p1', number: 2, clipName: 'C0002',
        shootDay: '2026-07-31', status: 'good', startedAt: 0, durationMs: 5000,
        createdAt: 0, updatedAt: 0,
      },
      {
        id: 't3', slateId: 's1', projectId: 'p1', number: 3, clipName: 'C0003',
        shootDay: '2026-08-01', status: 'discarded', startedAt: 0, durationMs: 5000,
        createdAt: 0, updatedAt: 0,
      },
    ];
    const moments: Moment[] = [
      { id: 'm1', takeId: 't2', kind: 'point', atMs: 500, label: 'the look', tag: 'GOLD', createdAt: 0, updatedAt: 0 },
    ];
    const bundle: ProjectBundle = { project: project(), slates: [slate()], takes, moments };
    const blob = await toPdf(bundle);
    expect(blob.size).toBeGreaterThan(0);
    expect(blob.type).toBe('application/pdf');
  });
});
