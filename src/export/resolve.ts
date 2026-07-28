// FCPXML (the Final Cut Pro X interchange format, DTD `fcpxml`) export for
// DaVinci Resolve.
//
// WHY FCPXML over the other candidates Resolve can ingest:
//
//   - Legacy FCP7 xmeml (fcpxml.ts, already emitted for "Premiere") MAY
//     already partly open in Resolve - Resolve's "Import AAF, EDL, XML..."
//     dialog reads that format too. It was rejected as the dedicated Resolve
//     deliverable because its <link>-based linked-track shape (what our
//     multi-cam pass emits) is exercised far more by Premiere/FCP7 than by
//     Resolve, and we have no way to confirm Resolve's parser round-trips it
//     correctly without opening Resolve. FCPXML is the format Resolve's own
//     interchange docs lean on for anything past a flat single-track cut.
//   - CMX3600 EDL was rejected: reel/event names are truncated to 8
//     characters in the strict spec (our clip names can run longer), it has
//     no real multi-track concept for stacking A-D camera units (classic EDL
//     is effectively A/B-roll, two tracks), and per-clip text markers only
//     exist as the informal Avid "* LOC" comment convention, not a real field.
//     It IS the most universally-read format of the three, but it cannot
//     faithfully carry our data.
//   - ALE / CSV metadata sidecars were rejected outright: they carry
//     metadata, not a cuttable timeline, so on their own they cannot
//     reproduce the two-band story-cut + selects-pool structure at all.
//
// FCPXML gives us two things natively that the alternatives do not: a real
// <marker> element per clip (value + note, frame-accurate start/duration),
// and the `lane` attribute for stacking synced camera angles at one offset -
// a close structural fit for our A-D multi-cam takes.
//
// STRUCTURE mirrors fcpxml.ts: SINGLE-CAM (project.cameras absent/<2, one
// lane, no stacking) and MULTI-CAM (2-4 units) share this one generator,
// switching on `isMultiCam`. Two passes, same rule as the rest of this app:
// GOOD takes in story order, a GAP_SECONDS gap - an explicit <gap> spine
// element here rather than xmeml's implicit blank timeline space - then
// EVERY take (good and bad) as a selects pool. A take that appears in both
// passes references the SAME <asset> resource both times: FCPXML always
// references media by id (never inlines a file), so there is no separate
// "first sight vs later reference" bookkeeping the way the xmeml dedup needs.
//
// NOT DONE: a true FCPX <media> multicam-clip resource - the thing that would
// give Resolve its own "Camera 1/2/3/4" angle switcher on import. Authoring a
// valid mc-angle multicam clip correctly is a materially bigger, harder to
// validate structure, and we cannot confirm it imports right without a real
// Resolve install. Lane-stacked connected clips are simpler, are unambiguous,
// spec-legal FCPXML, and still land every angle in sync at the correct
// offset for the editor to look at and group by hand.

import type { CameraUnitLetter, Fps, Moment, ProjectBundle, Take, TakeClip } from '../types';
import { isMultiCam } from '../types';
import { tc } from './timecode';
// Shared with fcpxml.ts - these two used to carry byte-identical private copies
// of the ordering helpers, so a fix to one silently missed the other.
import { allTakesInStoryOrder, buildShotIndex, goodTakesInStoryOrder, shotCodeOf } from './order';

const GAP_SECONDS = 3; // same breathing room as the Premiere (xmeml) export

function escapeXml(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;');
}

/** ms -> exact frame count, routed through the shared `tc` helper (never
 *  hand-rolled here) so drop-frame 29.97/59.94 math stays in exactly one
 *  place in the codebase: round-tripping ms -> timecode string -> frames
 *  recovers the same integer frame count msToFrames() would, because the
 *  drop-frame compensation tc applies going out is exactly inverted coming
 *  back in. */
function msToFrames(ms: number, fps: Fps): number {
  return tc.timecodeToFrames(tc.msToTimecode(ms, fps), fps);
}

function isDropFrame(fps: Fps): boolean {
  return fps === 29.97 || fps === 59.94;
}

/** FCPXML <format> frameDuration as an exact rational, e.g. 23.976 -> 1001/24000s. */
function frameDuration(fps: Fps): { num: number; den: number } {
  if (fps === 23.976) return { num: 1001, den: 24000 };
  if (fps === 29.97) return { num: 1001, den: 30000 };
  if (fps === 59.94) return { num: 1001, den: 60000 };
  return { num: 1, den: fps };
}

/** frame count -> FCPXML rational time string, e.g. 48 frames @ 24fps -> "48/24s". */
function framesToRational(frames: number, fd: { num: number; den: number }): string {
  return `${frames * fd.num}/${fd.den}s`;
}

/** One camera "unit" as far as this exporter cares: a letter plus its ext.
 *  Single-cam projects get one synthetic unit ("A") built from the project's
 *  own clip fields, so the rest of the generator never has to branch on
 *  single vs multi. */
interface Unit {
  letter: CameraUnitLetter;
  clipExt?: string;
}

function unitsOf(bundle: ProjectBundle): Unit[] {
  const { project } = bundle;
  if (isMultiCam(project)) {
    return (project.cameras ?? []).map((u) => ({ letter: u.letter, clipExt: u.clipExt }));
  }
  return [{ letter: 'A', clipExt: project.clipExt }];
}

function clipNameFor(take: Take, unit: Unit, multi: boolean): string | undefined {
  if (!multi) return take.clipName;
  return take.clips?.find((c) => c.unit === unit.letter)?.clipName;
}

export function toResolveXml(bundle: ProjectBundle): Blob {
  const { project, moments } = bundle;
  const fps = project.fps;
  const multi = isMultiCam(project);
  const units = unitsOf(bundle);
  const fd = frameDuration(fps);
  const tcFormat = isDropFrame(fps) ? 'DF' : 'NDF';
  const timebase = Math.round(fps);

  const momentsByTake = new Map<string, Moment[]>();
  for (const m of moments) {
    const list = momentsByTake.get(m.takeId) ?? [];
    list.push(m);
    momentsByTake.set(m.takeId, list);
  }

  const shotIndex = buildShotIndex(bundle);

  // ------------------------------------------------------------ resources --
  // One <asset> per distinct (clipName, unit) card, registered once up front.
  // Both bands of a good take - and both passes' worth of any take at all -
  // reference the SAME asset id; FCPXML always references media by id, so
  // there's nothing else to dedup.
  interface AssetEntry {
    id: string;
    clipName: string;
    ext: string;
    unitLetter: CameraUnitLetter;
    durationFrames: number;
  }
  const assets = new Map<string, AssetEntry>(); // key: `${clipName}|${unit.letter}`
  let assetSeq = 0;

  for (const take of allTakesInStoryOrder(bundle)) {
    for (const unit of units) {
      const clipName = clipNameFor(take, unit, multi);
      if (!clipName) continue;
      const key = `${clipName}|${unit.letter}`;
      if (!assets.has(key)) {
        // The asset's own registered duration is THAT unit's own recorded
        // roll length where we have it (a unit that joined late or cut early
        // only really ran for part of the take), falling back to the take's
        // overall duration for pre-timing saved takes.
        const ownMs = multi ? take.clips?.find((c) => c.unit === unit.letter)?.durationMs : undefined;
        const durationFrames = Math.max(1, msToFrames(ownMs ?? take.durationMs, fps));
        assets.set(key, {
          id: `a${(assetSeq += 1)}`,
          clipName,
          ext: unit.clipExt ?? '',
          unitLetter: unit.letter,
          durationFrames,
        });
      }
    }
  }

  /** This unit's own clip on `take`, or undefined if it never rolled it. */
  function clipOf(take: Take, unit: Unit): TakeClip | undefined {
    if (!multi) return undefined;
    return take.clips?.find((c) => c.unit === unit.letter);
  }

  // Production sound: one <asset> per distinct recorder file, registered up
  // front exactly like the camera assets above - both bands of a good take
  // reference the same asset id. Absent entirely when the project has no
  // Sound unit, so a legacy project's spine never gains a sound lane.
  interface SoundAssetEntry {
    id: string;
    fileName: string;
    ext: string;
    durationFrames: number;
  }
  const soundAssets = new Map<string, SoundAssetEntry>(); // key: take.sound.fileName
  let soundAssetSeq = 0;

  if (project.sound) {
    for (const take of allTakesInStoryOrder(bundle)) {
      if (!take.sound) continue;
      const key = take.sound.fileName;
      if (soundAssets.has(key)) continue;
      const durationFrames = Math.max(1, msToFrames(take.sound.durationMs ?? take.durationMs, fps));
      soundAssets.set(key, {
        id: `s${(soundAssetSeq += 1)}`,
        fileName: key,
        ext: project.sound.fileExt ?? '',
        durationFrames,
      });
    }
  }

  // ---------------------------------------------------------------- spine --
  // `anchorOffsetMs`/`anchorDurationFrames` are the anchor clip's OWN local
  // timeline - a moment's atMs (relative to the TAKE start) has to be
  // re-based onto the anchor's own start before it means anything as a
  // marker inside that asset-clip.
  function markersXml(take: Take, anchorOffsetMs: number, anchorDurationFrames: number): string {
    // The asset-clip `name` stays the raw camera clip name (that is what an
    // editor relinks on) and `src` is a physical path - so the MARKER is the
    // only field that can tell the editor which setup a beat belongs to.
    // Prefix the shot code, e.g. value="5.31 GOLD the look". '' for a take with
    // no shot, so these joins emit exactly what they did before shots existed.
    const code = shotCodeOf(take, shotIndex);
    return (momentsByTake.get(take.id) ?? [])
      .slice()
      .sort((a, b) => a.atMs - b.atMs)
      .map((m) => {
        const value = [code, m.tag, m.label].filter(Boolean).join(' ') || 'Marker';
        const noteText = [code, m.label].filter(Boolean).join(' ');
        const startFrame = Math.min(
          Math.max(0, msToFrames(m.atMs - anchorOffsetMs, fps)),
          Math.max(0, anchorDurationFrames - 1),
        );
        // FCPXML markers are fundamentally a point in time; a range moment's
        // span is carried as `duration` on a best-effort basis - most NLE UIs
        // (Resolve included, as far as we can tell without testing) still
        // just draw the flag at `start` and ignore the span visually.
        const durFrames =
          m.kind === 'range' && m.endMs !== undefined
            ? Math.max(1, msToFrames(m.endMs - anchorOffsetMs, fps) - startFrame)
            : 1;
        const note = noteText ? ` note="${escapeXml(noteText)}"` : '';
        return (
          `          <marker start="${framesToRational(startFrame, fd)}" ` +
          `duration="${framesToRational(durFrames, fd)}" value="${escapeXml(value)}"${note}/>`
        );
      })
      .join('\n');
  }

  const spineItems: string[] = [];

  /**
   * Lay one take at `startFrames`; returns the WHOLE take's duration in
   * frames (unaffected by any one unit's own timing, so takes stay
   * back-to-back regardless of which cameras rolled).
   *
   * Each unit's own clip sits at `startFrames` + its own startOffsetMs and
   * runs its own durationMs. The anchor - the unit that started earliest
   * (offset 0 in the common case), camera-letter order breaking ties, so a
   * single-cam-shaped multi-cam take keeps anchoring on A - carries the
   * spine position; every other unit that rolled this take rides as a lane
   * child, offset by the DIFFERENCE between its own start and the anchor's.
   */
  function placeTake(take: Take, startFrames: number): number {
    const takeDurationFrames = Math.max(1, msToFrames(take.durationMs, fps));
    const offsetStr = framesToRational(startFrames, fd);
    const takeDurationStr = framesToRational(takeDurationFrames, fd);

    let anchor: Unit | undefined;
    let anchorOffsetMs = 0;
    for (const u of units) {
      const clip = clipOf(take, u);
      const cn = multi ? clip?.clipName : clipNameFor(take, u, multi);
      if (!cn) continue;
      const offset = multi ? clip?.startOffsetMs ?? 0 : 0;
      if (anchor === undefined || offset < anchorOffsetMs) {
        anchor = u;
        anchorOffsetMs = offset;
      }
    }

    if (!anchor) {
      // No camera at all logged a clip for this take - keep the timeline
      // math intact with a bare gap rather than silently shortening the
      // sequence (mirrors the defensive `if (!clip) return;` in fcpxml.ts).
      spineItems.push(
        `        <gap offset="${offsetStr}" duration="${takeDurationStr}" name="${escapeXml(take.clipName || 'missing take')}"/>`,
      );
      return takeDurationFrames;
    }

    const anchorClip = clipNameFor(take, anchor, multi)!;
    const anchorId = assets.get(`${anchorClip}|${anchor.letter}`)!.id;
    const anchorClipInfo = clipOf(take, anchor);
    const anchorDurationFrames = Math.max(
      1,
      msToFrames(anchorClipInfo?.durationMs ?? take.durationMs, fps),
    );
    const anchorDurationStr = framesToRational(anchorDurationFrames, fd);
    const anchorStartFrames = startFrames + msToFrames(anchorOffsetMs, fps);
    const anchorOffsetStr = framesToRational(anchorStartFrames, fd);

    // Beats belong to the take, not one angle - carried on the anchor clip
    // only. Same rule fcpxml.ts's multi-cam pass uses for its <marker>s.
    const markers = markersXml(take, anchorOffsetMs, anchorDurationFrames);

    const laneChildren: string[] = [];
    let lane = 0;
    for (const u of units) {
      if (u === anchor) continue;
      const clip = clipOf(take, u);
      const cn = multi ? clip?.clipName : clipNameFor(take, u, multi);
      if (!cn) continue;
      lane += 1;
      const id = assets.get(`${cn}|${u.letter}`)!.id;
      const offsetMs = (multi ? clip?.startOffsetMs ?? 0 : 0) - anchorOffsetMs;
      const durationFrames = Math.max(1, msToFrames((multi ? clip?.durationMs : undefined) ?? take.durationMs, fps));
      laneChildren.push(
        `          <asset-clip ref="${id}" lane="${lane}" offset="${framesToRational(Math.max(0, msToFrames(offsetMs, fps)), fd)}" name="${escapeXml(cn)}" duration="${framesToRational(durationFrames, fd)}" start="0s"/>`,
      );
    }

    // Sound rides as one more lane, offset the same way a picture unit that
    // started off-anchor would be - relative to the anchor's own start, not
    // the sequence start.
    if (project.sound && take.sound) {
      const soundAsset = soundAssets.get(take.sound.fileName);
      if (soundAsset) {
        lane += 1;
        const soundOffsetMs = (take.sound.startOffsetMs ?? 0) - anchorOffsetMs;
        const soundDurationFrames = Math.max(1, msToFrames(take.sound.durationMs ?? take.durationMs, fps));
        laneChildren.push(
          `          <asset-clip ref="${soundAsset.id}" lane="${lane}" offset="${framesToRational(Math.max(0, msToFrames(soundOffsetMs, fps)), fd)}" name="${escapeXml(soundAsset.fileName)}" duration="${framesToRational(soundDurationFrames, fd)}" start="0s"/>`,
        );
      }
    }

    const inner = [markers, laneChildren.join('\n')].filter(Boolean).join('\n');
    spineItems.push(
      inner
        ? `        <asset-clip ref="${anchorId}" offset="${anchorOffsetStr}" name="${escapeXml(anchorClip)}" duration="${anchorDurationStr}" start="0s">\n${inner}\n        </asset-clip>`
        : `        <asset-clip ref="${anchorId}" offset="${anchorOffsetStr}" name="${escapeXml(anchorClip)}" duration="${anchorDurationStr}" start="0s"/>`,
    );
    return takeDurationFrames;
  }

  // Pass 1: GOOD takes, story order, back-to-back from 0.
  let pos = 0;
  for (const take of goodTakesInStoryOrder(bundle)) pos += placeTake(take, pos);
  const storyEnd = pos;

  // Gap, then Pass 2: EVERY take (good and bad) as a selects pool. The gap is
  // an explicit spine element - FCPXML has no notion of implicit blank space
  // the way an xmeml track does.
  const gapFrames = Math.max(1, Math.round(timebase * GAP_SECONDS));
  spineItems.push(
    `        <gap offset="${framesToRational(storyEnd, fd)}" duration="${framesToRational(gapFrames, fd)}" name="Selects pool gap"/>`,
  );
  let sel = storyEnd + gapFrames;
  for (const take of allTakesInStoryOrder(bundle)) sel += placeTake(take, sel);
  const seqDurationFrames = Math.max(1, sel);

  // -------------------------------------------------------------- output ---
  const resourceLines: string[] = [
    `    <format id="r1" name="ClapperFormat" frameDuration="${fd.num}/${fd.den}s" width="1920" height="1080"/>`,
  ];
  for (const entry of assets.values()) {
    const fileName = escapeXml(entry.clipName + entry.ext);
    // FCPXML has no equivalent of xmeml's <reel> tape name, and two camera
    // units natively write identically-named files - so a bare filename here
    // would give two DIFFERENT physical clips the exact same src URL, which
    // risks Resolve (or the editor's own manual relink) treating them as one
    // asset. Nest multi-cam assets under a per-unit-letter path segment so
    // every asset's src is unique; single-cam keeps the plain filename since
    // there is only ever one card and nothing to disambiguate.
    const srcPath = multi ? `${escapeXml(entry.unitLetter)}/${fileName}` : fileName;
    resourceLines.push(
      `    <asset id="${entry.id}" name="${escapeXml(entry.clipName)}" start="0s" duration="${framesToRational(entry.durationFrames, fd)}" hasVideo="1" hasAudio="1" audioSources="1" audioChannels="2" format="r1">
      <media-rep kind="original-media" src="file:///${srcPath}"/>
    </asset>`,
    );
  }
  for (const entry of soundAssets.values()) {
    const fileName = escapeXml(entry.fileName + entry.ext);
    // Sound files live under their own "SND/" path segment, same disambiguation
    // trick as the per-unit-letter nesting above - it also keeps a recorder
    // file that happens to share a name with a picture clip from colliding.
    const srcPath = `SND/${fileName}`;
    resourceLines.push(
      `    <asset id="${entry.id}" name="${escapeXml(entry.fileName)}" start="0s" duration="${framesToRational(entry.durationFrames, fd)}" hasVideo="0" hasAudio="1" audioSources="1" audioChannels="2" format="r1">
      <media-rep kind="original-media" src="file:///${srcPath}"/>
    </asset>`,
    );
  }

  const xml = `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE fcpxml>
<fcpxml version="1.9">
  <resources>
${resourceLines.join('\n')}
  </resources>
  <library>
    <event name="${escapeXml(project.name)}">
      <project name="${escapeXml(project.name)}">
        <sequence format="r1" tcStart="0s" tcFormat="${tcFormat}" duration="${framesToRational(seqDurationFrames, fd)}">
          <spine>
${spineItems.join('\n')}
          </spine>
        </sequence>
      </project>
    </event>
  </library>
</fcpxml>
`;

  return new Blob([xml], { type: 'application/xml' });
}
