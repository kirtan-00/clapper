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
