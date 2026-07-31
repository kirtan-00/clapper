// Applies a parsed backup envelope's bundle back onto THIS device, as a brand
// new project. Lives in store/ rather than export/ because it writes through
// the Store facade (export/ is deliberately UI-and-store-free — see the note
// atop export/order.ts) — src/export/backup.ts only builds/reads the file.
//
// The one rule that matters more than any field-preservation detail: a
// restore must never be able to touch data already on the device. The person
// running this has, by definition, already lost something — so every id in
// the incoming bundle (project, every slate, every shot, every take, every
// moment) is thrown away and reissued fresh, and every parent reference is
// remapped to match. Two restores of the exact same file, even on the same
// device, must land as two totally independent projects.

import type { Moment, Project, ProjectBundle, Slate, Take } from '../types';
import { store, rawPut } from './index';
import { markProjectDirty } from './outbox';
import { newId } from './util';

/**
 * Restore one backed-up project bundle as a new project. Returns the new
 * project on success. On any failure partway through, the partial project
 * (and everything already written under it) is deleted before the error is
 * rethrown — a restore that quietly leaves half a shoot behind is worse than
 * one that fails outright, because it *looks* like a working project in the
 * list right up until someone notices scenes are missing.
 */
export async function restoreBackup(bundle: ProjectBundle): Promise<Project> {
  let project: Project | undefined;
  try {
    project = await createRestoredProject(bundle);
    // Every shot gets its new id decided ONCE, up front — both the slate that
    // owns it (Slate.shots) and every take that names it (Take.shotId) have
    // to agree on the same new id, so this map is built a single time and
    // threaded through both passes rather than each minting its own.
    const shotIdMap = buildShotIdMap(bundle);
    const slateIdMap = await restoreSlates(bundle, project.id, shotIdMap);
    const takeIdMap = await restoreTakes(bundle, project.id, slateIdMap, shotIdMap);
    await restoreMoments(bundle, takeIdMap);
    return project;
  } catch (err) {
    if (project) {
      try {
        await store.deleteProject(project.id);
      } catch {
        /* best-effort cleanup — the thrown error below is what the caller needs to see */
      }
    }
    throw err;
  }
}

/**
 * id/createdAt/updatedAt are exactly the three fields `createProject` always
 * mints fresh (see store/index.ts). Everything else — counters, camera
 * units, sound, tags, the open shoot day — is the physical state of this
 * shoot and has to survive verbatim, or the restored project starts
 * disagreeing with cards that already exist. The name gets a suffix so the
 * restored copy is never mistaken for the original sitting next to it.
 */
async function createRestoredProject(bundle: ProjectBundle): Promise<Project> {
  const { id: _id, createdAt: _createdAt, updatedAt: _updatedAt, name, ...rest } = bundle.project;
  return store.createProject({ ...rest, name: `${name} (restored)` });
}

/** old shot id -> freshly minted id, covering every shot in every scene's breakdown. */
function buildShotIdMap(bundle: ProjectBundle): Map<string, string> {
  const map = new Map<string, string>();
  for (const slate of bundle.slates) {
    for (const shot of slate.shots ?? []) map.set(shot.id, newId());
  }
  return map;
}

/**
 * `createSlate` only takes a name (it derives id/order/timestamps itself), so
 * every other field — the shot breakdown, on-set shoot order, Script Mode
 * metadata, today's-call-sheet flag — has to follow as a second `updateSlate`
 * patch. Each optional field is copied across ONLY when the original slate
 * actually carried it: writing an explicit `undefined` into a patch leaves
 * the key present-but-empty in storage (see reassignTakeTo's note in
 * util.ts), which is a different, wrong thing from the field never having
 * existed. Returns old-slate-id -> new-slate-id, straight off each create's
 * own return value (no re-reading storage to guess the mapping back).
 */
async function restoreSlates(
  bundle: ProjectBundle,
  projectId: string,
  shotIdMap: Map<string, string>,
): Promise<Map<string, string>> {
  const slateIdMap = new Map<string, string>();
  const ordered = [...bundle.slates].sort((a, b) => a.order - b.order);

  for (const slate of ordered) {
    const created = await store.createSlate(projectId, slate.name);
    slateIdMap.set(slate.id, created.id);
    await store.updateSlate(created.id, buildSlatePatch(slate, shotIdMap));
  }
  return slateIdMap;
}

function buildSlatePatch(slate: Slate, shotIdMap: Map<string, string>): Partial<Slate> {
  // Story order is a plain required field, not an optional one, so it always
  // gets set explicitly — `createSlate` would otherwise reassign it to
  // "next in creation order", which only matches the original when nothing
  // was ever deleted or reordered upstream.
  const patch: Partial<Slate> = { order: slate.order };
  if (slate.shots !== undefined) {
    patch.shots = slate.shots.map((shot) => ({ ...shot, id: shotIdMap.get(shot.id) ?? shot.id }));
  }
  if (slate.shootOrder !== undefined) patch.shootOrder = slate.shootOrder;
  if (slate.summary !== undefined) patch.summary = slate.summary;
  if (slate.scriptRef !== undefined) patch.scriptRef = slate.scriptRef;
  if (slate.tags !== undefined) patch.tags = slate.tags;
  if (slate.today !== undefined) patch.today = slate.today;
  return patch;
}

/**
 * `Store.createTake` cannot express this: it MINTS a clip name off the
 * project's live counter and assigns its own take number. Every take in a
 * backup already carries the clip name a camera physically wrote — re-minting
 * it would hand the restored take a fabricated number that disagrees with the
 * card, and calling createTake once per take would ALSO advance the counter
 * bundle.takes.length times on top of the value already carried over
 * verbatim in createRestoredProject, overshooting it by exactly that count.
 * Neither the facade nor a straightforward "explicit clipName" overload of it
 * can express "write this exact row, don't touch the counter" — so takes go
 * in as fully-formed rows via `rawPut`, and the project is marked dirty by
 * hand afterwards (the same `markProjectDirty` call the facade's own internal
 * `dirty()` helper makes — see store/index.ts) so a later sign-in still
 * uploads them. This is the one place this feature reaches around the
 * facade; see the final report for why.
 */
async function restoreTakes(
  bundle: ProjectBundle,
  newProjectId: string,
  slateIdMap: Map<string, string>,
  shotIdMap: Map<string, string>,
): Promise<Map<string, string>> {
  const takeIdMap = new Map<string, string>();

  for (const take of bundle.takes) {
    const newSlateId = slateIdMap.get(take.slateId);
    if (!newSlateId) continue; // orphaned in the source bundle itself — never invent a home for it

    const newTakeId = newId();
    takeIdMap.set(take.id, newTakeId);

    const { id: _id, slateId: _slateId, shotId: oldShotId, projectId: _projectId, ...rest } = take;
    const restored: Take = {
      ...rest,
      id: newTakeId,
      slateId: newSlateId,
      projectId: newProjectId,
      ...(oldShotId !== undefined && shotIdMap.has(oldShotId) ? { shotId: shotIdMap.get(oldShotId)! } : {}),
    };
    await rawPut('takes', restored);
  }

  if (bundle.takes.length > 0) await markProjectDirty(newProjectId);
  return takeIdMap;
}

/**
 * Moments carry no counter and no physical filename — `createMoment` mints a
 * fresh id/createdAt/updatedAt exactly like every other moment ever logged,
 * so this is the one entity that fits the facade cleanly with zero
 * workaround. Orphaned moments (their take failed to remap above) are
 * dropped rather than attached to nothing.
 */
async function restoreMoments(bundle: ProjectBundle, takeIdMap: Map<string, string>): Promise<void> {
  for (const moment of bundle.moments) {
    const newTakeId = takeIdMap.get(moment.takeId);
    if (!newTakeId) continue;
    const payload: Omit<Moment, 'id' | 'createdAt' | 'updatedAt'> = {
      takeId: newTakeId,
      kind: moment.kind,
      atMs: moment.atMs,
      label: moment.label,
      ...(moment.endMs !== undefined ? { endMs: moment.endMs } : {}),
      ...(moment.tag !== undefined ? { tag: moment.tag } : {}),
    };
    await store.createMoment(payload);
  }
}
