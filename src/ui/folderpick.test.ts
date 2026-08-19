import { describe, expect, it } from 'vitest';
import { pickedFromFiles } from './folderpick';

/** A File as far as this module cares: a name, and the relative path the
 *  browser attached to it. */
function file(name: string, webkitRelativePath = ''): File {
  return { name, webkitRelativePath } as File;
}

describe('pickedFromFiles', () => {
  it('reads the picked folder’s name off the paths, not off the OS', () => {
    // webkitRelativePath's first segment IS the picked folder — the only
    // place its name is available at all, since the input element never
    // reports it separately.
    const picked = pickedFromFiles(
      [
        file('C0012.MP4', 'FOOTAGE/CARD_A/PRIVATE/M4ROOT/CLIP/C0012.MP4'),
        file('C0013.MP4', 'FOOTAGE/CARD_A/PRIVATE/M4ROOT/CLIP/C0013.MP4'),
      ],
      'Footage',
    );
    expect(picked.rootName).toBe('FOOTAGE');
    expect(picked.relativePaths).toEqual([
      'FOOTAGE/CARD_A/PRIVATE/M4ROOT/CLIP/C0012.MP4',
      'FOOTAGE/CARD_A/PRIVATE/M4ROOT/CLIP/C0013.MP4',
    ]);
  });

  it('falls back to bare file names on a browser that ignored the attribute', () => {
    // Older iOS Safari ran a plain multi-file select instead of a folder
    // pick, leaving webkitRelativePath empty. Matching still works off the
    // basename; we just cannot say which card a clip came off, so we do not
    // pretend to.
    const picked = pickedFromFiles([file('C0012.MP4'), file('C0013.MP4')], 'Footage');
    expect(picked.rootName).toBe('Footage');
    expect(picked.relativePaths).toEqual(['C0012.MP4', 'C0013.MP4']);
  });

  it('finds the root name even when the first file sits loose at the top', () => {
    const picked = pickedFromFiles(
      [file('notes.txt', ''), file('C0012.MP4', 'FOOTAGE/CARD_A/C0012.MP4')],
      'Footage',
    );
    expect(picked.rootName).toBe('FOOTAGE');
  });
});
