// Flat CSV export. One row per moment, plus one "take" row per take so takes
// with zero moments still appear. RFC 4180 quoting, CRLF line endings.

import type { Moment, ProjectBundle, Take } from '../types';
import { tc, wallClockTC } from './timecode';
import { buildShotIndex, compareTakesInStoryOrder, displayShootDay, shotCodeOf } from './order';
import { matchClip, type MediaIndex, type MediaMatch } from './medialink';

// `shot` is the SHOT CODE off the shotlist ("5.31"), empty for a take logged
// straight against a scene. `take` is the take number - it is the column that
// used to be called `shot`, which was simply the wrong word: Scene > Shot >
// Take. Deliberate breaking header change; the two exports disagreed before.
//
// `date` is the shoot day so an editor can tell two identically-numbered clips
// from different days apart (see the reel/tape name change in fcpxml.ts and
// resolve.ts) - the real stamped day when the take has one, else a
// display-only label derived from when it was logged (see
// order.ts's displayShootDay).
const HEADER = [
  'scene',
  'shot',
  'take',
  'date',
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
  // Appended at the END, deliberately: anything already reading this file by
  // column position keeps working, and a project that never picks a footage
  // folder just gains three empty cells.
  //
  // THREE columns rather than one, because an empty `file_path` on its own
  // is three different situations that need three different actions from an
  // assistant editor: nobody has picked a folder yet, the clip is genuinely
  // not on the disk, or two cards both claim the name. `file_status` says
  // which. `file_alternatives` then hands over both candidates for the third
  // case, so the person can go and look instead of re-walking the tree.
  'file_path',
  'file_status',
  'file_alternatives',
];

/** The three trailing cells for one clip name. `unindexed` writes three
 *  blanks — the file this export produced before the footage folder existed,
 *  byte for byte. A guessed path is never written: a blank cell is visibly
 *  blank, a wrong path costs an afternoon to disprove. */
function mediaCells(match: MediaMatch): [string, string, string] {
  if (match.status === 'unindexed') return ['', '', ''];
  return [
    match.path,
    match.status,
    match.status === 'ambiguous' ? match.candidates.join('; ') : '',
  ];
}

function csvField(value: string): string {
  if (/[",\r\n]/.test(value)) {
    return `"${value.replace(/"/g, '""')}"`;
  }
  return value;
}

function row(fields: string[]): string {
  return fields.map(csvField).join(',');
}

/**
 * `mediaIndex` is the walk of the footage folder the user picked on THIS
 * device (see medialink.ts, store/medialink.ts). Optional throughout: it is a
 * property of the machine holding the cards, not of the project, so every
 * caller that has not picked a folder passes nothing and gets the export it
 * always got.
 */
export function toCsv(bundle: ProjectBundle, mediaIndex?: MediaIndex): Blob {
  const { project, slates, takes, moments } = bundle;
  const fps = project.fps;
  const mediaRoot = project.mediaRoot?.trim();

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

      const dateLabel = displayShootDay(take);

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
            dateLabel,
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
            ...mediaCells(matchClip(mediaIndex, c.clipName, mediaRoot)),
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
            dateLabel,
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
            // A moment belongs to the take, and the take's `clip` cell above
            // is unit A's file — so a moment row points at the same file its
            // own `clip` column names, not at whichever camera row precedes it.
            ...mediaCells(matchClip(mediaIndex, take.clipName, mediaRoot)),
          ]),
        );
      }
    }
  }

  return new Blob([lines.join('\r\n') + '\r\n'], { type: 'text/csv' });
}
