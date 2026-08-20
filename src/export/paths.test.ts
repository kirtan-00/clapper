import { describe, it, expect } from 'vitest';
import { joinPath, mediaPath } from './paths';

describe('mediaPath', () => {
  it('leaves an ordinary camera file exactly as the card wrote it', () => {
    // The overwhelmingly common case. If this ever changes shape, every
    // existing exported XML stops matching the footage it was cut against.
    expect(mediaPath(undefined, 'reel_0273.MP4')).toBe('reel_0273.MP4');
    expect(mediaPath('A_20260808', 'C0001.MP4')).toBe('A_20260808/C0001.MP4');
  });

  it('encodes the characters that silently truncate a path', () => {
    // "?" starts a query string and "#" starts a fragment, so an un-encoded
    // one throws away everything after it and the editor relinks to nothing.
    expect(mediaPath('Wrap Reel? 8-08', 'reel_0273.MP4')).toBe(
      'Wrap%20Reel%3F%208-08/reel_0273.MP4',
    );
    expect(mediaPath(undefined, 'take #4.MOV')).toBe('take%20%234.MOV');
  });

  it('encodes an ampersand once, not as XML then again as a URL', () => {
    // The bug this module exists to prevent: the callers used to hand over a
    // string that had already been through escapeXml, so "&" arrived as
    // "&amp;" and was encoded a second time.
    expect(mediaPath(undefined, 'A&B.MP4')).toBe('A%26B.MP4');
  });

  it('keeps folder separators and drops empty segments', () => {
    expect(mediaPath('day 2/card 1/M4ROOT/CLIP', 'reel_0273.MP4')).toBe(
      'day%202/card%201/M4ROOT/CLIP/reel_0273.MP4',
    );
    // A missing, blank or slash-padded folder must not leave a "//" behind,
    // which some importers read as a host name rather than a directory.
    expect(mediaPath('', 'C0001.MP4')).toBe('C0001.MP4');
    expect(mediaPath('   ', 'C0001.MP4')).toBe('C0001.MP4');
    expect(mediaPath('/day 1/', 'C0001.MP4')).toBe('day%201/C0001.MP4');
  });

  it('never emits a leading slash, because the caller owns the scheme', () => {
    // xmeml wants file://localhost/ and FCPXML wants file:///. Emitting our
    // own slash here would double one of them.
    expect(mediaPath('A', 'C0001.MP4').startsWith('/')).toBe(false);
  });
});

describe('joinPath', () => {
  it('gives a spreadsheet the path the disk actually spells', () => {
    // The deliberate opposite of mediaPath. A CSV cell gets pasted into
    // Finder's Go-to-Folder or handed to ffmpeg, and "/Volumes/My%20Book"
    // resolves to nothing in both — so this one does not encode at all.
    expect(joinPath('/Volumes/My Book', 'CARD_A/C0001.MP4')).toBe(
      '/Volumes/My Book/CARD_A/C0001.MP4',
    );
    expect(joinPath('/Volumes/R&D', 'a b.MP4')).toBe('/Volumes/R&D/a b.MP4');
  });

  it('returns the relative path untouched when no root is confirmed', () => {
    // A browser never hands out an absolute path, so with nothing typed in we
    // write the half we genuinely received rather than inventing the other.
    expect(joinPath(undefined, 'CARD_A/C0001.MP4')).toBe('CARD_A/C0001.MP4');
    expect(joinPath('   ', 'CARD_A/C0001.MP4')).toBe('CARD_A/C0001.MP4');
  });

  it('never doubles the separator between the two halves', () => {
    expect(joinPath('/Volumes/SSD/', 'C0001.MP4')).toBe('/Volumes/SSD/C0001.MP4');
    expect(joinPath('/Volumes/SSD', '/C0001.MP4')).toBe('/Volumes/SSD/C0001.MP4');
  });

  it('stays in one separator when the DIT is on Windows', () => {
    expect(joinPath('D:\\FOOTAGE', 'A/C1.MP4')).toBe('D:\\FOOTAGE\\A\\C1.MP4');
  });
});
