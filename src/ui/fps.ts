// The frame rates, and what a camera menu calls each one.
//
// Shared because two flows now ask this question the same way (the shotlist
// import and the New project flow) and a second copy of the list is how the
// two end up offering different rates. The NOTE is the point: nobody on set
// says "29.97" without meaning NTSC, and a bare column of decimals is the
// dropdown these stages replace.

import type { Fps } from '../types';

export const FPS_OPTIONS: readonly { fps: Fps; note: string }[] = [
  { fps: 23.976, note: 'NTSC film' },
  { fps: 24, note: 'Film' },
  { fps: 25, note: 'PAL' },
  { fps: 29.97, note: 'NTSC video' },
  { fps: 30, note: 'Video' },
  { fps: 50, note: 'PAL, high' },
  { fps: 59.94, note: 'NTSC, high' },
  { fps: 60, note: 'High frame rate' },
];

/** The one line said about frame rate, said once. */
export const FPS_WARNING =
  'This lands in every timecode you export. It is the one value that hurts to change later.';
