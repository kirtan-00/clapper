// FCP7 xmeml (version 5) export. Premiere Pro imports this natively.
//
// SINGLE-CAM: one sequence at project fps, one video track, no <reel> (there is
// only ever one card). Two passes, same as multi-cam below: the GOOD takes in
// story order, then a GAP_SECONDS gap, then EVERY take (good and bad) as a
// selects pool. A good take appears in both passes and each one gets its own
// <marker>s, so nothing about tapped moments is lost in either band.
//
// MULTI-CAM (project.cameras, 2-4 units): each camera is a synced A/V pair on
// its own paired tracks - V1/A1 = unit A, V2/A2 = unit B, and so on. Every
// take drops each camera's clip (video + its own audio, linked) at the SAME
// timeline position across the tracks, so the cameras stack vertically in sync
// and the editor can multicam-cut them. Two passes: the GOOD takes in story
// order up front, then a gap, then EVERY take (good and bad) as a selects
// region. The camera UNIT LETTER rides as the FCP7 <reel> on each file, so
// identical same-type filenames (both "C0001.MP4") still relink to the right
// card without any filename change.

import type { CameraUnit, CameraUnitLetter, Fps, Moment, Project, ProjectBundle, Take } from '../types';
import { isMultiCam } from '../types';
import { mediaPath } from './paths';
// Ordering lives in order.ts, not here: it used to be copy-pasted between this
// file and resolve.ts, and the shot-order sort key has to land in both.
import {
  allTakesInStoryOrder,
  buildShotIndex,
  goodTakesInStoryOrder,
  shootDayKey,
  shootDaySuffix,
  shotCodeOf,
} from './order';

function escapeXml(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;');
}

/** FCP7 <rate> pair: 23.976 -> 24/TRUE, 29.97 -> 30/TRUE, 59.94 -> 60/TRUE, else fps/FALSE. */
function ratePair(fps: Fps): { timebase: number; ntsc: 'TRUE' | 'FALSE' } {
  if (fps === 23.976) return { timebase: 24, ntsc: 'TRUE' };
  if (fps === 29.97) return { timebase: 30, ntsc: 'TRUE' };
  if (fps === 59.94) return { timebase: 60, ntsc: 'TRUE' };
  return { timebase: fps, ntsc: 'FALSE' };
}

/** Exact frames-per-second for ms -> frame conversion. */
function exactRate(fps: Fps): number {
  if (fps === 23.976) return 24000 / 1001;
  if (fps === 29.97) return 30000 / 1001;
  if (fps === 59.94) return 60000 / 1001;
  return fps;
}

function msToFrames(ms: number, fps: Fps): number {
  return Math.round((ms * exactRate(fps)) / 1000);
}

/**
 * The per-reel folder a clip hangs off when the editor has not told us where
 * the footage really lives: "A_20260808", "SND_20260808_D2". Mirrors what
 * resolve.ts has always written.
 *
 * `undefined` for a take stamped before shoot days existed — there is nothing
 * to disambiguate, and the path stays the bare file name it always was.
 */
/**
 * The master clip a clipitem belongs to, derived from the <file> it plays.
 *
 * Premiere builds the project panel from <masterclipid>, NOT from <file>: with
 * the tag absent it invents one master clip per CLIPITEM, so a good take —
 * which by design appears in both the story cut and the selects pool — lands
 * in the bin twice, and a multi-cam take lands twice more for its linked audio
 * side. The last real shoot exported 351 clipitems for 232 physical files, and
 * every one of those duplicates had to be relinked by hand, separately.
 *
 * Keying it to the file id collapses every clipitem that plays the same card
 * onto one master clip, which is what the editor actually has: one file.
 */
function masterclipIdFor(fileId: string): string {
  return `masterclip-${fileId}`;
}

function reelFolder(prefix: string, take: Take): string | undefined {
  return take.shootDay ? `${prefix}${shootDaySuffix(take)}` : undefined;
}

/**
 * File names that are NOT unique across the export because the same name was
 * written on more than one shoot day — every day restarts at C0001, so a
 * two-week shoot has fourteen of them.
 *
 * This is the one case where a bare file name is not merely wrong-but-
 * relinkable, it is DANGEROUS: two master clips both claiming "/C0001.MP4"
 * let one "Relink others automatically" bind both to the same physical card,
 * and the edit silently contains the wrong take. Those names — and only those
 * — get pushed down into their reel folder so the two paths differ.
 *
 * Everything else keeps the bare name it has always had, which is what makes
 * a single Locate + "relink others automatically" bring the whole shoot
 * online in one go.
 */
function ambiguousFileNames(takes: Take[], ext: string): Set<string> {
  const daysByName = new Map<string, Set<string>>();
  for (const take of takes) {
    const name = take.clipName + ext;
    const days = daysByName.get(name) ?? new Set<string>();
    days.add(shootDayKey(take));
    daysByName.set(name, days);
  }
  const ambiguous = new Set<string>();
  for (const [name, days] of daysByName) if (days.size > 1) ambiguous.add(name);
  return ambiguous;
}

/**
 * The folder for a PICTURE clip's <pathurl>.
 *
 * The editor's real footage root wins when they have set one — that is the
 * whole point of it, and the difference between an import that lands online
 * and 232 clips located by hand.
 *
 * With no root, the bare file name stays, deliberately: it is what Premiere's
 * "relink others automatically" is good at, and it is what this exporter has
 * always written. The single exception is a name that repeats across shoot
 * days (see ambiguousFileNames), which would otherwise relink to the wrong
 * card without saying so.
 *
 * Production sound deliberately does NOT read mediaRoot: a recorder's files
 * live on their own card, not in the camera's folder, and inventing a path
 * inside the picture root would point Premiere confidently at nothing. Sound
 * keeps the reel folder until it gets a root of its own.
 */
function mediaFolderFor(
  project: Project,
  take: Take,
  reelPrefix: string,
  ambiguous: Set<string>,
  fileName: string,
): string | undefined {
  const root = project.mediaRoot?.trim();
  if (root) return root;
  return ambiguous.has(fileName) ? reelFolder(reelPrefix, take) : undefined;
}

export function toFcpXml(bundle: ProjectBundle): Blob {
  if (isMultiCam(bundle.project)) return multiCamFcpXml(bundle);
  return singleCamFcpXml(bundle);
}

// ---------------------------------------------------------------- single ---

const GAP_SECONDS = 3; // breathing room between the story cut and the selects pool

function singleCamFcpXml(bundle: ProjectBundle): Blob {
  const { project, moments } = bundle;
  const fps = project.fps;
  const ext = project.clipExt ?? '';
  const { timebase, ntsc } = ratePair(fps);
  const rateXml = `<rate><timebase>${timebase}</timebase><ntsc>${ntsc}</ntsc></rate>`;

  const momentsByTake = new Map<string, Moment[]>();
  for (const m of moments) {
    const list = momentsByTake.get(m.takeId) ?? [];
    list.push(m);
    momentsByTake.set(m.takeId, list);
  }

  const shotIndex = buildShotIndex(bundle);

  // Computed once over EVERY take, not per band: a name is ambiguous or it is
  // not, and the answer must not depend on which pass is being written.
  const ambiguous = ambiguousFileNames(bundle.takes, ext);

  function markersFor(take: Take, durationFrames: number): string {
    // The clip <name> deliberately stays the raw camera file name (editors
    // relink on it) and <reel> is load-bearing for multi-cam - so the MARKER is
    // the only place an editor ever sees which setup a beat came from. Prefix
    // the shot code, e.g. "5.31 GOLD the look". Empty for a take with no shot,
    // which makes these joins collapse to exactly what they emitted before.
    const code = shotCodeOf(take, shotIndex);
    return (momentsByTake.get(take.id) ?? [])
      .slice()
      .sort((a, b) => a.atMs - b.atMs)
      .map((m) => {
        const label = m.label;
        const markerName = [code, m.tag, label].filter(Boolean).join(' ') || 'Marker';
        const markerComment = [code, label].filter(Boolean).join(' ');
        const inFrame = Math.min(msToFrames(m.atMs, fps), Math.max(0, durationFrames - 1));
        const outFrame =
          m.kind === 'range' && m.endMs !== undefined
            ? Math.min(Math.max(msToFrames(m.endMs, fps), inFrame + 1), durationFrames)
            : -1;
        return [
          '<marker>',
          `<name>${escapeXml(markerName)}</name>`,
          `<comment>${escapeXml(markerComment)}</comment>`,
          `<in>${inFrame}</in>`,
          `<out>${outFrame}</out>`,
          '</marker>',
        ].join('');
      })
      .join('\n          ');
  }

  let clipSeq = 0;
  const clipItems: string[] = [];

  // A physical card (fileName) is defined once; a good take, present in BOTH
  // the story cut and the selects pool below, relinks to the same file both
  // times via a <file id="..."/> reference on its second appearance.
  const fileIdByName = new Map<string, string>();
  let fileSeq = 0;

  // Production sound (orthogonal to the picture track above): one clipitem per
  // take that actually recorded sound, placed on its own audio track at the
  // SAME timeline position as that take's picture. Absent entirely when the
  // project carries no Sound unit, so a legacy project's <audio/> stays the
  // untouched self-closing tag it always was.
  let soundClipSeq = 0;
  const soundClipItems: string[] = [];
  const soundFileIdByName = new Map<string, string>();
  let soundFileSeq = 0;

  function placeSoundClip(take: Take, start: number): void {
    const sound = project.sound;
    if (!sound || !take.sound) return;
    const offsetMs = take.sound.startOffsetMs ?? 0;
    const durationFrames = Math.max(1, msToFrames(take.sound.durationMs ?? take.durationMs, fps));
    const clipStart = start + msToFrames(offsetMs, fps);
    const clipEnd = clipStart + durationFrames;
    const ext = sound.fileExt ?? '';
    const name = escapeXml(take.sound.fileName);
    const fileName = escapeXml(take.sound.fileName + ext);
    // The path is a URL, not XML text, so it is encoded from the raw name.
    // Sound hangs off its own reel folder, never the picture root — see
    // mediaFolderFor.
    const filePath = mediaPath(reelFolder('SND', take), take.sound.fileName + ext);
    // Same file name recurs every shoot day (SND_0001 resets with the rest of
    // the counters), so the dedupe key must include the day or two different
    // days' SND_0001 collapse into one <file> — same collision class as the
    // picture card below. The day's own INDEX, not just its date, breaks the
    // tie when two days share a date string (see shootDayKey in order.ts — a
    // night shoot that wraps twice before midnight lands two days on one
    // date). A legacy take (no shootDay) keys exactly as before.
    const fileKey = `${fileName}|${shootDayKey(take)}`;

    let fileId = soundFileIdByName.get(fileKey);
    let fileXml: string;
    if (fileId) {
      fileXml = `<file id="${fileId}"/>`;
    } else {
      fileId = `soundfile-${(soundFileSeq += 1)}`;
      soundFileIdByName.set(fileKey, fileId);
      // Reel = "SND" plus the shoot day (and its index, when two days share a
      // date) when there is one, mirroring the picture card's reel below —
      // absent for a legacy take, so its <file> stays byte-identical to
      // before this feature (there was never a <reel>/<timecode> here at all
      // for single-cam sound).
      const reel = take.shootDay
        ? `<timecode>${rateXml}<string>00:00:00:00</string><frame>0</frame>` +
          `<displayformat>NDF</displayformat><reel><name>SND${shootDaySuffix(take)}</name></reel></timecode>`
        : '';
      fileXml =
        `<file id="${fileId}">` +
        `<name>${fileName}</name>` +
        `<pathurl>file://localhost/${filePath}</pathurl>` +
        rateXml +
        `<duration>${durationFrames}</duration>` +
        reel +
        `<media><audio><channelcount>2</channelcount></audio></media>` +
        `</file>`;
    }

    soundClipItems.push(
      `        <clipitem id="soundclip-${(soundClipSeq += 1)}">
          <masterclipid>${masterclipIdFor(fileId)}</masterclipid>
          <name>${name}</name>
          <duration>${durationFrames}</duration>
          ${rateXml}
          <start>${clipStart}</start>
          <end>${clipEnd}</end>
          <in>0</in>
          <out>${durationFrames}</out>
          ${fileXml}
        </clipitem>`,
    );
  }

  // Lay one take at `start`; returns its duration in frames so the caller can
  // advance the timeline cursor. Each call gets its own clipitem/marker set,
  // so a take that appears in both bands is marked up correctly in both.
  function placeTake(take: Take, start: number): number {
    const durationFrames = Math.max(1, msToFrames(take.durationMs, fps));
    const end = start + durationFrames;
    const name = escapeXml(take.clipName);
    // The real media file the editor relinks to, e.g. "C0001.MP4".
    const fileName = escapeXml(take.clipName + ext);
    // <pathurl> is ABSOLUTE. A bare "C0001.MP4" resolves to the root of the
    // boot volume, so every clip imports offline and has to be located by
    // hand — the failure a real 232-clip import hit. project.mediaRoot is the
    // editor's actual footage folder and makes the import land fully online;
    // with none set we fall back to the per-reel folder resolve.ts has always
    // written, which is still offline but at least keeps day 1's C0001 from
    // relinking to day 5's C0001. A legacy take (no shootDay, no root) still
    // emits the bare file name, byte-identical to before.
    const filePath = mediaPath(
      mediaFolderFor(project, take, 'A', ambiguous, take.clipName + ext),
      take.clipName + ext,
    );
    // Every shoot day restarts at C0001, so the SAME fileName recurs day after
    // day — the dedupe key must include the day or day 1's C0001 and day 5's
    // C0001 collapse into ONE <file>, silently relinking the editor to the
    // wrong physical clip. A take with no shootDay (every legacy take) keys
    // exactly as it always has: one shared bucket, nothing changes.
    const fileKey = `${fileName}|${shootDayKey(take)}`;

    let fileId = fileIdByName.get(fileKey);
    let fileXml: string; // full <file> on first sight of this card, else a ref
    if (fileId) {
      fileXml = `<file id="${fileId}"/>`;
    } else {
      fileId = `file-${(fileSeq += 1)}`;
      fileIdByName.set(fileKey, fileId);
      // Reel/tape name = camera letter (single-cam is always "A") plus the
      // shoot day, e.g. "A_20260731" — the visible disambiguator in the NLE on
      // top of the fileKey split above. Absent when the take has no shootDay,
      // so a legacy take's <file> is byte-identical to before this feature.
      const reel = take.shootDay
        ? `<timecode>${rateXml}<string>00:00:00:00</string><frame>0</frame>` +
          `<displayformat>NDF</displayformat><reel><name>A${shootDaySuffix(take)}</name></reel></timecode>`
        : '';
      fileXml =
        `<file id="${fileId}">` +
        `<name>${fileName}</name>` +
        `<pathurl>file://localhost/${filePath}</pathurl>` +
        rateXml +
        `<duration>${durationFrames}</duration>` +
        reel +
        `<media><video/></media>` +
        `</file>`;
    }

    const markers = markersFor(take, durationFrames);

    clipItems.push(
      `        <clipitem id="clipitem-${(clipSeq += 1)}">
          <masterclipid>${masterclipIdFor(fileId)}</masterclipid>
          <name>${name}</name>
          <duration>${durationFrames}</duration>
          ${rateXml}
          <start>${start}</start>
          <end>${end}</end>
          <in>0</in>
          <out>${durationFrames}</out>
          ${fileXml}${markers ? '\n          ' + markers : ''}
        </clipitem>`,
    );

    return durationFrames;
  }

  // Pass 1: GOOD takes, story order, back-to-back from 0.
  let pos = 0;
  for (const take of goodTakesInStoryOrder(bundle)) {
    placeSoundClip(take, pos);
    pos += placeTake(take, pos);
  }
  const storyEnd = pos;

  // Gap, then Pass 2: EVERY take (good and bad) as a selects pool.
  const gapFrames = Math.max(1, Math.round(timebase * GAP_SECONDS));
  let sel = storyEnd + gapFrames;
  for (const take of allTakesInStoryOrder(bundle)) {
    placeSoundClip(take, sel);
    sel += placeTake(take, sel);
  }
  const seqDuration = Math.max(1, sel);

  // No Sound unit: keep the legacy empty <audio/> tag byte-identical. Otherwise
  // a real audio track carries every take's sound clipitem (may be empty if the
  // project has a Sound unit but no take ever rolled it).
  const audioXml = project.sound
    ? `<audio>\n        <track>\n${soundClipItems.join('\n')}\n        </track>\n      </audio>`
    : '<audio/>';

  const xml = `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE xmeml>
<xmeml version="5">
  <sequence id="sequence-1">
    <name>${escapeXml(project.name)}</name>
    <duration>${seqDuration}</duration>
    ${rateXml}
    <media>
      <video>
        <format>
          <samplecharacteristics>
            ${rateXml}
            <width>1920</width>
            <height>1080</height>
          </samplecharacteristics>
        </format>
        <track>
${clipItems.join('\n')}
        </track>
      </video>
      ${audioXml}
    </media>
  </sequence>
</xmeml>
`;

  return new Blob([xml], { type: 'application/xml' });
}

// ----------------------------------------------------------------- multi ---

function multiCamFcpXml(bundle: ProjectBundle): Blob {
  const { project, moments } = bundle;
  const fps = project.fps;
  const units: CameraUnit[] = project.cameras ?? [];
  const { timebase, ntsc } = ratePair(fps);
  const rateXml = `<rate><timebase>${timebase}</timebase><ntsc>${ntsc}</ntsc></rate>`;

  const momentsByTake = new Map<string, Moment[]>();
  for (const m of moments) {
    const list = momentsByTake.get(m.takeId) ?? [];
    list.push(m);
    momentsByTake.set(m.takeId, list);
  }

  const shotIndex = buildShotIndex(bundle);

  // Per-unit clipitem accumulators. video[i]/audio[i] belong to unit i, whose
  // 1-based track index (V(i+1)/A(i+1)) is shared by its video and audio track.
  const vTracks: string[][] = units.map(() => []);
  const aTracks: string[][] = units.map(() => []);
  const counts: number[] = units.map(() => 0); // clipindex cursor per track

  // A physical card (fileName + reel/unit) is defined once; later uses of the
  // same media - the same clip in the selects pass, or its audio side - just
  // reference the id. This is how a good take, present in BOTH regions, relinks
  // to one file.
  const fileIdByKey = new Map<string, string>();
  let clipitemSeq = 0;
  let fileSeq = 0;

  // Production sound: one more audio track, independent of the per-camera A/V
  // pairs above, carrying one clipitem per take that actually recorded sound.
  // Absent entirely when the project has no Sound unit.
  const soundTrack: string[] = [];
  const soundFileIdByName = new Map<string, string>();
  let soundFileSeq = 0;
  let soundClipSeq = 0;

  function placeSoundClip(take: Take, start: number): void {
    const sound = project.sound;
    if (!sound || !take.sound) return;
    const offsetMs = take.sound.startOffsetMs ?? 0;
    const durationFrames = Math.max(1, msToFrames(take.sound.durationMs ?? take.durationMs, fps));
    const clipStart = start + msToFrames(offsetMs, fps);
    const clipEnd = clipStart + durationFrames;
    const ext = sound.fileExt ?? '';
    const name = escapeXml(take.sound.fileName);
    const fileName = escapeXml(take.sound.fileName + ext);
    // The path is a URL, not XML text, so it is encoded from the raw name.
    // Sound hangs off its own reel folder, never the picture root — see
    // mediaFolderFor.
    const filePath = mediaPath(reelFolder('SND', take), take.sound.fileName + ext);
    // Same file name recurs every shoot day (SND_0001 resets with the rest of
    // the counters), so the dedupe key must include the day or two different
    // days' SND_0001 collapse into one <file> and relink to the wrong take's
    // audio. A legacy take (no shootDay) keys exactly as it always has.
    const fileKey = `${fileName}|${shootDayKey(take)}`;

    let fileId = soundFileIdByName.get(fileKey);
    let fileXml: string;
    if (fileId) {
      fileXml = `<file id="${fileId}"/>`;
    } else {
      fileId = `soundfile-${(soundFileSeq += 1)}`;
      soundFileIdByName.set(fileKey, fileId);
      // Reel = "SND", plus the shoot day when there is one - this is what
      // actually disambiguates two different days' recorder files sharing a
      // name, on top of the fileKey split above. A legacy take (no shootDay)
      // gets exactly "SND", byte-identical to before this feature.
      const reelName = take.shootDay ? `SND${shootDaySuffix(take)}` : 'SND';
      fileXml =
        `<file id="${fileId}">` +
        `<name>${fileName}</name>` +
        `<pathurl>file://localhost/${filePath}</pathurl>` +
        rateXml +
        `<duration>${durationFrames}</duration>` +
        `<timecode>${rateXml}<string>00:00:00:00</string><frame>0</frame>` +
        `<displayformat>NDF</displayformat><reel><name>${reelName}</name></reel></timecode>` +
        `<media><audio><channelcount>2</channelcount></audio></media>` +
        `</file>`;
    }

    soundTrack.push(
      `        <clipitem id="soundclip-${(soundClipSeq += 1)}">` +
        `<masterclipid>${masterclipIdFor(fileId)}</masterclipid>` +
        `<name>${name}</name><duration>${durationFrames}</duration>${rateXml}` +
        `<start>${clipStart}</start><end>${clipEnd}</end><in>0</in><out>${durationFrames}</out>` +
        fileXml +
        `<sourcetrack><mediatype>audio</mediatype><trackindex>1</trackindex></sourcetrack>` +
        `</clipitem>`,
    );
  }

  // `anchorOffsetMs` shifts every moment's atMs into the anchor CLIP's own
  // local timeline (its <in>/<out> are frame offsets from ITS OWN start, not
  // the sequence start) and `anchorDurationFrames` clamps into that clip's
  // own span - a unit that joined late or cut early only owns the beats that
  // actually fall inside the time it was rolling.
  function markersFor(take: Take, anchorOffsetMs: number, anchorDurationFrames: number): string {
    // Shot code rides on the marker only - see the single-cam note above for
    // why <name>/<reel> are off limits. '' for a take with no shot, so a legacy
    // project's markers come out exactly as they always did.
    const code = shotCodeOf(take, shotIndex);
    return (momentsByTake.get(take.id) ?? [])
      .slice()
      .sort((a, b) => a.atMs - b.atMs)
      .map((m) => {
        const markerName = [code, m.tag, m.label].filter(Boolean).join(' ') || 'Marker';
        const markerComment = [code, m.label].filter(Boolean).join(' ');
        const inFrame = Math.min(
          Math.max(0, msToFrames(m.atMs - anchorOffsetMs, fps)),
          Math.max(0, anchorDurationFrames - 1),
        );
        const outFrame =
          m.kind === 'range' && m.endMs !== undefined
            ? Math.min(Math.max(msToFrames(m.endMs - anchorOffsetMs, fps), inFrame + 1), anchorDurationFrames)
            : -1;
        return (
          `<marker><name>${escapeXml(markerName)}</name>` +
          `<comment>${escapeXml(markerComment)}</comment>` +
          `<in>${inFrame}</in><out>${outFrame}</out></marker>`
        );
      })
      .join('');
  }

  // Lay one take across every unit's V/A track pair. Each unit's own clip
  // sits at `start` + its own startOffsetMs and runs its own durationMs -
  // only cameras that actually rolled this take get a clipitem at all.
  // `start` -> `start + takeDurationFrames` is still the timeline slot the
  // WHOLE take occupies (unaffected by any one unit's own timing), so takes
  // stay laid back-to-back regardless of which camera happened to roll.
  //
  // A unit can carry SEVERAL clips on one take - it cut and rejoined while the
  // others kept rolling (card swap, battery, a B-cam grabbing an insert) - and
  // each lands on that unit's own track at its own offset, so the editor sees
  // the gap where that camera was down instead of one clip papering over it.
  function placeTake(take: Take, start: number): number {
    const takeDurationFrames = Math.max(1, msToFrames(take.durationMs, fps));
    const clips = take.clips ?? [];

    // Every clipitem this take will lay down, flattened: unit-letter order
    // across cameras, roll order within one camera. `ci` is that clip's index
    // among its OWN unit's rolls, which is what decides who carries the beats.
    const placements = units.flatMap((unit, ui) =>
      clips
        .filter((c) => c.unit === unit.letter)
        .sort((a, b) => (a.startOffsetMs ?? 0) - (b.startOffsetMs ?? 0))
        .map((clip, ci) => ({ unit, ui, clip, ci })),
    );

    // Beats belong to the take, not one angle - carried on whichever unit
    // started earliest (offset 0 in the common case), by camera-letter order
    // on ties, so single-cam-shaped multi-cam takes keep anchoring on A.
    let anchorLetter: CameraUnitLetter | undefined;
    let anchorOffsetMs = 0;
    for (const p of placements) {
      if (p.ci !== 0) continue; // a unit anchors on its first roll, not its later ones
      const offset = p.clip.startOffsetMs ?? 0;
      if (anchorLetter === undefined || offset < anchorOffsetMs) {
        anchorLetter = p.unit.letter;
        anchorOffsetMs = offset;
      }
    }

    placements.forEach(({ unit, ui, clip, ci }) => {
      const ext = unit.clipExt ?? '';
      const trackIndex = ui + 1; // V(trackIndex) and A(trackIndex) run in sync
      const clipIndex = (counts[ui] += 1);

      const offsetMs = clip.startOffsetMs ?? 0;
      const clipDurationFrames = Math.max(1, msToFrames(clip.durationMs ?? take.durationMs, fps));
      const clipStart = start + msToFrames(offsetMs, fps);
      const clipEnd = clipStart + clipDurationFrames;

      const vId = `clipitem-${(clipitemSeq += 1)}`;
      const aId = `clipitem-${(clipitemSeq += 1)}`;
      const name = escapeXml(clip.clipName);
      const fileName = escapeXml(clip.clipName + ext);
      // Multi-cam ALWAYS nests by unit, unlike single-cam: two cameras of the
      // same model natively write the identical file name on the same day, so
      // a bare path is not merely offline, it is two different cards claiming
      // one location. This mirrors what resolve.ts has always done. The
      // editor's root, when set, sits above the unit folder.
      const filePath = mediaPath(
        project.mediaRoot?.trim(),
        `${unit.letter}${shootDaySuffix(take)}`,
        clip.clipName + ext,
      );
      // Every shoot day restarts at C0001, so two units of the SAME letter on
      // DIFFERENT days can still natively write the identical filename - the
      // unit letter alone (the old key) no longer disambiguates them. Fold
      // the day in too, or day 1's A/C0001 and day 5's A/C0001 collapse into
      // one <file>. A legacy take (no shootDay) keys exactly as it always has.
      const fileKey = `${fileName}|${unit.letter}|${shootDayKey(take)}`;

      let fileId = fileIdByKey.get(fileKey);
      let fileVideoXml: string; // full <file> on first sight of this card, else a ref
      if (fileId) {
        fileVideoXml = `<file id="${fileId}"/>`;
      } else {
        fileId = `file-${(fileSeq += 1)}`;
        fileIdByKey.set(fileKey, fileId);
        // Reel/tape name = the camera unit letter plus the shoot day, e.g.
        // "A_20260731" - disambiguates both two same-type cards on the SAME
        // day (the unit letter) and the same unit across DIFFERENT days (the
        // day suffix). Absent when the take has no shootDay, so a legacy
        // take's <file> is byte-identical to before this feature: plain
        // unit letter, nothing appended.
        const reelName = take.shootDay ? `${unit.letter}${shootDaySuffix(take)}` : unit.letter;
        fileVideoXml =
          `<file id="${fileId}">` +
          `<name>${fileName}</name>` +
          `<pathurl>file://localhost/${filePath}</pathurl>` +
          rateXml +
          `<duration>${clipDurationFrames}</duration>` +
          `<timecode>${rateXml}<string>00:00:00:00</string><frame>0</frame>` +
          `<displayformat>NDF</displayformat><reel><name>${escapeXml(reelName)}</name></reel></timecode>` +
          `<media><video/><audio><channelcount>2</channelcount></audio></media>` +
          `</file>`;
      }
      const fileAudioXml = `<file id="${fileId}"/>`;

      // Link the video and its own audio so they move (and get cut) together.
      const links =
        `<link><linkclipref>${vId}</linkclipref><mediatype>video</mediatype>` +
        `<trackindex>${trackIndex}</trackindex><clipindex>${clipIndex}</clipindex></link>` +
        `<link><linkclipref>${aId}</linkclipref><mediatype>audio</mediatype>` +
        `<trackindex>${trackIndex}</trackindex><clipindex>${clipIndex}</clipindex></link>`;

      // Beats hang off the anchor unit's FIRST clip only: if that camera cut
      // and rejoined, its later files must not each carry a duplicate set.
      const markers =
        unit.letter === anchorLetter && ci === 0
          ? markersFor(take, anchorOffsetMs, clipDurationFrames)
          : '';

      // Video and its own audio side are ONE master clip — the same physical
      // file — so they share a masterclipid and the bin shows one item, not a
      // picture entry and a phantom audio entry beside it.
      const masterId = masterclipIdFor(fileId);

      vTracks[ui].push(
        `        <clipitem id="${vId}">` +
          `<masterclipid>${masterId}</masterclipid>` +
          `<name>${name}</name><duration>${clipDurationFrames}</duration>${rateXml}` +
          `<start>${clipStart}</start><end>${clipEnd}</end><in>0</in><out>${clipDurationFrames}</out>` +
          fileVideoXml +
          `<sourcetrack><mediatype>video</mediatype></sourcetrack>` +
          links +
          markers +
          `</clipitem>`,
      );
      aTracks[ui].push(
        `        <clipitem id="${aId}">` +
          `<masterclipid>${masterId}</masterclipid>` +
          `<name>${name}</name><duration>${clipDurationFrames}</duration>${rateXml}` +
          `<start>${clipStart}</start><end>${clipEnd}</end><in>0</in><out>${clipDurationFrames}</out>` +
          fileAudioXml +
          `<sourcetrack><mediatype>audio</mediatype><trackindex>1</trackindex></sourcetrack>` +
          links +
          `</clipitem>`,
      );
    });

    return takeDurationFrames;
  }

  // Pass 1: GOOD takes, story order, back-to-back from 0.
  let pos = 0;
  for (const take of goodTakesInStoryOrder(bundle)) {
    placeSoundClip(take, pos);
    pos += placeTake(take, pos);
  }
  const storyEnd = pos;

  // Gap, then Pass 2: EVERY take (good and bad) as a selects pool.
  const gapFrames = Math.max(1, Math.round(timebase * GAP_SECONDS));
  let sel = storyEnd + gapFrames;
  for (const take of allTakesInStoryOrder(bundle)) {
    placeSoundClip(take, sel);
    sel += placeTake(take, sel);
  }
  const seqDuration = Math.max(1, sel);

  const videoTracks = vTracks
    .map((items) => `        <track>\n${items.join('\n')}\n        </track>`)
    .join('\n');
  // Per-camera A/V pairs first, exactly as before; the Sound unit's own track
  // (when the project has one) rides last, so a legacy multi-cam project's
  // audio block is byte-identical to before.
  const audioTracks = [
    ...aTracks.map((items) => `        <track>\n${items.join('\n')}\n        </track>`),
    ...(project.sound ? [`        <track>\n${soundTrack.join('\n')}\n        </track>`] : []),
  ].join('\n');

  const xml = `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE xmeml>
<xmeml version="5">
  <sequence id="sequence-1">
    <name>${escapeXml(project.name)}</name>
    <duration>${seqDuration}</duration>
    ${rateXml}
    <media>
      <video>
        <format>
          <samplecharacteristics>
            ${rateXml}
            <width>1920</width>
            <height>1080</height>
          </samplecharacteristics>
        </format>
${videoTracks}
      </video>
      <audio>
${audioTracks}
      </audio>
    </media>
  </sequence>
</xmeml>
`;

  return new Blob([xml], { type: 'application/xml' });
}
