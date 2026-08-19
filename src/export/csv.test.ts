// The DATE column: real shootDay when the take has one, else a display-only
// label derived from startedAt (never written back — see order.ts's
// displayShootDay and the migration note in store/util.ts).

import { describe, expect, it } from 'vitest';
import { toCsv } from './csv';
import { buildMediaIndex } from './medialink';
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
      'file_path', 'file_status', 'file_alternatives',
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

// ---------------------------------------------------------------------------
// The FILE columns: where the take's footage actually is, from a walk of the
// folder the user picked plus the absolute root they confirmed.

function take(id: string, clipName: string): Take {
  return {
    id, slateId: 's1', projectId: 'p1', number: 1, clipName,
    status: 'good', startedAt: 0, durationMs: 1000, createdAt: 0, updatedAt: 0,
  };
}

/** Row `i`, parsed properly — these fixtures put commas and quotes in cells. */
function cells(csv: string, i: number): string[] {
  const line = csv.trim().split('\r\n')[i];
  const out: string[] = [];
  let cur = '';
  let quoted = false;
  for (let k = 0; k < line.length; k += 1) {
    const ch = line[k];
    if (quoted) {
      if (ch === '"' && line[k + 1] === '"') { cur += '"'; k += 1; }
      else if (ch === '"') quoted = false;
      else cur += ch;
    } else if (ch === '"') quoted = true;
    else if (ch === ',') { out.push(cur); cur = ''; }
    else cur += ch;
  }
  out.push(cur);
  return out;
}

const PATH = 22, STATUS = 23, ALTS = 24;

async function csvWith(
  takes: Take[],
  paths: string[],
  mediaRoot?: string,
  rootName = 'FOOTAGE',
): Promise<string> {
  const p = { ...project(), ...(mediaRoot ? { mediaRoot } : {}) };
  const bundle: ProjectBundle = { project: p, slates: [slate()], takes, moments: [] };
  return toCsv(bundle, buildMediaIndex(paths, rootName, 0)).text();
}

describe('csv.ts — FILE columns', () => {
  it('writes an absolute location built from the walk plus the confirmed root', async () => {
    const csv = await csvWith(
      [take('t1', 'C0012')],
      ['CARD_A/PRIVATE/M4ROOT/CLIP/C0012.MP4'],
      '/Volumes/My Book/day 1',
    );
    expect(cells(csv, 1)[PATH]).toBe('/Volumes/My Book/day 1/CARD_A/PRIVATE/M4ROOT/CLIP/C0012.MP4');
    expect(cells(csv, 1)[STATUS]).toBe('matched');
    expect(cells(csv, 1)[ALTS]).toBe('');
  });

  it('leaves the location UNENCODED, because it gets pasted into Finder', async () => {
    // The one place this must not reuse mediaPath: /Volumes/My%20Book is a
    // valid <pathurl> and a dead end in every file manager and shell.
    const csv = await csvWith(
      [take('t1', 'C0012')],
      ['R&D takes/C0012.MP4'],
      '/Volumes/My Book',
    );
    expect(cells(csv, 1)[PATH]).toBe('/Volumes/My Book/R&D takes/C0012.MP4');
  });

  it('writes an empty location, never a guess, when the clip is not on the disk', async () => {
    const csv = await csvWith([take('t1', 'C0099')], ['CARD_A/C0012.MP4'], '/Volumes/My Book');
    expect(cells(csv, 1)[PATH]).toBe('');
    expect(cells(csv, 1)[STATUS]).toBe('missing');
  });

  it('reports both cards when two of them claim the same clip name', async () => {
    const csv = await csvWith(
      [take('t1', 'C0012')],
      ['CARD_A/C0012.MP4', 'CARD_B/C0012.MP4'],
      '/Volumes/My Book',
    );
    expect(cells(csv, 1)[PATH]).toBe('');
    expect(cells(csv, 1)[STATUS]).toBe('ambiguous');
    expect(cells(csv, 1)[ALTS]).toBe('/Volumes/My Book/CARD_A/C0012.MP4; /Volumes/My Book/CARD_B/C0012.MP4');
  });

  it('falls back to the relative path when no root has been confirmed', async () => {
    // Received from the walk, so not invented — and it still says which card.
    const csv = await csvWith([take('t1', 'C0012')], ['CARD_A/C0012.MP4']);
    expect(cells(csv, 1)[PATH]).toBe('CARD_A/C0012.MP4');
    expect(cells(csv, 1)[STATUS]).toBe('matched');
  });

  it('leaves all three cells blank when no folder has been picked at all', async () => {
    // Every export that ever ran before this feature, unchanged: three empty
    // trailing cells, not a row full of "missing".
    const csv = await csvOf([take('t1', 'C0012')]);
    expect(cells(csv, 1).slice(PATH)).toEqual(['', '', '']);
  });

  it('gives each camera row its OWN file, not unit A\'s', async () => {
    const t: Take = {
      ...take('t1', 'A0007'),
      clips: [
        { unit: 'A', clipName: 'A0007' },
        { unit: 'B', clipName: 'B0031' },
      ],
    };
    const bundle: ProjectBundle = {
      project: {
        ...project(),
        mediaRoot: '/Volumes/My Book',
        cameras: [
          { letter: 'A', clipPrefix: 'A', nextClipNumber: 8, clipPadding: 4 },
          { letter: 'B', clipPrefix: 'B', nextClipNumber: 32, clipPadding: 4 },
        ],
      },
      slates: [slate()],
      takes: [t],
      moments: [],
    };
    const csv = await toCsv(bundle, buildMediaIndex(['A_CARD/A0007.MP4', 'B_CARD/B0031.MP4'], 'x', 0)).text();
    expect(cells(csv, 1)[PATH]).toBe('/Volumes/My Book/A_CARD/A0007.MP4');
    expect(cells(csv, 2)[PATH]).toBe('/Volumes/My Book/B_CARD/B0031.MP4');
  });

  it('points a moment row at the same file its own clip column names', async () => {
    const t = take('t1', 'C0012');
    const bundle: ProjectBundle = {
      project: { ...project(), mediaRoot: '/Volumes/My Book' },
      slates: [slate()],
      takes: [t],
      moments: [
        { id: 'm1', takeId: 't1', kind: 'point', atMs: 500, label: 'the look', createdAt: 0, updatedAt: 0 },
      ],
    };
    const csv = await toCsv(bundle, buildMediaIndex(['CARD_A/C0012.MP4'], 'x', 0)).text();
    expect(cells(csv, 2)[9]).toBe('point'); // it really is the moment row
    expect(cells(csv, 2)[PATH]).toBe('/Volumes/My Book/CARD_A/C0012.MP4');
  });

  it('quotes a location containing a comma, like every other cell', async () => {
    const csv = await csvWith([take('t1', 'C0012')], ['day 1, pickups/C0012.MP4'], '/Volumes/SSD');
    expect(csv).toContain('"/Volumes/SSD/day 1, pickups/C0012.MP4"');
    expect(cells(csv, 1)[PATH]).toBe('/Volumes/SSD/day 1, pickups/C0012.MP4');
  });
});
