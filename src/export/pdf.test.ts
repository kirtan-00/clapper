// Smoke test for the DATE column added to the PDF's take bands / GOLD
// summary / discarded appendix. The column layout is exact-width-sum
// arithmetic (see the comments in pdf.ts) — this pins that it still renders
// without throwing for legacy takes (no shootDay), shootDay-stamped takes,
// GOLD moments and discarded takes all in the same document.

import { describe, expect, it } from 'vitest';
import { packLines, toPdf } from './pdf';
import type { PDFFont } from 'pdf-lib';
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

describe('pdf.ts — the take band wraps its clip list instead of truncating it', () => {
  // A stand-in for a PDF font: every character is exactly 1 unit wide at size
  // 1, so the arithmetic below is readable rather than dependent on Helvetica's
  // real metrics. packLines only ever asks a font how wide a string is.
  const font = { widthOfTextAtSize: (s: string, size: number) => s.length * size } as PDFFont;

  it('breaks between clip names, never inside one', () => {
    const lines = packLines(['A C0191', 'B C0097', 'B C0098', 'C C0012'], ' | ', font, 1, 20);
    // Every original name survives somewhere, whole.
    for (const name of ['A C0191', 'B C0097', 'B C0098', 'C C0012']) {
      expect(lines.join(' ')).toContain(name);
    }
    // And no line got an ellipsis, which is what truncation would leave.
    expect(lines.some((l) => l.endsWith('...'))).toBe(false);
  });

  it('packs greedily, so a list that fits stays on one line', () => {
    expect(packLines(['A C0191', 'B C0097'], ' | ', font, 1, 100)).toEqual(['A C0191 | B C0097']);
  });

  it('still truncates a single name too wide for any line, rather than dropping it', () => {
    const [line] = packLines(['A_VERY_LONG_CLIP_NAME'], ' | ', font, 1, 10);
    expect(line).toHaveLength(10);
    expect(line.endsWith('...')).toBe(true);
  });

  it('renders a three-camera take where one camera rejoined, without throwing', async () => {
    const multi: Project = {
      ...project(),
      cameras: [
        { letter: 'A', clipPrefix: 'A001_C', nextClipNumber: 195, clipPadding: 4, clipExt: '.MP4' },
        { letter: 'B', clipPrefix: 'B', nextClipNumber: 99, clipPadding: 4, clipExt: '.MP4' },
        { letter: 'C', clipPrefix: 'C', nextClipNumber: 13, clipPadding: 4, clipExt: '.MP4' },
      ],
      sound: { filePrefix: 'SND_', nextFileNumber: 50, filePadding: 4, fileExt: '.WAV' },
    };
    const take: Take = {
      id: 't1', slateId: 's1', projectId: 'p1', number: 1, clipName: 'A001_C0191',
      clips: [
        { unit: 'A', clipName: 'A001_C0191', startOffsetMs: 0, durationMs: 10000 },
        { unit: 'B', clipName: 'B0097', startOffsetMs: 0, durationMs: 3000 },
        { unit: 'B', clipName: 'B0098', startOffsetMs: 5000, durationMs: 5000 },
        { unit: 'C', clipName: 'C0012', startOffsetMs: 0, durationMs: 10000 },
      ],
      sound: { fileName: 'SND_0049', startOffsetMs: 0, durationMs: 10000 },
      shootDay: '2026-08-01', status: 'good', startedAt: 0, durationMs: 10000, createdAt: 0, updatedAt: 0,
    };
    const blob = await toPdf({ project: multi, slates: [slate()], takes: [take], moments: [] });
    expect(blob.size).toBeGreaterThan(0);
  });
});
