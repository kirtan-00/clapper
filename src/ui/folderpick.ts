// The two ways a browser will let you hand over a folder, and the honest
// answer when it will let you do neither.
//
// NEITHER RETURNS AN ABSOLUTE PATH, and no amount of trying changes that:
//
//   <input type="file" webkitdirectory>  — every File carries
//     `webkitRelativePath`, a path relative to the picked folder and nothing
//     above it ("FOOTAGE/CARD_A/M4ROOT/CLIP/C0012.MP4"). Widely supported on
//     desktop; on iOS it arrived in Safari 18.4 (March 2025) and works in
//     Android Chrome.
//
//   showDirectoryPicker()  — real FileSystemDirectoryHandles, which is nicer
//     to walk and still carries no absolute path. Chromium desktop only;
//     Safari and Firefox have not shipped it.
//
// The absolute half comes from the person, once, in Project.mediaRoot. See
// the note atop export/medialink.ts.

/** Minimal shape of the File System Access API bits used here — the DOM lib
 *  this project builds against does not declare them. */
interface DirHandle {
  name: string;
  kind: 'directory' | 'file';
  values(): AsyncIterableIterator<DirHandle>;
}

type DirPickerWindow = Window & {
  showDirectoryPicker?: (opts?: { id?: string; mode?: 'read' | 'readwrite' }) => Promise<DirHandle>;
};

export interface PickedFolder {
  /** The picked folder's own name, e.g. "FOOTAGE". Shown back to the user so
   *  a wrong pick is obvious before they get to the export. */
  rootName: string;
  /** Every path found underneath, including non-media — the extension filter
   *  belongs to buildMediaIndex, so the picker stays a plain walk. */
  relativePaths: string[];
}

export type PickerKind =
  | 'handle' // showDirectoryPicker: a real directory handle to walk
  | 'input' // <input webkitdirectory>: a flat FileList carrying relative paths
  | 'none'; // neither — say so rather than rendering a button that does nothing

export function pickerKind(): PickerKind {
  if (typeof window === 'undefined') return 'none';
  if (typeof (window as DirPickerWindow).showDirectoryPicker === 'function') return 'handle';
  if (typeof HTMLInputElement !== 'undefined' && 'webkitdirectory' in HTMLInputElement.prototype) {
    return 'input';
  }
  return 'none';
}

/**
 * Walk a directory handle depth-first. Paths come back WITHOUT the picked
 * folder's own name, which is the convention buildMediaIndex normalises
 * `webkitRelativePath` to as well (it includes it; this does not).
 *
 * A folder we cannot read — a permission the user granted for the parent but
 * not a child, an OS-level protected directory — is skipped rather than
 * failing the whole pick. Half a card indexed still matches half the takes,
 * and the ones it misses come back as `missing`, which is true.
 */
async function walk(dir: DirHandle, prefix: string, out: string[]): Promise<void> {
  for await (const entry of dir.values()) {
    const path = prefix ? `${prefix}/${entry.name}` : entry.name;
    if (entry.kind === 'directory') {
      try {
        await walk(entry, path, out);
      } catch {
        /* unreadable subtree — skip it, keep the rest */
      }
    } else {
      out.push(path);
    }
  }
}

/**
 * Open the File System Access picker. Resolves `null` when the user cancels —
 * cancellation throws an AbortError, which is a normal outcome, not an error
 * worth showing anyone.
 */
export async function pickFolderViaHandle(): Promise<PickedFolder | null> {
  const show = (window as DirPickerWindow).showDirectoryPicker;
  if (!show) return null;
  let dir: DirHandle;
  try {
    // `id` makes Chromium reopen in the last-used location, which on a DIT
    // station is the same media drive every single time.
    dir = await show({ id: 'clapper-footage', mode: 'read' });
  } catch {
    return null;
  }
  const relativePaths: string[] = [];
  await walk(dir, '', relativePaths);
  return { rootName: dir.name, relativePaths };
}

/**
 * Turn what `<input webkitdirectory>` handed back into the same shape.
 *
 * `webkitRelativePath` is empty on a browser that ignored the attribute and
 * ran a plain multi-file select instead — in which case the bare file name is
 * the whole path we have, and matching still works, just without knowing
 * which card each clip came off. The root name is then unknowable, so the
 * caller's label is used.
 */
export function pickedFromFiles(files: readonly File[], fallbackName: string): PickedFolder {
  const relativePaths = files.map((f) => f.webkitRelativePath || f.name);
  const withFolder = relativePaths.find((p) => p.includes('/'));
  const rootName = withFolder ? withFolder.slice(0, withFolder.indexOf('/')) : fallbackName;
  return { rootName, relativePaths };
}
