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
import { mediaPath } from './paths';
import { isMultiCam } from '../types';
import { tc } from './timecode';
// Shared with fcpxml.ts - these two used to carry byte-identical private copies
// of the ordering helpers, so a fix to one silently missed the other.
import {
  allTakesInStoryOrder,
  buildShotIndex,
  goodTakesInStoryOrder,
  shootDayKey,
  shootDaySuffix,
  shotCodeOf,
} from './order';

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
  return clipsFor(take, unit)[0]?.clipName;
}

/**
 * Every file `unit` wrote on `take`, in the order it wrote them. Normally one -
 * but a camera that cut and rejoined while the others kept rolling closed one
 * file and opened another inside the same take, and each is a real card the
 * editor has to relink. Multi-cam only: single-cam carries its one clip in
 * `take.clipName`, not in `clips`.
 */
function clipsFor(take: Take, unit: Unit): TakeClip[] {
  return (take.clips ?? [])
    .filter((c) => c.unit === unit.letter)
    .sort((a, b) => (a.startOffsetMs ?? 0) - (b.startOffsetMs ?? 0));
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
    // The shoot day this card belongs to, when the take that first registered
    // it had one - carried through so the resource block below can fold it
    // into the asset's src path. Absent for a legacy take, same as the field
    // it comes from.
    shootDay?: string;
    // The day INDEX alongside the date: two different shoot days can carry the
    // SAME date string (a night shoot wrapped after midnight, then wrapped
    // again that evening), so the date alone is not a day identity - see
    // Take.shootDayIndex in types.ts.
    shootDayIndex?: number;
  }
  // key: `${clipName}|${unit.letter}|${shootDayKey(take)}`. Every shoot day
  // restarts at C0001, so clipName+unit ALONE is not a stable identity across
  // days - day 1's A/C0001 and day 5's A/C0001 would collapse into one
  // <asset> (one `src`) without the day in the key, silently relinking the
  // editor to the wrong physical file. A legacy take (no shootDay) keys
  // exactly as this used to: one shared bucket, nothing changes.
  const assets = new Map<string, AssetEntry>();
  let assetSeq = 0;

  for (const take of allTakesInStoryOrder(bundle)) {
    for (const unit of units) {
      // Every file this unit wrote on this take gets its own <asset>. A camera
      // that cut and rejoined wrote two physical cards inside one take, and
      // registering only the first would leave the second unrelinkable.
      const own: Array<{ clipName: string; durationMs?: number }> = multi
        ? clipsFor(take, unit)
        : [{ clipName: take.clipName }];
      for (const clip of own) {
        const clipName = clip.clipName;
        if (!clipName) continue;
        const key = `${clipName}|${unit.letter}|${shootDayKey(take)}`;
        if (assets.has(key)) continue;
        // The asset's own registered duration is THAT unit's own recorded
        // roll length where we have it (a unit that joined late or cut early
        // only really ran for part of the take), falling back to the take's
        // overall duration for pre-timing saved takes.
        const durationFrames = Math.max(1, msToFrames(clip.durationMs ?? take.durationMs, fps));
        assets.set(key, {
          id: `a${(assetSeq += 1)}`,
          clipName,
          ext: unit.clipExt ?? '',
          unitLetter: unit.letter,
          durationFrames,
          ...(take.shootDay !== undefined ? { shootDay: take.shootDay } : {}),
          ...(take.shootDayIndex !== undefined ? { shootDayIndex: take.shootDayIndex } : {}),
        });
      }
    }
  }

  /** This unit's FIRST clip on `take`, or undefined if it never rolled it. */
  function clipOf(take: Take, unit: Unit): TakeClip | undefined {
    if (!multi) return undefined;
    return clipsFor(take, unit)[0];
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
    shootDay?: string;      // same day-carrying rationale as AssetEntry above
    shootDayIndex?: number; // ditto - the date alone is not a day identity
  }
  // key: `${fileName}|${shootDayKey(take)}` - same collision as the picture
  // assets above: SND_0001 resets every shoot day, so the bare file name
  // alone is not a stable identity across days.
  const soundAssets = new Map<string, SoundAssetEntry>();
  let soundAssetSeq = 0;

  if (project.sound) {
    for (const take of allTakesInStoryOrder(bundle)) {
      if (!take.sound) continue;
      const fileName = take.sound.fileName;
      const key = `${fileName}|${shootDayKey(take)}`;
      if (soundAssets.has(key)) continue;
      const durationFrames = Math.max(1, msToFrames(take.sound.durationMs ?? take.durationMs, fps));
      soundAssets.set(key, {
        id: `s${(soundAssetSeq += 1)}`,
        fileName,
        ext: project.sound.fileExt ?? '',
        durationFrames,
        ...(take.shootDay !== undefined ? { shootDay: take.shootDay } : {}),
          ...(take.shootDayIndex !== undefined ? { shootDayIndex: take.shootDayIndex } : {}),
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
    const anchorId = assets.get(`${anchorClip}|${anchor.letter}|${shootDayKey(take)}`)!.id;
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
      // One lane per CAMERA, not per clip - a unit that cut and rejoined puts
      // both of its files on its own lane, back to back with the hole between
      // them, which is how the editor sees that camera going down and coming
      // back. The anchor's FIRST clip is the spine element itself, so only
      // what it rolled AFTER rejoining needs a lane of its own.
      const own = multi
        ? u === anchor
          ? clipsFor(take, u).slice(1)
          : clipsFor(take, u)
        : u === anchor
          ? []
          : [{ clipName: clipNameFor(take, u, multi) ?? '', startOffsetMs: 0, durationMs: undefined }];
      const usable = own.filter((c) => c.clipName);
      if (usable.length === 0) continue;
      lane += 1;
      for (const clip of usable) {
        const cn = clip.clipName;
        const id = assets.get(`${cn}|${u.letter}|${shootDayKey(take)}`)!.id;
        const offsetMs = (clip.startOffsetMs ?? 0) - anchorOffsetMs;
        const durationFrames = Math.max(1, msToFrames(clip.durationMs ?? take.durationMs, fps));
        laneChildren.push(
          `          <asset-clip ref="${id}" lane="${lane}" offset="${framesToRational(Math.max(0, msToFrames(offsetMs, fps)), fd)}" name="${escapeXml(cn)}" duration="${framesToRational(durationFrames, fd)}" start="0s"/>`,
        );
      }
    }

    // Sound rides as one more lane, offset the same way a picture unit that
    // started off-anchor would be - relative to the anchor's own start, not
    // the sequence start.
    if (project.sound && take.sound) {
      const soundAsset = soundAssets.get(`${take.sound.fileName}|${shootDayKey(take)}`);
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
    // FCPXML has no equivalent of xmeml's <reel> tape name, and two camera
    // units natively write identically-named files - so a bare filename here
    // would give two DIFFERENT physical clips the exact same src URL, which
    // risks Resolve (or the editor's own manual relink) treating them as one
    // asset. Nest multi-cam assets under a per-unit-letter path segment so
    // every asset's src is unique.
    //
    // The SAME clash happens across shoot days now that every day restarts at
    // C0001 - day 1's A/C0001 and day 5's A/C0001 would otherwise share this
    // exact path. Fold the day into the segment too, e.g. "A_20260731/", but
    // ONLY when the take that registered this asset actually has one: a
    // legacy take (no shootDay) gets exactly the path it always did - plain
    // filename for single-cam, plain unit-letter folder for multi-cam.
    const dateSuffix = shootDaySuffix(entry);
    // Built from the RAW name, not the XML-escaped one: this is a URL, so a
    // space or a "#" in a card name has to be percent-encoded, not entity-escaped.
    const rawFile = entry.clipName + entry.ext;
    // The editor's own footage root sits ABOVE the unit folder, exactly as it
    // does in fcpxml.ts. This exporter used to ignore project.mediaRoot
    // outright: a project that had gone to the trouble of setting the root
    // still handed Resolve "file:///A_20260731/C0001.MP4", which resolves to
    // the boot volume, where nothing ever is - the same offline-import
    // failure the field was added to fix, just in the other exporter. With
    // no root set nothing changes: the paths below are what they always were.
    const root = project.mediaRoot?.trim();
    const srcPath = multi
      ? mediaPath(root, `${entry.unitLetter}${dateSuffix}`, rawFile)
      : entry.shootDay
        ? mediaPath(root, `A${dateSuffix}`, rawFile)
        : mediaPath(root, rawFile);
    resourceLines.push(
      `    <asset id="${entry.id}" name="${escapeXml(entry.clipName)}" start="0s" duration="${framesToRational(entry.durationFrames, fd)}" hasVideo="1" hasAudio="1" audioSources="1" audioChannels="2" format="r1">
      <media-rep kind="original-media" src="file:///${srcPath}"/>
    </asset>`,
    );
  }
  for (const entry of soundAssets.values()) {
    // Sound files live under their own "SND/" path segment, same disambiguation
    // trick as the per-unit-letter nesting above - it also keeps a recorder
    // file that happens to share a name with a picture clip from colliding.
    // Same day-fold as the picture assets: absent for a legacy take (no
    // shootDay), so its path stays exactly "SND/...".
    //
    // Sound deliberately does NOT read mediaRoot, matching fcpxml.ts: a
    // recorder writes to its own card, not into the camera's folder, so
    // nesting SND under the picture root would point Resolve confidently at
    // a directory that does not exist. Sound keeps its reel folder until it
    // gets a root of its own.
    const dateSuffix = shootDaySuffix(entry);
    const srcPath = mediaPath(`SND${dateSuffix}`, entry.fileName + entry.ext);
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
