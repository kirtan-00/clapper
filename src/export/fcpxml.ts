// FCP7 xmeml (version 5) export. Premiere Pro imports this natively:
// one sequence at project fps, one clipitem per GOOD take laid back-to-back
// on video track 1, offline <file> children the editor relinks, and one
// <marker> per moment.

import type { Fps, Moment, ProjectBundle, Take } from '../types';

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

export function toFcpXml(bundle: ProjectBundle): Blob {
  const { project, slates, takes, moments } = bundle;
  const fps = project.fps;
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
            <name>${name}</name>
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
