// The seven card layouts this has to survive are the whole point of the
// module, so they are the first thing tested — one describe block, one real
// tree per manufacturer, no vendor code anywhere in the implementation.

import { describe, expect, it } from 'vitest';
import { baseKey, buildMediaIndex, countMatched, isMediaFile, matchClip } from './medialink';

/** Every fixture below is picked as a folder called "FOOTAGE", so paths come
 *  in the way `webkitRelativePath` spells them: root name first. */
function indexOf(paths: string[], rootName = 'FOOTAGE') {
  return buildMediaIndex(
    paths.map((p) => `${rootName}/${p}`),
    rootName,
    0,
  );
}

describe('medialink — the card layouts', () => {
  const tree = [
    'CARD_A/PRIVATE/M4ROOT/CLIP/C0012.MP4', // Sony
    'CARD_B/PRIVATE/AVCHD/BDMV/STREAM/00000.MTS', // Panasonic
    'CARD_C/DCIM/100CANON/MVI_0012.MOV', // Canon
    'CARD_D/A001_C012_0808XX.RDC/A001_C012_0808XX_001.R3D', // RED
    'CARD_E/A001R2EC/A001C012_260808_R2EC.mxf', // ARRI
    'CARD_F/A001_08081200_C012.braw', // Blackmagic, flat
    'CARD_G/DCIM/100GOPRO/GX010012.MP4', // GoPro
  ];

  it('finds a clip at any depth, from a flat card to six folders down', () => {
    const idx = indexOf(tree);
    expect(idx.fileCount).toBe(7);

    // Names the operator logs verbatim (the `exact: true` presets).
    expect(matchClip(idx, 'C0012').path).toBe('CARD_A/PRIVATE/M4ROOT/CLIP/C0012.MP4');
    expect(matchClip(idx, '00000').path).toBe('CARD_B/PRIVATE/AVCHD/BDMV/STREAM/00000.MTS');
    expect(matchClip(idx, 'MVI_0012').path).toBe('CARD_C/DCIM/100CANON/MVI_0012.MOV');
    expect(matchClip(idx, 'GX010012').path).toBe('CARD_G/DCIM/100GOPRO/GX010012.MP4');
  });

  it("resolves the presets whose names carry Clapper's own '*' wildcard", () => {
    // ui/cameras.ts writes these names with a '*' standing for the part the
    // phone cannot know — a record stamp, a date, a camera ID. Matching it as
    // a glob is what the preset's own note ("match files by the C-number")
    // asks for, and it is why nothing here knows what a RED is.
    const idx = indexOf(tree);
    expect(matchClip(idx, 'A001_C012_*').path).toBe(
      'CARD_D/A001_C012_0808XX.RDC/A001_C012_0808XX_001.R3D',
    );
    expect(matchClip(idx, 'A001C012_*').path).toBe('CARD_E/A001R2EC/A001C012_260808_R2EC.mxf');
    expect(matchClip(idx, 'A001_*_C012').path).toBe('CARD_F/A001_08081200_C012.braw');
  });

  it('reports a clip that is simply not on the disk, rather than a path', () => {
    const idx = indexOf(tree);
    const m = matchClip(idx, 'C0099');
    expect(m.status).toBe('missing');
    expect(m.path).toBe('');
    expect(m.candidates).toEqual([]);
  });
});

describe('medialink — two files, one name', () => {
  it('refuses to choose between two cards carrying the same clip', () => {
    // The normal state of a two-camera day, not an edge case: both bodies
    // write C0012.MP4. Picking one is a coin flip that looks like a result.
    const idx = indexOf([
      'CARD_A/PRIVATE/M4ROOT/CLIP/C0012.MP4',
      'CARD_B/PRIVATE/M4ROOT/CLIP/C0012.MP4',
    ]);
    const m = matchClip(idx, 'C0012');
    expect(m.status).toBe('ambiguous');
    expect(m.path).toBe('');
    expect(m.candidates).toEqual([
      'CARD_A/PRIVATE/M4ROOT/CLIP/C0012.MP4',
      'CARD_B/PRIVATE/M4ROOT/CLIP/C0012.MP4',
    ]);
  });

  it('reports every part of a spanned RED clip instead of guessing the first', () => {
    // A long RED take is written as _001, _002, _003 inside one .RDC folder.
    // All three are the take; none of them alone is "the file", so the honest
    // answer is all three and no path.
    const idx = indexOf([
      'A001_C012_0808XX.RDC/A001_C012_0808XX_001.R3D',
      'A001_C012_0808XX.RDC/A001_C012_0808XX_002.R3D',
    ]);
    const m = matchClip(idx, 'A001_C012_*');
    expect(m.status).toBe('ambiguous');
    expect(m.candidates).toHaveLength(2);
  });

  it('reports the same clip number copied from two different shoot days', () => {
    // Every camera restarts at C0001 every morning. This index has no idea
    // what a shoot day is, so day 1 and day 5 in one folder is ambiguous —
    // truthfully so.
    const idx = indexOf(['day 1/CLIP/C0001.MP4', 'day 5/CLIP/C0001.MP4']);
    expect(matchClip(idx, 'C0001').status).toBe('ambiguous');
  });
});

describe('medialink — normalisation', () => {
  it('matches across case, because the card and the copy disagree', () => {
    // A card formatted in-camera writes C0012.MP4; the same card round-tripped
    // through a Windows share comes back c0012.mp4.
    const idx = indexOf(['CARD/c0012.mp4']);
    expect(matchClip(idx, 'C0012').path).toBe('CARD/c0012.mp4');
    expect(matchClip(idx, 'c0012').path).toBe('CARD/c0012.mp4');
  });

  it('matches a logged name with no extension against the file that has one', () => {
    // Take.clipName is "C0012"; the file is "C0012.MP4". That gap is the
    // entire reason the key is the basename.
    expect(baseKey('C0012.MP4')).toBe('c0012');
    expect(baseKey('C0012')).toBe('c0012');
  });

  it('only strips an extension it recognises', () => {
    // A real clip name can contain a dot. Chopping at the last one would
    // silently shorten it to "a001_c012_08".
    expect(baseKey('A001_C012_08.08.MP4')).toBe('a001_c012_08.08');
    expect(baseKey('A001_C012_08.08')).toBe('a001_c012_08.08');
  });

  it('keeps footage and drops the sidecars that share its name', () => {
    // A card carries C0012.MP4 next to C0012.XML and C0012.THM. Indexing
    // those would make every single take ambiguous against itself.
    expect(isMediaFile('C0012.MP4')).toBe(true);
    expect(isMediaFile('C0012.mp4')).toBe(true);
    expect(isMediaFile('SND_0001.WAV')).toBe(true);
    expect(isMediaFile('C0012.XML')).toBe(false);
    expect(isMediaFile('C0012.THM')).toBe(false);
    expect(isMediaFile('.DS_Store')).toBe(false);

    const idx = indexOf(['CLIP/C0012.MP4', 'CLIP/C0012.XML', 'CLIP/C0012.THM']);
    expect(idx.fileCount).toBe(1);
    expect(matchClip(idx, 'C0012').status).toBe('matched');
  });

  it('survives spaces and ampersands in a folder name, unencoded', () => {
    // A CSV cell is pasted into Finder or handed to ffmpeg, so it must be the
    // path as the disk spells it — the percent-encoding mediaPath does for
    // <pathurl> would break exactly that. See joinPath in paths.ts.
    const idx = indexOf(['Wrap Reel? day 1/R&D takes/C0012.MP4']);
    expect(matchClip(idx, 'C0012', '/Volumes/My Book').path).toBe(
      '/Volumes/My Book/Wrap Reel? day 1/R&D takes/C0012.MP4',
    );
  });

  it("treats a clip name's regex characters as literal text", () => {
    const idx = indexOf(['CLIP/A(1)+B.MOV']);
    expect(matchClip(idx, 'A(1)+B').status).toBe('matched');
    // '.' is a literal, so it must not stand in for the underscore.
    const dotted = indexOf(['CLIP/A_B.MOV']);
    expect(matchClip(dotted, 'A.B').status).toBe('missing');
  });
});

describe('medialink — the picked folder segment', () => {
  it("drops webkitRelativePath's leading root segment so the root is not doubled", () => {
    // webkitRelativePath includes the picked folder's own name; a
    // showDirectoryPicker walk does not. Left in, mediaRoot + relative path
    // produces "/Volumes/SSD/fixture/fixture/…" on one browser and not the
    // other, and the feature is dead on first use.
    const idx = buildMediaIndex(['fixture/CARD_A/C0012.MP4'], 'fixture', 0);
    expect(matchClip(idx, 'C0012', '/Volumes/SSD/fixture').path).toBe(
      '/Volumes/SSD/fixture/CARD_A/C0012.MP4',
    );
  });

  it('leaves paths alone when they do not all start with the picked folder', () => {
    // The showDirectoryPicker shape. Stripping here would eat a real folder.
    const idx = buildMediaIndex(['CARD_A/C0012.MP4', 'CARD_B/C0013.MP4'], 'fixture', 0);
    expect(matchClip(idx, 'C0012').path).toBe('CARD_A/C0012.MP4');
  });

  it('does not eat a subfolder that happens to share the picked folder name', () => {
    const idx = buildMediaIndex(['CLIP/CLIP/C0012.MP4'], 'CLIP', 0);
    expect(matchClip(idx, 'C0012').path).toBe('CLIP/C0012.MP4');
  });
});

describe('medialink — nothing to go on', () => {
  it('says unindexed rather than missing when no folder has been picked', () => {
    // Three different situations an editor has to act on differently: nobody
    // picked a folder, the file is not on the disk, two files claim the name.
    // An empty cell alone cannot tell them apart.
    const m = matchClip(undefined, 'C0012');
    expect(m.status).toBe('unindexed');
    expect(m.path).toBe('');
  });

  it('says unindexed for a take with no clip name at all', () => {
    const idx = indexOf(['CLIP/C0012.MP4']);
    expect(matchClip(idx, '').status).toBe('unindexed');
    expect(matchClip(idx, undefined).status).toBe('unindexed');
  });

  it('writes the relative path when the editor has not confirmed a root yet', () => {
    // We received this path from the walk, so it is not invented — and it
    // still tells the editor which card the clip is on. What we never do is
    // synthesise the absolute half.
    const idx = indexOf(['CARD_A/PRIVATE/M4ROOT/CLIP/C0012.MP4']);
    expect(matchClip(idx, 'C0012').path).toBe('CARD_A/PRIVATE/M4ROOT/CLIP/C0012.MP4');
  });
});

describe('medialink — countMatched', () => {
  it('counts only the takes that resolved to exactly one file', () => {
    const idx = indexOf(['A/C0001.MP4', 'B/C0002.MP4', 'C/C0003.MP4', 'D/C0003.MP4']);
    // C0003 is on two cards, C0009 is on none.
    expect(countMatched(idx, ['C0001', 'C0002', 'C0003', 'C0009'])).toBe(2);
  });
});
