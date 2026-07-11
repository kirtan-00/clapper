// Camera filename presets. Each real-world camera writes clip files as a static
// prefix + one incrementing counter + an optional static suffix. A '*' inside a
// prefix/suffix is a literal wildcard character standing for parts we cannot
// predict ahead of time (record-time stamps, dates, random chars, camera IDs).
// Only the incrementing counter is ours to drive; the '*' just travels through
// to the editor untouched.

export interface CameraPreset {
  id: string;
  label: string;
  prefix: string;
  digits: number;
  suffix: string;
  exact: boolean; // true = the name matches the card exactly; false = approximate
  note?: string;
}

export const CAMERA_PRESETS: readonly CameraPreset[] = [
  { id: 'sony', label: 'Sony A7 / FX (C0001)', prefix: 'C', digits: 4, suffix: '', exact: true },
  {
    id: 'canonPhoto',
    label: 'Canon R5/R6 (MVI_0001)',
    prefix: 'MVI_',
    digits: 4,
    suffix: '',
    exact: false,
    note: 'Counter is shared with stills, so numbers can skip.',
  },
  {
    id: 'canonCine',
    label: 'Canon Cinema / R5C (A001C001)',
    prefix: 'A001C',
    digits: 3,
    suffix: '',
    exact: true,
    note: 'The reel (A001) lives in the prefix. New card = bump the reel to A002C, A003C, and so on.',
  },
  {
    id: 'bmpcc',
    label: 'Blackmagic Pocket (A001_*_C001)',
    prefix: 'A001_*_C',
    digits: 3,
    suffix: '',
    exact: false,
    note: 'The * is a record-time stamp the camera adds and is unknowable in advance.',
  },
  {
    id: 'red',
    label: 'RED (A001_C001_*)',
    prefix: 'A001_C',
    digits: 3,
    suffix: '_*',
    exact: false,
    note: 'The * is a date plus random characters. Match files by the C-number.',
  },
  {
    id: 'arri',
    label: 'ARRI (A001C001_*)',
    prefix: 'A001C',
    digits: 3,
    suffix: '_*',
    exact: false,
    note: 'The * is a date plus camera ID. Match files by the C-number.',
  },
  {
    id: 'djiNew',
    label: 'DJI Mini/Mavic/Pocket (DJI_*_0001_D)',
    prefix: 'DJI_*_',
    digits: 4,
    suffix: '_D',
    exact: false,
    note: 'The * is a timestamp. Match files by the incrementing number.',
  },
  {
    id: 'djiClassic',
    label: 'DJI classic (DJI_0001)',
    prefix: 'DJI_',
    digits: 4,
    suffix: '',
    exact: true,
  },
  {
    id: 'gopro',
    label: 'GoPro (GX010001)',
    prefix: 'GX01',
    digits: 4,
    suffix: '',
    exact: true,
    note: 'Chapters split one long shot into GX02, GX03 files that share the same number.',
  },
  {
    id: 'iphone',
    label: 'iPhone (IMG_0001)',
    prefix: 'IMG_',
    digits: 4,
    suffix: '',
    exact: false,
    note: 'Counter is shared with photos, so numbers can skip.',
  },
  { id: 'lumix', label: 'Panasonic Lumix (P1000001)', prefix: 'P100', digits: 4, suffix: '', exact: true },
  { id: 'custom', label: 'Custom', prefix: 'C', digits: 4, suffix: '', exact: true },
];

export function findPreset(id: string | undefined): CameraPreset | undefined {
  return CAMERA_PRESETS.find((p) => p.id === id);
}

/** prefix + zero-padded number + suffix, e.g. renderClip("A001_C", 1, 3, "_*") -> "A001_C001_*". */
export function renderClip(prefix: string, n: number, digits: number, suffix: string): string {
  const pad = Math.min(8, Math.max(1, digits || 1));
  return prefix + String(Math.max(0, n)).padStart(pad, '0') + suffix;
}
