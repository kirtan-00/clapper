// Timecode math for Clapper exports. Pure functions, no DOM.
//
// Drop-frame (29.97 / 59.94): drop 2 frame numbers (4 for 59.94) at the start
// of every minute except each 10th minute. Formatted with ';' as the last
// separator; parsing accepts both ':' and ';'.
// 23.976 counts frames at a timebase of 24, non-drop.

import type { Fps, TimecodeUtil } from '../types';

/** Integer timebase used for HH:MM:SS:FF math. */
function timebaseOf(fps: Fps): number {
  return Math.round(fps);
}

function isDropFrame(fps: Fps): boolean {
  return fps === 29.97 || fps === 59.94;
}

/** Frames dropped per drop-minute (2 at 29.97, 4 at 59.94). */
function dropCountOf(fps: Fps): number {
  return timebaseOf(fps) === 60 ? 4 : 2;
}

/** Exact frame rate as frames per second (rational for NTSC-family rates). */
function exactRate(fps: Fps): number {
  if (fps === 23.976) return 24000 / 1001;
  if (fps === 29.97) return 30000 / 1001;
  if (fps === 59.94) return 60000 / 1001;
  return fps;
}

function msToFrames(ms: number, fps: Fps): number {
  return Math.round((ms * exactRate(fps)) / 1000);
}

function pad2(n: number): string {
  return String(n).padStart(2, '0');
}

const TC_RE = /^(\d{1,2}):(\d{2}):(\d{2})[:;](\d{2})$/;

function framesToTimecodeImpl(frames: number, fps: Fps): string {
  const timebase = timebaseOf(fps);
  let f = Math.max(0, Math.round(frames));

  if (isDropFrame(fps)) {
    // Compensate: convert a real frame count into drop-frame numbering.
    const drop = dropCountOf(fps);
    const framesPerMinute = timebase * 60 - drop; // e.g. 1798 at 29.97
    const framesPer10Min = framesPerMinute * 10 + drop; // e.g. 17982
    const tens = Math.floor(f / framesPer10Min);
    const rem = f % framesPer10Min;
    if (rem > drop) {
      f += drop * 9 * tens + drop * Math.floor((rem - drop) / framesPerMinute);
    } else {
      f += drop * 9 * tens;
    }
  }

  const ff = f % timebase;
  const totalSeconds = Math.floor(f / timebase);
  const ss = totalSeconds % 60;
  const mm = Math.floor(totalSeconds / 60) % 60;
  const hh = Math.floor(totalSeconds / 3600) % 24; // wrap at 24h like a camera

  const last = isDropFrame(fps) ? ';' : ':';
  return `${pad2(hh)}:${pad2(mm)}:${pad2(ss)}${last}${pad2(ff)}`;
}

function timecodeToFramesImpl(tc: string, fps: Fps): number {
  const m = TC_RE.exec(tc.trim());
  if (!m) throw new Error(`Malformed timecode: "${tc}"`);
  const hh = parseInt(m[1], 10);
  const mm = parseInt(m[2], 10);
  const ss = parseInt(m[3], 10);
  const ff = parseInt(m[4], 10);
  const timebase = timebaseOf(fps);
  if (mm > 59 || ss > 59) throw new Error(`Malformed timecode: "${tc}"`);
  if (ff >= timebase) {
    throw new Error(`Malformed timecode: "${tc}" (frames must be < ${timebase} at ${fps} fps)`);
  }

  let frames = ((hh * 60 + mm) * 60 + ss) * timebase + ff;
  if (isDropFrame(fps)) {
    const drop = dropCountOf(fps);
    const totalMinutes = hh * 60 + mm;
    frames -= drop * (totalMinutes - Math.floor(totalMinutes / 10));
  }
  return frames;
}

export const tc: TimecodeUtil = {
  msToClock(ms: number): string {
    const totalSeconds = Math.max(0, Math.floor(ms / 1000));
    const s = totalSeconds % 60;
    if (totalSeconds < 3600) {
      const min = Math.floor(totalSeconds / 60);
      return `${min}:${pad2(s)}`;
    }
    const h = Math.floor(totalSeconds / 3600);
    const min = Math.floor(totalSeconds / 60) % 60;
    return `${h}:${pad2(min)}:${pad2(s)}`;
  },

  msToTimecode(ms: number, fps: Fps): string {
    return framesToTimecodeImpl(msToFrames(ms, fps), fps);
  },

  timecodeToFrames(tcStr: string, fps: Fps): number {
    return timecodeToFramesImpl(tcStr, fps);
  },

  framesToTimecode(frames: number, fps: Fps): string {
    return framesToTimecodeImpl(frames, fps);
  },

  addMsToTimecode(tcStr: string, ms: number, fps: Fps): string {
    const frames = timecodeToFramesImpl(tcStr, fps) + msToFrames(ms, fps);
    return framesToTimecodeImpl(Math.max(0, frames), fps);
  },

  isValidTimecode(tcStr: string, fps?: Fps): boolean {
    const m = TC_RE.exec(tcStr.trim());
    if (!m) return false;
    const mm = parseInt(m[2], 10);
    const ss = parseInt(m[3], 10);
    const ff = parseInt(m[4], 10);
    // With an fps, FF must be below that timebase (round(fps)). Without one,
    // fall back to the loosest bound the format allows (highest timebase, 60).
    const ffBound = fps === undefined ? 60 : timebaseOf(fps);
    return mm < 60 && ss < 60 && ff < ffBound;
  },
};
