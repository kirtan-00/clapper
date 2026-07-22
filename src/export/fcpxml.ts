// FCP7 xmeml (version 5) export. Premiere Pro imports this natively.
//
// SINGLE-CAM: one sequence at project fps, one clipitem per GOOD take laid
// back-to-back on video track 1, offline <file> children the editor relinks,
// and one <marker> per moment. This is the original, unchanged output shape.
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

import type { CameraUnit, Fps, Moment, ProjectBundle, Take } from '../types';
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
// Unchanged from the original single-track export. Kept intact so existing
// single-cam projects produce byte-for-byte the same XML they always have.

function singleCamFcpXml(bundle: ProjectBundle): Blob {
  const { project, slates, takes, moments } = bundle;
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

  // Good takes in slate order, then take number, back-to-back on track 1.
  const slateOrder = new Map([...slates].sort((a, b) => a.order - b.order).map((s, i) => [s.id, i]));
  const goodTakes: Take[] = takes
    .filter((t) => t.status === 'good')
    .sort((a, b) => {
      const sa = slateOrder.get(a.slateId) ?? Number.MAX_SAFE_INTEGER;
      const sb = slateOrder.get(b.slateId) ?? Number.MAX_SAFE_INTEGER;
      return sa !== sb ? sa - sb : a.number - b.number;
    });

  let timelinePos = 0;
  const clipItems: string[] = [];

  goodTakes.forEach((take, i) => {
    const durationFrames = Math.max(1, msToFrames(take.durationMs, fps));
    const start = timelinePos;
    const end = timelinePos + durationFrames;
    timelinePos = end;

    const name = escapeXml(take.clipName);
    // The real media file the editor relinks to, e.g. "C0001.MP4".
    const fileName = escapeXml(take.clipName + ext);

    const markers = (momentsByTake.get(take.id) ?? [])
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

    // <file> has a name but no <pathurl>: Premiere imports the media offline
    // and the editor relinks to the real camera files.
    clipItems.push(
      `        <clipitem id="clipitem-${i + 1}">
          <name>${name}</name>
          <duration>${durationFrames}</duration>
          ${rateXml}
          <start>${start}</start>
          <end>${end}</end>
          <in>0</in>
          <out>${durationFrames}</out>
          <file id="file-${i + 1}">
            <name>${fileName}</name>
            <pathurl>file://localhost/${fileName}</pathurl>
            ${rateXml}
            <duration>${durationFrames}</duration>
            <media>
              <video/>
            </media>
          </file>${markers ? '\n          ' + markers : ''}
        </clipitem>`,
    );
  });

  const xml = `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE xmeml>
<xmeml version="5">
  <sequence id="sequence-1">
    <name>${escapeXml(project.name)}</name>
    <duration>${timelinePos}</duration>
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

const GAP_SECONDS = 3; // breathing room between the story cut and the selects pool

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

  function markersFor(take: Take, durationFrames: number): string {
    return (momentsByTake.get(take.id) ?? [])
      .slice()
      .sort((a, b) => a.atMs - b.atMs)
      .map((m) => {
        const markerName = [m.tag, m.label].filter(Boolean).join(' ') || 'Marker';
        const inFrame = Math.min(msToFrames(m.atMs, fps), Math.max(0, durationFrames - 1));
        const outFrame =
          m.kind === 'range' && m.endMs !== undefined
            ? Math.min(Math.max(msToFrames(m.endMs, fps), inFrame + 1), durationFrames)
            : -1;
        return (
          `<marker><name>${escapeXml(markerName)}</name>` +
          `<comment>${escapeXml(m.label)}</comment>` +
          `<in>${inFrame}</in><out>${outFrame}</out></marker>`
        );
      })
      .join('');
  }

  // Lay one take across every unit's V/A track pair, aligned at `start`.
  function placeTake(take: Take, start: number): number {
    const durationFrames = Math.max(1, msToFrames(take.durationMs, fps));
    const end = start + durationFrames;

    units.forEach((unit, ui) => {
      const clip = (take.clips ?? []).find((c) => c.unit === unit.letter);
      if (!clip) return;
      const ext = unit.clipExt ?? '';
      const trackIndex = ui + 1; // V(trackIndex) and A(trackIndex) run in sync
      const clipIndex = (counts[ui] += 1);

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
          `<duration>${durationFrames}</duration>` +
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

      // Beats belong to the take, not one angle: carry them on unit A's picture.
      const markers = ui === 0 ? markersFor(take, durationFrames) : '';

      vTracks[ui].push(
        `        <clipitem id="${vId}">` +
          `<name>${name}</name><duration>${durationFrames}</duration>${rateXml}` +
          `<start>${start}</start><end>${end}</end><in>0</in><out>${durationFrames}</out>` +
          fileVideoXml +
          `<sourcetrack><mediatype>video</mediatype></sourcetrack>` +
          links +
          markers +
          `</clipitem>`,
      );
      aTracks[ui].push(
        `        <clipitem id="${aId}">` +
          `<name>${name}</name><duration>${durationFrames}</duration>${rateXml}` +
          `<start>${start}</start><end>${end}</end><in>0</in><out>${durationFrames}</out>` +
          fileAudioXml +
          `<sourcetrack><mediatype>audio</mediatype><trackindex>1</trackindex></sourcetrack>` +
          links +
          `</clipitem>`,
      );
    });

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
