// Flat CSV export. One row per moment, plus one "take" row per take so takes
// with zero moments still appear. RFC 4180 quoting, CRLF line endings.

import type { Moment, ProjectBundle, Take } from '../types';
import { tc, wallClockTC } from './timecode';
import { buildShotIndex, compareTakesInStoryOrder, shotCodeOf } from './order';

// `shot` is the SHOT CODE off the shotlist ("5.31"), empty for a take logged
// straight against a scene. `take` is the take number - it is the column that
// used to be called `shot`, which was simply the wrong word: Scene > Shot >
// Take. Deliberate breaking header change; the two exports disagreed before.
const HEADER = [
  'scene',
  'shot',
  'take',
  'clip',
  'camera',
  'operator',
  'sound_file',
  'status',
  'kind',
  'tag',
  'label',
  'in_clock',
  'out_clock',
  'in_tc',
  'out_tc',
  'camera_in_tc',
  'camera_out_tc',
  'wall_in',
  'wall_out',
  'duration_ms',
  'note',
];

function csvField(value: string): string {
  if (/[",\r\n]/.test(value)) {
    return `"${value.replace(/"/g, '""')}"`;
  }
  return value;
}

function row(fields: string[]): string {
  return fields.map(csvField).join(',');
}

export function toCsv(bundle: ProjectBundle): Blob {
  const { project, slates, takes, moments } = bundle;
  const fps = project.fps;

  const operatorByUnit = new Map<string, string>(
    (project.cameras ?? []).map((u) => [u.letter, u.operator ?? '']),
  );
  const slateName = new Map(slates.map((s) => [s.id, s.name]));
  const momentsByTake = new Map<string, Moment[]>();
  for (const m of moments) {
    const list = momentsByTake.get(m.takeId) ?? [];
    list.push(m);
    momentsByTake.set(m.takeId, list);
  }

  const orderedSlateIds = [...slates].sort((a, b) => a.order - b.order).map((s) => s.id);
  // Buckets stay keyed by SLATE id, never by shot id: the orphan fallback below
  // depends on that, and a take whose shotId resolves to nothing must still be
  // written (it just gets an empty `shot` cell) rather than disappear.
  const takesBySlate = new Map<string, Take[]>();
  for (const t of takes) {
    const list = takesBySlate.get(t.slateId) ?? [];
    list.push(t);
    takesBySlate.set(t.slateId, list);
  }
  // Take numbers repeat inside a scene now (5.31 take 1, then 5.32 take 1), so
  // sorting on number alone would interleave setups. Shared comparator: scene
  // order -> shot order -> take number.
  const byStoryOrder = compareTakesInStoryOrder(bundle);
  for (const list of takesBySlate.values()) list.sort(byStoryOrder);
  const shotIndex = buildShotIndex(bundle);
  // Takes whose slate is missing from the bundle still get exported, at the end.
  const slateOrder = [...orderedSlateIds, ...[...takesBySlate.keys()].filter((id) => !slateName.has(id))];

  const lines: string[] = [row(HEADER)];

  for (const slateId of slateOrder) {
    const slateTakes = takesBySlate.get(slateId) ?? [];
    for (const take of slateTakes) {
      const sName = slateName.get(slateId) ?? '';
      // '' whenever the take has no shot, or carries a shotId its own scene no
      // longer knows about - the row is still written either way.
      const shotCode = shotCodeOf(take, shotIndex);
      // Accept the camera TC only if it parses AND is legal at this fps, so a
      // stray out-of-range frame number can't throw mid-export. addMsToTimecode
      // validates both (format via regex, FF via timebase) in one call.
      let cameraTC: string | undefined;
      if (take.cameraTC) {
        try {
          tc.addMsToTimecode(take.cameraTC, 0, fps);
          cameraTC = take.cameraTC;
        } catch {
          cameraTC = undefined;
        }
      }

      // One take row per camera unit (multi-cam) or a single row (single-cam),
      // so every camera's clip is present with its unit letter.
      const takeClips =
        take.clips && take.clips.length
          ? take.clips.map((c) => ({ camera: c.unit as string, clipName: c.clipName }))
          : [{ camera: '', clipName: take.clipName }];
      for (const c of takeClips) {
        lines.push(
          row([
            sName,
            shotCode,
            String(take.number),
            c.clipName,
            c.camera,
            operatorByUnit.get(c.camera) ?? '',
            take.sound?.fileName ?? '',
            take.status,
            'take',
            '',
            '',
            tc.msToClock(0),
            tc.msToClock(take.durationMs),
            tc.msToTimecode(0, fps),
            tc.msToTimecode(take.durationMs, fps),
            cameraTC ?? '',
            cameraTC ? tc.addMsToTimecode(cameraTC, take.durationMs, fps) : '',
            wallClockTC(take.startedAt, fps),
            wallClockTC(take.startedAt + take.durationMs, fps),
            String(take.durationMs),
            take.note ?? '',
          ]),
        );
      }

      const takeMoments = (momentsByTake.get(take.id) ?? []).slice().sort((a, b) => a.atMs - b.atMs);
      for (const m of takeMoments) {
        const isRange = m.kind === 'range' && m.endMs !== undefined;
        lines.push(
          row([
            sName,
            shotCode,
            String(take.number),
            take.clipName,
            '',
            '',
            take.sound?.fileName ?? '',
            take.status,
            m.kind,
            m.tag ?? '',
            m.label,
            tc.msToClock(m.atMs),
            isRange ? tc.msToClock(m.endMs as number) : '',
            tc.msToTimecode(m.atMs, fps),
            isRange ? tc.msToTimecode(m.endMs as number, fps) : '',
            cameraTC ? tc.addMsToTimecode(cameraTC, m.atMs, fps) : '',
            cameraTC && isRange ? tc.addMsToTimecode(cameraTC, m.endMs as number, fps) : '',
            wallClockTC(take.startedAt + m.atMs, fps),
            isRange ? wallClockTC(take.startedAt + (m.endMs as number), fps) : '',
            isRange ? String((m.endMs as number) - m.atMs) : '0',
            '',
          ]),
        );
      }
    }
  }

  return new Blob([lines.join('\r\n') + '\r\n'], { type: 'text/csv' });
}
