// normaliseTag is the only door into a tag, so it is the only thing that has to
// be right for the exporters downstream. A tag reaches a CSV cell and an FCPXML
// attribute without further escaping, which is why the character strip exists —
// these tests are about that contract, not about tidy formatting.

import { describe, it, expect } from 'vitest';
import {
  normaliseTag,
  normaliseTags,
  MAX_TAGS,
  MAX_TAG_LEN,
  BUILTIN_TAGS,
} from './tagdefaults';

describe('normaliseTag', () => {
  it('upper-cases, because chips are drawn in caps either way', () => {
    expect(normaliseTag('ad break')).toBe('AD BREAK');
  });

  it('trims, so a fat-fingered space is not a different tag', () => {
    expect(normaliseTag('  GOLD  ')).toBe('GOLD');
  });

  it('strips the characters that would break an export', () => {
    // A quote ends a CSV field early; & and <> break the FCPXML the editor
    // opens. Neither is escaped downstream, so they cannot get in here.
    expect(normaliseTag('a"b,c;d')).toBe('ABCD');
    expect(normaliseTag('<tag>&')).toBe('TAG');
    expect(normaliseTag('a\nb\tc')).toBe('ABC');
  });

  it('clamps length, then re-trims so a cut mid-space leaves no tail', () => {
    const long = normaliseTag('THIS IS FAR TOO LONG FOR A CHIP');
    expect(long.length).toBeLessThanOrEqual(MAX_TAG_LEN);
    expect(long).toBe(long.trim());
  });

  it('returns empty for input that was only junk', () => {
    expect(normaliseTag('   ')).toBe('');
    expect(normaliseTag('",;')).toBe('');
  });
});

describe('normaliseTags', () => {
  it('drops empties and duplicates, keeping first-seen order', () => {
    expect(normaliseTags(['wide', '  ', 'WIDE', 'cu', '","'])).toEqual(['WIDE', 'CU']);
  });

  it('dedupes AFTER normalising, not before', () => {
    // 'gold' and 'GOLD ' are the same tag; a naive Set on the raw input is not.
    expect(normaliseTags(['gold', 'GOLD ', ' Gold'])).toEqual(['GOLD']);
  });

  it('caps the count', () => {
    const many = Array.from({ length: MAX_TAGS + 8 }, (_, i) => `T${i}`);
    expect(normaliseTags(many)).toHaveLength(MAX_TAGS);
  });

  it('leaves a deliberately empty set empty', () => {
    // Clearing the keypad is a legitimate choice, not an error to correct.
    expect(normaliseTags([])).toEqual([]);
  });
});

describe('the shipped sets', () => {
  it('survive their own normaliser unchanged', () => {
    // If a built-in ever needed cleaning, the Settings row would show "Default"
    // while storing something else — isBuiltinTags compares by value.
    for (const mode of ['video', 'podcast'] as const) {
      expect(normaliseTags(BUILTIN_TAGS[mode])).toEqual([...BUILTIN_TAGS[mode]]);
    }
  });

  it('both carry GOLD, which has its own brass button on the roll screen', () => {
    expect(BUILTIN_TAGS.video).toContain('GOLD');
    expect(BUILTIN_TAGS.podcast).toContain('GOLD');
  });
});
