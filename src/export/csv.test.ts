// The DATE column: real shootDay when the take has one, else a display-only
// label derived from startedAt (never written back — see order.ts's
// displayShootDay and the migration note in store/util.ts).

import { describe, expect, it } from 'vitest';
import { toCsv } from './csv';
import type { Project, ProjectBundle, Slate, Take } from '../types';

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

async function csvOf(takes: Take[]): Promise<string> {
  const bundle: ProjectBundle = { project: project(), slates: [slate()], takes, moments: [] };
  return toCsv(bundle).text();
}

function row(csv: string, i: number): string[] {
  // Simple split: none of these fixtures need a value with a comma in it.
  return csv.trim().split('\r\n')[i].split(',');
}

describe('csv.ts — DATE column', () => {
  it('gains a date column, positioned right after take', async () => {
    const csv = await csvOf([]);
    expect(row(csv, 0)).toEqual([
      'scene', 'shot', 'take', 'date', 'clip', 'camera', 'operator', 'sound_file', 'status',
      'kind', 'tag', 'label', 'in_clock', 'out_clock', 'in_tc', 'out_tc', 'camera_in_tc',
      'camera_out_tc', 'wall_in', 'wall_out', 'duration_ms', 'note',
    ]);
  });

  it('carries the real shootDay verbatim when the take has one', async () => {
    const t: Take = {
      id: 't1', slateId: 's1', projectId: 'p1', number: 1, clipName: 'C0001',
      shootDay: '2026-07-31', status: 'good', startedAt: 0, durationMs: 1000,
      createdAt: 0, updatedAt: 0,
    };
    const csv = await csvOf([t]);
    expect(row(csv, 1)[3]).toBe('2026-07-31');
  });

  it('derives a display-only date from startedAt for a legacy take with no shootDay', async () => {
    const startedAt = Date.UTC(2026, 0, 15, 12, 0, 0); // local-date derivation, UTC noon avoids TZ edge flips
    const t: Take = {
      id: 't1', slateId: 's1', projectId: 'p1', number: 1, clipName: 'C0001',
      status: 'good', startedAt, durationMs: 1000, createdAt: 0, updatedAt: 0,
    };
    const csv = await csvOf([t]);
    const d = new Date(startedAt);
    const expected = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
    expect(row(csv, 1)[3]).toBe(expected);
  });
});
