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
