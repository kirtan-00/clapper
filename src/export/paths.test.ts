import { describe, it, expect } from 'vitest';
import { mediaPath } from './paths';

describe('mediaPath', () => {
  it('leaves an ordinary camera file exactly as the card wrote it', () => {
    // The overwhelmingly common case. If this ever changes shape, every
    // existing exported XML stops matching the footage it was cut against.
    expect(mediaPath(undefined, 'crav_0273.MP4')).toBe('crav_0273.MP4');
    expect(mediaPath('A_20260808', 'C0001.MP4')).toBe('A_20260808/C0001.MP4');
  });

  it('encodes the characters that silently truncate a path', () => {
    // "?" starts a query string and "#" starts a fragment, so an un-encoded
    // one throws away everything after it and the editor relinks to nothing.
    expect(mediaPath('HU kon Chu? 8-08', 'crav_0273.MP4')).toBe(
      'HU%20kon%20Chu%3F%208-08/crav_0273.MP4',
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
    expect(mediaPath('day 2/card 1/M4ROOT/CLIP', 'crav_0273.MP4')).toBe(
      'day%202/card%201/M4ROOT/CLIP/crav_0273.MP4',
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
