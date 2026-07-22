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

import type { CameraUnit, CameraUnitLetter, Fps, Moment, ProjectBundle, Take } from '../types';
import { isMultiCam } from '../types';

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

/** Good takes in slate order, then take number. */
function goodTakesInStoryOrder(bundle: ProjectBundle): Take[] {
  const slateOrder = new Map(
    [...bundle.slates].sort((a, b) => a.order - b.order).map((s, i) => [s.id, i]),
  );
  return bundle.takes
    .filter((t) => t.status === 'good')
    .sort((a, b) => {
      const sa = slateOrder.get(a.slateId) ?? Number.MAX_SAFE_INTEGER;
      const sb = slateOrder.get(b.slateId) ?? Number.MAX_SAFE_INTEGER;
      return sa !== sb ? sa - sb : a.number - b.number;
    });
}

/** All takes (good AND bad) in slate order, then take number. */
function allTakesInStoryOrder(bundle: ProjectBundle): Take[] {
  const slateOrder = new Map(
    [...bundle.slates].sort((a, b) => a.order - b.order).map((s, i) => [s.id, i]),
  );
  return [...bundle.takes].sort((a, b) => {
    const sa = slateOrder.get(a.slateId) ?? Number.MAX_SAFE_INTEGER;
    const sb = slateOrder.get(b.slateId) ?? Number.MAX_SAFE_INTEGER;
    return sa !== sb ? sa - sb : a.number - b.number;
  });
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

  function markersFor(take: Take, durationFrames: number): string {
    return (momentsByTake.get(take.id) ?? [])
      .slice()
      .sort((a, b) => a.atMs - b.atMs)
      .map((m) => {
        const label = m.label;
        const markerName = [m.tag, label].filter(Boolean).join(' ') || 'Marker';
        const inFrame = Math.min(msToFrames(m.atMs, fps), Math.max(0, durationFrames - 1));
        const outFrame =
          m.kind === 'range' && m.endMs !== undefined
            ? Math.min(Math.max(msToFrames(m.endMs, fps), inFrame + 1), durationFrames)
            : -1;
        return [
          '<marker>',
          `<name>${escapeXml(markerName)}</name>`,
          `<comment>${escapeXml(label)}</comment>`,
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

  // Lay one take at `start`; returns its duration in frames so the caller can
  // advance the timeline cursor. Each call gets its own clipitem/marker set,
  // so a take that appears in both bands is marked up correctly in both.
  function placeTake(take: Take, start: number): number {
    const durationFrames = Math.max(1, msToFrames(take.durationMs, fps));
    const end = start + durationFrames;
    const name = escapeXml(take.clipName);
    // The real media file the editor relinks to, e.g. "C0001.MP4".
    const fileName = escapeXml(take.clipName + ext);

    let fileId = fileIdByName.get(fileName);
    let fileXml: string; // full <file> on first sight of this card, else a ref
    if (fileId) {
      fileXml = `<file id="${fileId}"/>`;
    } else {
      fileId = `file-${(fileSeq += 1)}`;
      fileIdByName.set(fileName, fileId);
      fileXml =
        `<file id="${fileId}">` +
        `<name>${fileName}</name>` +
        `<pathurl>file://localhost/${fileName}</pathurl>` +
        rateXml +
        `<duration>${durationFrames}</duration>` +
        `<media><video/></media>` +
        `</file>`;
    }

    const markers = markersFor(take, durationFrames);

    clipItems.push(
      `        <clipitem id="clipitem-${(clipSeq += 1)}">
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
  for (const take of goodTakesInStoryOrder(bundle)) pos += placeTake(take, pos);
  const storyEnd = pos;

  // Gap, then Pass 2: EVERY take (good and bad) as a selects pool.
  const gapFrames = Math.max(1, Math.round(timebase * GAP_SECONDS));
  let sel = storyEnd + gapFrames;
  for (const take of allTakesInStoryOrder(bundle)) sel += placeTake(take, sel);
  const seqDuration = Math.max(1, sel);

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
      <audio/>
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

  // `anchorOffsetMs` shifts every moment's atMs into the anchor CLIP's own
  // local timeline (its <in>/<out> are frame offsets from ITS OWN start, not
  // the sequence start) and `anchorDurationFrames` clamps into that clip's
  // own span - a unit that joined late or cut early only owns the beats that
  // actually fall inside the time it was rolling.
  function markersFor(take: Take, anchorOffsetMs: number, anchorDurationFrames: number): string {
    return (momentsByTake.get(take.id) ?? [])
      .slice()
      .sort((a, b) => a.atMs - b.atMs)
      .map((m) => {
        const markerName = [m.tag, m.label].filter(Boolean).join(' ') || 'Marker';
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
          `<comment>${escapeXml(m.label)}</comment>` +
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
  function placeTake(take: Take, start: number): number {
    const takeDurationFrames = Math.max(1, msToFrames(take.durationMs, fps));
    const clips = take.clips ?? [];

    // Beats belong to the take, not one angle - carried on whichever unit
    // started earliest (offset 0 in the common case), by camera-letter order
    // on ties, so single-cam-shaped multi-cam takes keep anchoring on A.
    let anchorLetter: CameraUnitLetter | undefined;
    let anchorOffsetMs = 0;
    for (const unit of units) {
      const clip = clips.find((c) => c.unit === unit.letter);
      if (!clip) continue;
      const offset = clip.startOffsetMs ?? 0;
      if (anchorLetter === undefined || offset < anchorOffsetMs) {
        anchorLetter = unit.letter;
        anchorOffsetMs = offset;
      }
    }

    units.forEach((unit, ui) => {
      const clip = clips.find((c) => c.unit === unit.letter);
      if (!clip) return;
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
      const fileKey = `${fileName}|${unit.letter}`;

      let fileId = fileIdByKey.get(fileKey);
      let fileVideoXml: string; // full <file> on first sight of this card, else a ref
      if (fileId) {
        fileVideoXml = `<file id="${fileId}"/>`;
      } else {
        fileId = `file-${(fileSeq += 1)}`;
        fileIdByKey.set(fileKey, fileId);
        fileVideoXml =
          `<file id="${fileId}">` +
          `<name>${fileName}</name>` +
          `<pathurl>file://localhost/${fileName}</pathurl>` +
          rateXml +
          `<duration>${clipDurationFrames}</duration>` +
          // Reel/tape name = the camera unit letter. This is what disambiguates
          // two same-type cards that natively wrote identical filenames.
          `<timecode>${rateXml}<string>00:00:00:00</string><frame>0</frame>` +
          `<displayformat>NDF</displayformat><reel><name>${escapeXml(unit.letter)}</name></reel></timecode>` +
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

      const markers = unit.letter === anchorLetter ? markersFor(take, anchorOffsetMs, clipDurationFrames) : '';

      vTracks[ui].push(
        `        <clipitem id="${vId}">` +
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
  for (const take of goodTakesInStoryOrder(bundle)) pos += placeTake(take, pos);
  const storyEnd = pos;

  // Gap, then Pass 2: EVERY take (good and bad) as a selects pool.
  const gapFrames = Math.max(1, Math.round(timebase * GAP_SECONDS));
  let sel = storyEnd + gapFrames;
  for (const take of allTakesInStoryOrder(bundle)) sel += placeTake(take, sel);
  const seqDuration = Math.max(1, sel);

  const videoTracks = vTracks
    .map((items) => `        <track>\n${items.join('\n')}\n        </track>`)
    .join('\n');
  const audioTracks = aTracks
    .map((items) => `        <track>\n${items.join('\n')}\n        </track>`)
    .join('\n');

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
