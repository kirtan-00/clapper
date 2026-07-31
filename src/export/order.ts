// Story ordering + shot lookup shared by every exporter (PDF, CSV, xmeml,
// FCPXML). This lives in ONE place because the ordering rule is subtle and was
// previously duplicated verbatim in fcpxml.ts and resolve.ts, which is exactly
// how the two drift apart.
//
// WHY a middle sort key exists at all: Take.number is per-SHOT when the take
// carries a shotId and per-SCENE when it does not (see types.ts). So inside one
// scene the numbers REPEAT - 5.31 has takes 1,2,3 and 5.32 starts at 1 again.
// Sorting by (scene, number) alone therefore interleaves setups on the
// timeline: 5.31/1, 5.32/1, 5.31/2, 5.32/2... The fix is scene order -> shot
// order -> take number.

import type { ProjectBundle, Shot, Take } from '../types';

/**
 * A take with no shot sorts BEFORE every shot-scoped take in its scene, so a
 * legacy scene (all takes ungrouped) keeps its exact original ordering and a
 * half-migrated scene puts its loose takes up top rather than scattering them.
 * An UNRESOLVABLE shotId gets the same value on purpose: it is treated exactly
 * as "no shot" everywhere - same sort slot, same empty code, same PDF group -
 * so an orphan take can never fall out of an export.
 */
const NO_SHOT = -1;

/**
 * Shot lookup scoped to the take's OWN slate. Shots are nested inside their
 * Slate (Slate.shots), so a shot id only ever means something within one scene;
 * resolving project-wide would let a stale id from another scene answer.
 */
export interface ShotIndex {
  /** The take's shot, or undefined when it has none / the id resolves to none. */
  of(take: Take): Shot | undefined;
}

export function buildShotIndex(bundle: ProjectBundle): ShotIndex {
  // slateId -> (shotId -> Shot). Built once per export, never per take.
  const bySlate = new Map<string, Map<string, Shot>>();
  for (const slate of bundle.slates) {
    if (!slate.shots || slate.shots.length === 0) continue; // legacy scene: nothing to index
    bySlate.set(slate.id, new Map(slate.shots.map((s) => [s.id, s])));
  }
  return {
    of(take: Take): Shot | undefined {
      if (!take.shotId) return undefined;
      return bySlate.get(take.slateId)?.get(take.shotId);
    },
  };
}

/** Position of the take's shot within its scene; NO_SHOT when it has none. */
export function shotOrderOf(take: Take, index: ShotIndex): number {
  return index.of(take)?.order ?? NO_SHOT;
}

/**
 * The shot code exactly as printed on the shotlist ("5.31"), or '' when the
 * take is not scoped to a shot. Always '' rather than undefined so every call
 * site can drop it straight into a cell / filter(Boolean) join.
 */
export function shotCodeOf(take: Take, index: ShotIndex): string {
  return index.of(take)?.code ?? '';
}

/**
 * The one comparator: scene order -> shot order -> take number. Build it ONCE
 * per export (it closes over two prebuilt maps) and hand it to .sort().
 *
 * A project with no shots at all makes the middle key constant (NO_SHOT for
 * every take), so this reduces exactly to the original (scene, number) sort and
 * such a project's exports are unchanged.
 */
export function compareTakesInStoryOrder(bundle: ProjectBundle): (a: Take, b: Take) => number {
  const slateOrder = new Map(
    [...bundle.slates].sort((a, b) => a.order - b.order).map((s, i) => [s.id, i]),
  );
  const shots = buildShotIndex(bundle);
  return (a, b) => {
    // A take whose slate is missing from the bundle sorts last rather than
    // vanishing - same defensive default the exporters have always used.
    const sa = slateOrder.get(a.slateId) ?? Number.MAX_SAFE_INTEGER;
    const sb = slateOrder.get(b.slateId) ?? Number.MAX_SAFE_INTEGER;
    if (sa !== sb) return sa - sb;
    const oa = shotOrderOf(a, shots);
    const ob = shotOrderOf(b, shots);
    if (oa !== ob) return oa - ob;
    return a.number - b.number;
  };
}

/** Good takes in story order (scene -> shot -> take). */
export function goodTakesInStoryOrder(bundle: ProjectBundle): Take[] {
  return bundle.takes.filter((t) => t.status === 'good').sort(compareTakesInStoryOrder(bundle));
}

/** All takes (good AND bad) in story order (scene -> shot -> take). */
export function allTakesInStoryOrder(bundle: ProjectBundle): Take[] {
  return [...bundle.takes].sort(compareTakesInStoryOrder(bundle));
}

// ------------------------------------------------------------ shoot day ---
// Shared by every exporter that needs to show or key on a take's shoot day.
// Mirrors store/util.ts's shootDayLabel exactly (same "local YYYY-MM-DD"
// convention) but is defined independently here rather than imported — export/
// stays UI-and-store-free, and this is three lines, not worth a cross-layer
// dependency for.

/** Local "YYYY-MM-DD" for a moment in time. */
function localDateLabel(epochMs: number): string {
  const d = new Date(epochMs);
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${y}-${m}-${day}`;
}

/**
 * The take's shoot day for DISPLAY ONLY (the CSV/PDF DATE column): the real
 * stamped day when present, else a best-effort label derived from when the
 * take was logged. This is the migration the task describes — read-time only,
 * never written back to the take (see store/util.ts's noteTakeLogged and the
 * migration note there).
 *
 * NEVER use this for the FCPXML/Resolve asset identity or reel/tape name
 * below: those key strictly on the real `take.shootDay` field, so a legacy
 * take (no shootDay at all) never gets a synthetic reel/asset split it did
 * not have before. Using the derived fallback there would give every legacy
 * take a "day" it never had and break the byte-identical guarantee.
 */
export function displayShootDay(take: Take): string {
  return take.shootDay ?? localDateLabel(take.startedAt);
}

/** "2026-07-31" -> "20260731", for filenames and reel/tape names. */
export function compactDate(dateLabel: string): string {
  return dateLabel.replace(/-/g, '');
}

const SHORT_MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

/**
 * "2026-07-31" -> "31 Jul" - the compact display form shared by the PDF's
 * DATE column and the project screen's shoot-day line ("DAY 3 · 31 Jul · 47
 * takes"). No year: within one shoot, the year is never the ambiguous part.
 */
export function shortDateLabel(dateLabel: string): string {
  const [, m, d] = dateLabel.split('-').map(Number);
  return `${d} ${SHORT_MONTHS[(m ?? 1) - 1] ?? ''}`.trim();
}

/**
 * The date an export filename carries: the project's open shoot day when it
 * has one (what the crew would call "today"), else today's own date — so a
 * project that has never touched Shoot day still gets a sensible stamp
 * rather than nothing.
 */
export function exportDateStamp(project: Pick<ProjectBundle['project'], 'openShootDay'>): string {
  return compactDate(project.openShootDay?.date ?? localDateLabel(Date.now()));
}

// -------------------------------------------------- shoot-day disambiguation ---
// A night shoot can wrap into a next day dated today, and if THAT day is
// itself shot and wrapped before midnight, it opens ANOTHER day carrying the
// exact same date string (see Take.shootDayIndex in types.ts). `shootDay`
// alone is therefore not a stable day identity; every dedupe key AND every
// human-visible reel/tape name / Resolve `src` path below both exporters emit
// has to fold the day's own index in too, or two different physical days'
// C0001 collapse into one file and silently relink the editor to the wrong
// card. Shared here (not duplicated in fcpxml.ts/resolve.ts) because it is
// exactly the kind of thing that drifted apart before order.ts existed.

/** Anything carrying a take's (or a registered export asset's) day stamp. */
export interface DayStamped {
  shootDay?: string;
  shootDayIndex?: number;
}

/**
 * The discriminator export dedupe keys fold in alongside filename (and, for
 * multi-cam, unit letter) to tell two shoot days apart. The day's own INDEX
 * wins when we have it — it is the true identity, unlike the date string.
 * Falls back to the bare date for a take stamped before this fix existed
 * (`shootDay` only, no index yet) so THAT take keeps colliding exactly as it
 * did the day before this fix shipped. '' for a take with neither, so two
 * legacy takes (no day tracking at all) still collapse into one file/asset —
 * the original, pre-feature behaviour, untouched.
 */
export function shootDayKey(stamped: DayStamped): string {
  if (stamped.shootDayIndex !== undefined) return `D${stamped.shootDayIndex}`;
  return stamped.shootDay ?? '';
}

/**
 * The human-readable suffix appended to a reel/tape name or Resolve `src`
 * path, e.g. "_20260731_D3" — a person reading the NLE, not just the dedupe
 * key, needs to be able to tell two same-dated days apart too. '' when there
 * is no shootDay at all (nothing to disambiguate, byte-identical to before
 * this feature existed). Just the compact date, no `_D` tail, when the take
 * has `shootDay` but no `shootDayIndex` — a take stamped before THIS fix —
 * so its reel name prints exactly what it always has.
 */
export function shootDaySuffix(stamped: DayStamped): string {
  if (!stamped.shootDay) return '';
  const datePart = `_${compactDate(stamped.shootDay)}`;
  return stamped.shootDayIndex !== undefined ? `${datePart}_D${stamped.shootDayIndex}` : datePart;
}
