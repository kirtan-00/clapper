// The shoot-day asset-collision fix: every shoot day restarts numbering at
// C0001, so the fileName/reel identity a card used to be keyed on ALONE is
// not stable across days. These tests pin the fix (distinct <file>s for two
// days' same-numbered clip) and the legacy guarantee (a take with no
// shootDay collides exactly as it always did - nothing about a project that
// has never touched Shoot day may change).

import { describe, expect, it } from 'vitest';
import { toFcpXml } from './fcpxml';
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
  return toFcpXml(bundle).text();
}

describe('fcpxml.ts single-cam — shoot-day keeps same-numbered clips from different days apart', () => {
  it('two takes on different days with the same clip name get DISTINCT <file>s and reel names', async () => {
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
    // Two registered <file>s, not one: the collision the task warned about.
    expect((xml.match(/<file id="file-\d+">/g) ?? []).length).toBe(2);
    expect(xml).toContain('<reel><name>A_20260101</name></reel>');
    expect(xml).toContain('<reel><name>A_20260105</name></reel>');
  });

  it('a legacy take with no shootDay carries no <reel> at all — byte-identical to before this feature', async () => {
    const bundle: ProjectBundle = {
      project: baseProject(),
      slates: [slate('s1', 0)],
      takes: [take('t1', 's1', 1, 'C0001')],
      moments: [],
    };
    const xml = await xmlOf(bundle);
    expect(xml).not.toContain('<reel>');
    expect(xml).not.toContain('<timecode>');
  });

  it('two legacy takes (no shootDay) with the same clip name still collapse into ONE <file> — the old behaviour, unchanged', async () => {
    const bundle: ProjectBundle = {
      project: baseProject(),
      slates: [slate('s1', 0), slate('s2', 1)],
      takes: [take('t1', 's1', 1, 'C0001'), take('t2', 's2', 1, 'C0001')],
      moments: [],
    };
    const xml = await xmlOf(bundle);
    expect((xml.match(/<file id="file-\d+">/g) ?? []).length).toBe(1);
  });
});

describe('fcpxml.ts multi-cam — the day rides on the reel alongside the unit letter', () => {
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

  it('the SAME unit on two different days with the same clip name gets DISTINCT <file>s', async () => {
    const bundle: ProjectBundle = {
      project: multiProject(),
      slates: [slate('s1', 0), slate('s2', 1)],
      takes: [
        {
          ...take('t1', 's1', 1, 'C0001', '2026-01-01'),
          clips: [{ unit: 'A', clipName: 'C0001' }],
        },
        {
          ...take('t2', 's2', 1, 'C0001', '2026-01-05'),
          clips: [{ unit: 'A', clipName: 'C0001' }],
        },
      ],
      moments: [],
    };
    const xml = await xmlOf(bundle);
    expect((xml.match(/<file id="file-\d+">/g) ?? []).length).toBe(2);
    expect(xml).toContain('<reel><name>A_20260101</name></reel>');
    expect(xml).toContain('<reel><name>A_20260105</name></reel>');
  });

  it('a legacy multi-cam take keeps the plain unit-letter reel, exactly as before', async () => {
    const bundle: ProjectBundle = {
      project: multiProject(),
      slates: [slate('s1', 0)],
      takes: [{ ...take('t1', 's1', 1, 'C0001'), clips: [{ unit: 'A', clipName: 'C0001' }] }],
      moments: [],
    };
    const xml = await xmlOf(bundle);
    expect(xml).toContain('<reel><name>A</name></reel>');
    expect(xml).not.toContain('<reel><name>A_');
  });

  describe('a camera that cut and rejoined inside one take', () => {
    // B swapped a card 3s in and came back at 5s while A ran the whole 10s.
    // Two physical files on B's card, both inside take 1.
    function rejoinBundle(moments: ProjectBundle['moments'] = []): ProjectBundle {
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
        moments,
      };
    }

    it('lays BOTH of B files on the timeline, each at its own offset', async () => {
      const xml = await xmlOf(rejoinBundle());
      // Each clip is a linked video + audio clipitem pair, and the take is laid
      // twice (story cut, then selects pool): 2 x 2 = 4 sightings of each name.
      // Before the fix B's second file was dropped entirely and C0005 never
      // appeared at all.
      expect((xml.match(/<name>C0004<\/name>/g) ?? []).length).toBe(4);
      expect((xml.match(/<name>C0005<\/name>/g) ?? []).length).toBe(4);
      // The rejoined file starts 5s (120 frames at 24fps) into the take, not at 0.
      expect(xml).toMatch(/<name>C0005<\/name>[^]*?<start>120<\/start>/);
    });

    it('registers each file as its own <file>, so the editor can relink both cards', async () => {
      const xml = await xmlOf(rejoinBundle());
      expect(xml).toContain('<name>C0004.MP4</name>');
      expect(xml).toContain('<name>C0005.MP4</name>');
    });

    it('carries the take beats ONCE even when the ANCHOR camera is the one that rejoined', async () => {
      // A is the anchor (it starts the take) AND the camera that cut and came
      // back, which is the case that duplicates beats if markers hang off
      // every clip instead of the anchor's first.
      const bundle: ProjectBundle = {
        project: multiProject(),
        slates: [slate('s1', 0)],
        takes: [
          {
            ...take('t1', 's1', 1, 'C0001'),
            durationMs: 10000,
            clips: [
              { unit: 'A', clipName: 'C0001', startOffsetMs: 0, durationMs: 3000 },
              { unit: 'A', clipName: 'C0002', startOffsetMs: 5000, durationMs: 5000 },
              { unit: 'B', clipName: 'C0004', startOffsetMs: 0, durationMs: 10000 },
            ],
          },
        ],
        moments: [
          { id: 'm1', takeId: 't1', kind: 'point', atMs: 1000, label: 'the look', createdAt: 0, updatedAt: 0 },
        ],
      };
      const xml = await xmlOf(bundle);
      // Two passes over the take, so exactly two markers - not one per A clip.
      expect((xml.match(/<marker>/g) ?? []).length).toBe(2);
    });
  });
});

describe('fcpxml.ts sound — the recorder file collides across days the same way picture cards do', () => {
  function projectWithSound(): Project {
    return baseProject({
      sound: { filePrefix: 'SND_', nextFileNumber: 1, filePadding: 4, fileExt: '.WAV' },
    });
  }

  it('two takes on different days recording the same sound file name get DISTINCT sound <file>s', async () => {
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
    expect((xml.match(/<file id="soundfile-\d+">/g) ?? []).length).toBe(2);
  });
});

// The two failures a real 232-clip import hit in Premiere: every clip landed
// offline and had to be located by hand, and the bin held far more items than
// the shoot had files. Both are pinned here.

describe('fcpxml.ts — one master clip per physical file', () => {
  it('a good take, laid in BOTH the story cut and the selects pool, is ONE master clip', async () => {
    const bundle: ProjectBundle = {
      project: baseProject(),
      slates: [slate('s1', 0)],
      takes: [take('t1', 's1', 1, 'C0001')],
      moments: [],
    };
    const xml = await xmlOf(bundle);
    // Laid twice by design — story band, then selects pool.
    expect((xml.match(/<clipitem id="clipitem-\d+">/g) ?? []).length).toBe(2);
    // But one file, so one bin item.
    const masters = new Set(xml.match(/<masterclipid>[^<]+<\/masterclipid>/g) ?? []);
    expect(masters.size).toBe(1);
  });

  it('distinct master clips equal distinct FILES, not clipitems — the 232-not-351 property', async () => {
    const bundle: ProjectBundle = {
      project: baseProject(),
      slates: [slate('s1', 0)],
      takes: [
        take('t1', 's1', 1, 'C0001'),
        take('t2', 's1', 2, 'C0002'),
        { ...take('t3', 's1', 3, 'C0003'), status: 'discarded' as const },
      ],
      moments: [],
    };
    const xml = await xmlOf(bundle);
    // 2 good in the story band + all 3 in the selects pool.
    expect((xml.match(/<clipitem id="clipitem-\d+">/g) ?? []).length).toBe(5);
    const masters = new Set(xml.match(/<masterclipid>[^<]+<\/masterclipid>/g) ?? []);
    expect(masters.size).toBe(3);
  });

  it('multi-cam links picture and its own audio side to the SAME master clip', async () => {
    const unit = (letter: 'A' | 'B'): CameraUnit => ({
      letter,
      clipPrefix: 'C',
      nextClipNumber: 1,
      clipPadding: 4,
      clipExt: '.MP4',
    });
    const bundle: ProjectBundle = {
      project: baseProject({ cameras: [unit('A'), unit('B')] }),
      slates: [slate('s1', 0)],
      takes: [{ ...take('t1', 's1', 1, 'C0001'), clips: [{ unit: 'A', clipName: 'C0001' }] }],
      moments: [],
    };
    const xml = await xmlOf(bundle);
    // One camera rolled, laid in both bands, each as a linked V+A pair: 4
    // clipitems, one physical file, therefore one master clip.
    expect((xml.match(/<clipitem id="clipitem-\d+">/g) ?? []).length).toBe(4);
    const masters = new Set(xml.match(/<masterclipid>[^<]+<\/masterclipid>/g) ?? []);
    expect(masters.size).toBe(1);
  });
});

describe('fcpxml.ts — <pathurl> points where the footage actually is', () => {
  const pathsIn = (xml: string) => [...new Set(xml.match(/<pathurl>[^<]+<\/pathurl>/g) ?? [])];

  it('the editor’s real footage root lands in the path, percent-encoded', async () => {
    const bundle: ProjectBundle = {
      project: baseProject({
        mediaRoot: '/Volumes/Backup Drive-02/Wrap Reel? 8-08-2026/day 1/M4ROOT/CLIP',
      }),
      slates: [slate('s1', 0)],
      takes: [take('t1', 's1', 1, 'reel_0054')],
      moments: [],
    };
    const xml = await xmlOf(bundle);
    expect(pathsIn(xml)).toEqual([
      '<pathurl>file://localhost/Volumes/Backup%20Drive-02/Wrap%20Reel%3F%208-08-2026/day%201/M4ROOT/CLIP/reel_0054.MP4</pathurl>',
    ]);
  });

  it('with no root set, a unique file name stays BARE — what relink-others-automatically is good at', async () => {
    const bundle: ProjectBundle = {
      project: baseProject(),
      slates: [slate('s1', 0)],
      takes: [take('t1', 's1', 1, 'C0001', '2026-01-01')],
      moments: [],
    };
    const xml = await xmlOf(bundle);
    expect(pathsIn(xml)).toEqual(['<pathurl>file://localhost/C0001.MP4</pathurl>']);
  });

  it('a name that REPEATS across shoot days gets pushed into its reel folder, so the two paths differ', async () => {
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
    // Two cards, two locations. A bare name would let one "relink others
    // automatically" bind both to the same physical file, silently.
    expect(pathsIn(xml).sort()).toEqual([
      '<pathurl>file://localhost/A_20260101/C0001.MP4</pathurl>',
      '<pathurl>file://localhost/A_20260105/C0001.MP4</pathurl>',
    ]);
  });

  it('multi-cam ALWAYS nests by unit — two cameras natively write the identical name', async () => {
    const unit = (letter: 'A' | 'B'): CameraUnit => ({
      letter,
      clipPrefix: 'C',
      nextClipNumber: 1,
      clipPadding: 4,
      clipExt: '.MP4',
    });
    const bundle: ProjectBundle = {
      project: baseProject({ cameras: [unit('A'), unit('B')] }),
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
    const xml = await xmlOf(bundle);
    expect(pathsIn(xml).sort()).toEqual([
      '<pathurl>file://localhost/A/C0001.MP4</pathurl>',
      '<pathurl>file://localhost/B/C0001.MP4</pathurl>',
    ]);
  });
});
