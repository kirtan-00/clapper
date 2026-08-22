import { describe, expect, it } from 'vitest';
import { isMultiCam, hasSound, MAX_CAMERAS } from '../types';
import {
  addUnit,
  buildProjectConfig,
  canAddUnit,
  emptyDraft,
  isReady,
  newSoundDraft,
  removeUnit,
  setUnit,
  soundExample,
  unitExample,
  type ProjectDraft,
} from './projectdraft';

const TAGS = ['FLUB', 'GOLD'];

function draft(over: Partial<ProjectDraft> = {}): ProjectDraft {
  return { ...emptyDraft(TAGS), name: 'The Last Monsoon', ...over };
}

/** A named rig of `n` cameras, each a different body, each with an operator. */
function rig(n: number): ProjectDraft {
  const bodies = ['sony', 'canonCine', 'red', 'gopro'];
  const crew = ['Rohan', 'Meera', 'Ali', 'Sam'];
  return draft({
    units: Array.from({ length: n }, (_, i) => ({ camera: bodies[i], operator: crew[i] })),
  });
}

describe('the draft itself', () => {
  it('starts as one camera, no sound, no name', () => {
    const d = emptyDraft(TAGS);
    expect(d.units).toHaveLength(1);
    expect(d.sound).toBeNull();
    expect(isReady(d)).toBe(false);
  });

  it('is ready the moment it is named, and a name of spaces is not a name', () => {
    expect(isReady(draft({ name: 'Okkai' }))).toBe(true);
    expect(isReady(draft({ name: '   ' }))).toBe(false);
  });

  it('adds one unit at a time and stops at four', () => {
    let d = emptyDraft(TAGS);
    for (let i = 0; i < 10; i++) d = addUnit(d);
    expect(d.units).toHaveLength(MAX_CAMERAS);
    expect(canAddUnit(d)).toBe(false);
  });

  it('never removes unit A, whatever index is asked for', () => {
    const d = rig(3);
    expect(removeUnit(d, 0).units).toHaveLength(3);
    expect(removeUnit(d, -1).units).toHaveLength(3);
    expect(removeUnit(d, 9).units).toHaveLength(3);
  });

  // Letters are POSITION. Dropping B has to close the gap, because there is no
  // such rig as A, C.
  it('closes the gap when a middle unit is removed', () => {
    const d = removeUnit(rig(3), 1);
    expect(d.units.map((u) => u.operator)).toEqual(['Rohan', 'Ali']);
    const cams = buildProjectConfig(d).cameras!;
    expect(cams.map((c) => c.letter)).toEqual(['A', 'B']);
    expect(cams.map((c) => c.operator)).toEqual(['Rohan', 'Ali']);
  });

  it('patches one unit and leaves the others alone', () => {
    const d = setUnit(rig(2), 1, { operator: 'Priya' });
    expect(d.units[0].operator).toBe('Rohan');
    expect(d.units[1].operator).toBe('Priya');
    expect(d.units[1].camera).toBe('canonCine');
  });

  it('shows each unit the filename its camera writes, not a dropdown label', () => {
    expect(unitExample({ camera: 'sony', operator: '' })).toBe('C0001.MP4');
    expect(unitExample({ camera: 'red', operator: '' })).toBe('A001_C001_*.R3D');
    expect(soundExample(newSoundDraft())).toBe('SND_0001.WAV');
  });
});

describe('buildProjectConfig — one camera', () => {
  const config = buildProjectConfig(rig(1));

  // The invariant every legacy path depends on: single-cam writes NO array.
  it('writes no cameras array at all', () => {
    expect(config.cameras).toBeUndefined();
    expect(isMultiCam(config)).toBe(false);
  });

  it('carries the preset in the top-level clip fields', () => {
    expect(config.camera).toBe('sony');
    expect(config.clipPrefix).toBe('C');
    expect(config.clipPadding).toBe(4);
    expect(config.clipExt).toBe('.MP4');
    expect(config.nextClipNumber).toBe(1);
  });

  it('trims the name and keeps the tags it was given', () => {
    expect(buildProjectConfig(draft({ name: '  Okkai  ' })).name).toBe('Okkai');
    expect(config.tags).toEqual(TAGS);
  });
});

describe('buildProjectConfig — four cameras', () => {
  const config = buildProjectConfig(rig(MAX_CAMERAS));

  it('carries four units', () => {
    expect(config.cameras).toHaveLength(4);
    expect(isMultiCam(config)).toBe(true);
  });

  it('gives every unit its own distinct letter, in order', () => {
    const letters = config.cameras!.map((c) => c.letter);
    expect(letters).toEqual(['A', 'B', 'C', 'D']);
    expect(new Set(letters).size).toBe(4);
  });

  it('persists every operator name', () => {
    expect(config.cameras!.map((c) => c.operator)).toEqual(['Rohan', 'Meera', 'Ali', 'Sam']);
  });

  it('omits the operator entirely when nobody was named', () => {
    const d = setUnit(rig(2), 1, { operator: '   ' });
    expect(buildProjectConfig(d).cameras![1]).not.toHaveProperty('operator');
  });

  it('derives each unit clip pattern from its own camera', () => {
    const [a, b, c, d] = config.cameras!;
    expect(a.clipPrefix).toBe('C');
    expect(b.clipPrefix).toBe('A001C');
    expect(c.clipSuffix).toBe('_*');
    expect(d.clipExt).toBe('.MP4');
  });

  it('starts every unit counting at 1', () => {
    expect(config.cameras!.every((c) => c.nextClipNumber === 1)).toBe(true);
  });

  // The other half of the multi-cam invariant: the top level still speaks, and
  // what it says is unit A.
  it('mirrors unit A into the top-level clip fields', () => {
    const a = config.cameras![0];
    expect(config.clipPrefix).toBe(a.clipPrefix);
    expect(config.clipPadding).toBe(a.clipPadding);
    expect(config.clipExt).toBe(a.clipExt);
    expect(config.camera).toBe(a.camera);
    expect(config.nextClipNumber).toBe(a.nextClipNumber);
  });

  it('never writes a fifth unit even if the draft somehow holds one', () => {
    const over = { ...rig(4), units: [...rig(4).units, { camera: 'sony', operator: 'Fifth' }] };
    expect(buildProjectConfig(over).cameras).toHaveLength(MAX_CAMERAS);
  });
});

describe('buildProjectConfig — sound', () => {
  it('is absent when the answer was off, at one and at four cameras', () => {
    expect(buildProjectConfig(rig(1)).sound).toBeUndefined();
    expect(hasSound(buildProjectConfig(rig(4)))).toBe(false);
  });

  it('is present on a single-cam project — sound is not a camera count', () => {
    const config = buildProjectConfig(draft({ sound: newSoundDraft() }));
    expect(hasSound(config)).toBe(true);
    expect(isMultiCam(config)).toBe(false);
    expect(config.sound).toMatchObject({ filePrefix: 'SND_', nextFileNumber: 1, filePadding: 4, fileExt: '.WAV' });
  });

  it('is never a member of the cameras array', () => {
    const config = buildProjectConfig({ ...rig(4), sound: newSoundDraft() });
    expect(config.cameras).toHaveLength(4);
    expect(config.cameras!.some((c) => (c.letter as string) === 'S')).toBe(false);
  });

  it('keeps the recorder and the mixer when they were typed, trimmed', () => {
    const config = buildProjectConfig({
      ...rig(2),
      sound: { recorder: ' MixPre-6 ', operator: ' Priya ', filePrefix: 'ZOOM_' },
    });
    expect(config.sound).toMatchObject({ recorder: 'MixPre-6', operator: 'Priya', filePrefix: 'ZOOM_' });
  });

  it('omits recorder and mixer rather than writing empty strings', () => {
    const config = buildProjectConfig({ ...rig(1), sound: newSoundDraft() });
    expect(config.sound).not.toHaveProperty('recorder');
    expect(config.sound).not.toHaveProperty('operator');
  });

  it('falls back to SND_ when the prefix was cleared', () => {
    const config = buildProjectConfig({ ...rig(1), sound: { ...newSoundDraft(), filePrefix: '  ' } });
    expect(config.sound!.filePrefix).toBe('SND_');
  });
});
