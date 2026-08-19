// Same shoot-day asset-collision fix as fcpxml.test.ts, for the FCPXML
// (Resolve) exporter: every shoot day restarts numbering at C0001, so the
// (clipName, unit) key an <asset> used to be registered under alone is not
// stable across days, and its `src` path is what Resolve actually relinks on.

import { describe, expect, it } from 'vitest';
import { toResolveXml } from './resolve';
import type { CameraUnit, Project, ProjectBundle, Slate, Take } from '../types';

function baseProject(overrides: Partial<Project> = {}): Project {
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
    ...overrides,
  };
}

function slate(id: string, order: number): Slate {
  return { id, projectId: 'p1', name: `Scene ${id}`, order, createdAt: 0, updatedAt: 0 };
}

function take(id: string, slateId: string, number: number, clipName: string, shootDay?: string): Take {
  return {
    id,
    slateId,
    projectId: 'p1',
    number,
    clipName,
    status: 'good',
    startedAt: 0,
    durationMs: 1000,
    ...(shootDay !== undefined ? { shootDay } : {}),
    createdAt: 0,
    updatedAt: 0,
  };
}

async function xmlOf(bundle: ProjectBundle): Promise<string> {
  return toResolveXml(bundle).text();
}

function assetSrcs(xml: string): string[] {
  return [...xml.matchAll(/src="file:\/\/\/([^"]+)"/g)].map((m) => m[1]);
}

describe('resolve.ts single-cam — shoot-day keeps same-numbered clips from different days apart', () => {
  it('two takes on different days with the same clip name get DISTINCT asset src paths', async () => {
    const bundle: ProjectBundle = {
      project: baseProject(),
      slates: [slate('s1', 0), slate('s2', 1)],
      takes: [
        take('t1', 's1', 1, 'C0001', '2026-01-01'),
        take('t2', 's2', 1, 'C0001', '2026-01-05'),
      ],
      moments: [],
    };
    const xml = await xmlOf(bundle);
    const srcs = assetSrcs(xml);
    expect(new Set(srcs).size).toBe(2); // this is the bug: it used to be 1
    expect(srcs).toContain('A_20260101/C0001.MP4');
    expect(srcs).toContain('A_20260105/C0001.MP4');
    expect((xml.match(/<asset id=/g) ?? []).length).toBe(2);
  });

  it('a legacy take with no shootDay gets the plain filename, no folder at all — byte-identical to before', async () => {
    const bundle: ProjectBundle = {
      project: baseProject(),
      slates: [slate('s1', 0)],
      takes: [take('t1', 's1', 1, 'C0001')],
      moments: [],
    };
    const xml = await xmlOf(bundle);
    expect(assetSrcs(xml)).toEqual(['C0001.MP4']);
  });

  it('two legacy takes (no shootDay) with the same clip name still collapse into ONE asset — the old behaviour, unchanged', async () => {
    const bundle: ProjectBundle = {
      project: baseProject(),
      slates: [slate('s1', 0), slate('s2', 1)],
      takes: [take('t1', 's1', 1, 'C0001'), take('t2', 's2', 1, 'C0001')],
      moments: [],
    };
    const xml = await xmlOf(bundle);
    expect((xml.match(/<asset id=/g) ?? []).length).toBe(1);
  });
});

describe('resolve.ts multi-cam — the day folds into the per-unit path segment', () => {
  function multiProject(): Project {
    const unit = (letter: 'A' | 'B'): CameraUnit => ({
      letter,
      clipPrefix: 'C',
      nextClipNumber: 1,
      clipPadding: 4,
      clipExt: '.MP4',
    });
    return baseProject({ cameras: [unit('A'), unit('B')] });
  }

  it('the SAME unit on two different days with the same clip name gets DISTINCT src paths', async () => {
    const bundle: ProjectBundle = {
      project: multiProject(),
      slates: [slate('s1', 0), slate('s2', 1)],
      takes: [
        { ...take('t1', 's1', 1, 'C0001', '2026-01-01'), clips: [{ unit: 'A', clipName: 'C0001' }] },
        { ...take('t2', 's2', 1, 'C0001', '2026-01-05'), clips: [{ unit: 'A', clipName: 'C0001' }] },
      ],
      moments: [],
    };
    const xml = await xmlOf(bundle);
    const srcs = assetSrcs(xml);
    expect(new Set(srcs).size).toBe(2);
    expect(srcs).toContain('A_20260101/C0001.MP4');
    expect(srcs).toContain('A_20260105/C0001.MP4');
  });

  it('a legacy multi-cam take keeps the plain per-unit-letter folder, exactly as before', async () => {
    const bundle: ProjectBundle = {
      project: multiProject(),
      slates: [slate('s1', 0)],
      takes: [{ ...take('t1', 's1', 1, 'C0001'), clips: [{ unit: 'A', clipName: 'C0001' }] }],
      moments: [],
    };
    const xml = await xmlOf(bundle);
    expect(assetSrcs(xml)).toEqual(['A/C0001.MP4']);
  });
});

describe('resolve.ts sound — the recorder file collides across days the same way picture cards do', () => {
  function projectWithSound(): Project {
    return baseProject({
      sound: { filePrefix: 'SND_', nextFileNumber: 1, filePadding: 4, fileExt: '.WAV' },
    });
  }

  it('two takes on different days recording the same sound file name get DISTINCT src paths', async () => {
    const bundle: ProjectBundle = {
      project: projectWithSound(),
      slates: [slate('s1', 0), slate('s2', 1)],
      takes: [
        { ...take('t1', 's1', 1, 'C0001', '2026-01-01'), sound: { fileName: 'SND_0001' } },
        { ...take('t2', 's2', 1, 'C0002', '2026-01-05'), sound: { fileName: 'SND_0001' } },
      ],
      moments: [],
    };
    const xml = await xmlOf(bundle);
    const srcs = assetSrcs(xml).filter((s) => s.includes('SND'));
    expect(new Set(srcs).size).toBe(2);
    expect(srcs).toContain('SND_20260101/SND_0001.WAV');
    expect(srcs).toContain('SND_20260105/SND_0001.WAV');
  });

  it('a legacy take recording sound keeps the plain "SND/" folder, exactly as before', async () => {
    const bundle: ProjectBundle = {
      project: projectWithSound(),
      slates: [slate('s1', 0)],
      takes: [{ ...take('t1', 's1', 1, 'C0001'), sound: { fileName: 'SND_0001' } }],
      moments: [],
    };
    const xml = await xmlOf(bundle);
    const srcs = assetSrcs(xml).filter((s) => s.includes('SND'));
    expect(srcs).toEqual(['SND/SND_0001.WAV']);
  });
});

describe('resolve.ts multi-cam — a camera that cut and rejoined inside one take', () => {
  function multiProject(): Project {
    const unit = (letter: 'A' | 'B'): CameraUnit => ({
      letter,
      clipPrefix: 'C',
      nextClipNumber: 1,
      clipPadding: 4,
      clipExt: '.MP4',
    });
    return baseProject({ cameras: [unit('A'), unit('B')] });
  }

  // B swapped a card 3s in and came back at 5s while A ran the whole 10s: two
  // physical files on B's card, both belonging to take 1.
  function rejoinBundle(): ProjectBundle {
    return {
      project: multiProject(),
      slates: [slate('s1', 0)],
      takes: [
        {
          ...take('t1', 's1', 1, 'C0001'),
          durationMs: 10000,
          clips: [
            { unit: 'A', clipName: 'C0001', startOffsetMs: 0, durationMs: 10000 },
            { unit: 'B', clipName: 'C0004', startOffsetMs: 0, durationMs: 3000 },
            { unit: 'B', clipName: 'C0005', startOffsetMs: 5000, durationMs: 5000 },
          ],
        },
      ],
      moments: [],
    };
  }

  it('registers BOTH of B files as assets, so neither card goes unrelinkable', async () => {
    const srcs = assetSrcs(await xmlOf(rejoinBundle()));
    expect(srcs).toContain('B/C0004.MP4');
    expect(srcs).toContain('B/C0005.MP4');
  });

  it('puts both files on B own lane, the second offset to where it actually started', async () => {
    const xml = await xmlOf(rejoinBundle());
    const lanes = [...xml.matchAll(/<asset-clip ref="[^"]+" lane="(\d+)" offset="([^"]+)" name="(C\d+)"/g)].map(
      (m) => ({ lane: m[1], offset: m[2], name: m[3] }),
    );
    // Story pass and selects pass each lay the take once; both of B's files
    // ride lane 1 (one lane per CAMERA), C0004 at the anchor and C0005 5s in.
    const first = lanes.filter((l) => l.name === 'C0004');
    const second = lanes.filter((l) => l.name === 'C0005');
    expect(first.length).toBe(2);
    expect(second.length).toBe(2);
    expect(new Set([...first, ...second].map((l) => l.lane))).toEqual(new Set(['1']));
    expect(new Set(first.map((l) => l.offset))).toEqual(new Set(['0/24s']));
    expect(new Set(second.map((l) => l.offset))).toEqual(new Set(['120/24s']));
  });
});

// ---------------------------------------------------------------------------
// This exporter used to ignore project.mediaRoot outright, which meant a
// project that HAD told the app where its footage lives still imported into
// Resolve fully offline — the exact failure the field exists to prevent, and
// the one fcpxml.ts had already fixed for Premiere.

describe('resolve.ts — the editor’s footage root reaches the asset src', () => {
  // assetSrcs() above captures what follows "file:///", so an absolute root's
  // own leading slash is the third one of the scheme and never appears in the
  // capture. Asserting on the whole URL keeps that visible.
  const srcUrls = (xml: string) => assetSrcs(xml).map((p) => `file:///${p}`);

  it('single-cam: the root sits above the file, percent-encoded', async () => {
    const bundle: ProjectBundle = {
      project: baseProject({ mediaRoot: '/Volumes/My Book-02/HU kon Chu? day 1' }),
      slates: [slate('s1', 0)],
      takes: [take('t1', 's1', 1, 'crav_0054')],
      moments: [],
    };
    expect(srcUrls(await xmlOf(bundle))).toEqual([
      'file:///Volumes/My%20Book-02/HU%20kon%20Chu%3F%20day%201/crav_0054.MP4',
    ]);
  });

  it('single-cam with a shoot day: the root sits above the day folder', async () => {
    const bundle: ProjectBundle = {
      project: baseProject({ mediaRoot: '/Volumes/SSD' }),
      slates: [slate('s1', 0)],
      takes: [take('t1', 's1', 1, 'C0001', '2026-01-01')],
      moments: [],
    };
    expect(srcUrls(await xmlOf(bundle))).toEqual(['file:///Volumes/SSD/A_20260101/C0001.MP4']);
  });

  it('multi-cam: the root sits above the unit folder, which still disambiguates', async () => {
    const cameras: CameraUnit[] = [
      { letter: 'A', clipPrefix: 'C', nextClipNumber: 1, clipPadding: 4, clipExt: '.MP4' },
      { letter: 'B', clipPrefix: 'C', nextClipNumber: 1, clipPadding: 4, clipExt: '.MP4' },
    ];
    const bundle: ProjectBundle = {
      project: baseProject({ cameras, mediaRoot: '/Volumes/SSD/day 1' }),
      slates: [slate('s1', 0)],
      takes: [
        {
          ...take('t1', 's1', 1, 'C0001'),
          clips: [
            { unit: 'A', clipName: 'C0001' },
            { unit: 'B', clipName: 'C0001' },
          ],
        },
      ],
      moments: [],
    };
    expect(srcUrls(await xmlOf(bundle))).toEqual([
      'file:///Volumes/SSD/day%201/A/C0001.MP4',
      'file:///Volumes/SSD/day%201/B/C0001.MP4',
    ]);
  });

  it('with no root set, every path is exactly what it always was', async () => {
    const bundle: ProjectBundle = {
      project: baseProject(),
      slates: [slate('s1', 0)],
      takes: [take('t1', 's1', 1, 'C0001', '2026-01-01')],
      moments: [],
    };
    expect(srcUrls(await xmlOf(bundle))).toEqual(['file:///A_20260101/C0001.MP4']);
  });

  it('sound stays out of the picture root, the same way Premiere’s export does', async () => {
    // A recorder writes to its own card. Nesting SND under the camera root
    // would point Resolve confidently at a directory that does not exist.
    const bundle: ProjectBundle = {
      project: baseProject({
        mediaRoot: '/Volumes/SSD',
        sound: { filePrefix: 'SND_', nextFileNumber: 1, filePadding: 4, fileExt: '.WAV' },
      }),
      slates: [slate('s1', 0)],
      takes: [{ ...take('t1', 's1', 1, 'C0001'), sound: { fileName: 'SND_0001' } }],
      moments: [],
    };
    expect(srcUrls(await xmlOf(bundle))).toEqual([
      'file:///Volumes/SSD/C0001.MP4',
      'file:///SND/SND_0001.WAV',
    ]);
  });
});
