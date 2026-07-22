// Sanity tests for the on-set shoot-order helpers (src/store/util.ts):
// sortForDisplay, moveItem, reorderSlateList.
// Run: node --experimental-strip-types scripts/test-shootorder.mjs
// Same one-off style as scripts/test-rebase.mjs; no test framework in this
// project.

import { sortForDisplay, moveItem, reorderSlateList } from '../src/store/util.ts';

let pass = 0;
const fails = [];

function eq(label, actual, expected) {
  const a = JSON.stringify(actual);
  const e = JSON.stringify(expected);
  if (a === e) pass++;
  else fails.push(`${label}\n    expected ${e}\n    actual   ${a}`);
}

// ---------------------------------------------------------------- fixtures --

/** Five scenes in story order, no shootOrder anywhere — the pre-drag shape
 * every project (new or legacy-saved) starts in. */
function fiveScenes() {
  return ['s1', 's2', 's3', 's4', 's5'].map((id, i) => ({
    id,
    projectId: 'p1',
    name: `Scene ${i + 1}`,
    order: i,
    createdAt: i,
    updatedAt: i,
  }));
}

const ids = (slates) => slates.map((s) => s.id);

/** Apply reorderSlateList's changed-patches onto the full list, as the store does. */
function applied(all, changed) {
  const byId = new Map(changed.map((s) => [s.id, s]));
  return all.map((s) => byId.get(s.id) ?? s);
}

// -------------------------------------------------- no drag => story order --
// The whole point of `shootOrder` being optional: a project nobody has ever
// dragged must display and behave exactly as it does today.
{
  const scenes = fiveScenes();
  eq('no shootOrder anywhere: display order == story order', ids(sortForDisplay(scenes)), [
    's1', 's2', 's3', 's4', 's5',
  ]);
  eq('none of the fixture scenes carry shootOrder', scenes.every((s) => s.shootOrder === undefined), true);
}

// -------------------------------------------------------------- move up ----
// Drag s4 up to just after s1 (index 3 -> index 1).
{
  const scenes = fiveScenes();
  const newIds = moveItem(ids(scenes), 3, 1);
  eq('moveItem: move up reorders the id list', newIds, ['s1', 's4', 's2', 's3', 's5']);

  const changed = reorderSlateList(scenes, newIds, 999);
  const out = applied(scenes, changed);
  eq('move up: display order matches the drop', ids(sortForDisplay(out)), ['s1', 's4', 's2', 's3', 's5']);
  eq('move up: shootOrder is dense 0..4', out.map((s) => s.shootOrder), [0, 2, 3, 1, 4]);
  eq('move up: story order (.order) is untouched', out.map((s) => s.order), [0, 1, 2, 3, 4]);
  eq('move up: every moved-position scene got a fresh updatedAt', changed.every((s) => s.updatedAt === 999), true);
}

// ------------------------------------------------------------ move down ----
// Drag s2 down past s4 (index 1 -> index 3).
{
  const scenes = fiveScenes();
  const newIds = moveItem(ids(scenes), 1, 3);
  eq('moveItem: move down reorders the id list', newIds, ['s1', 's3', 's4', 's2', 's5']);

  const changed = reorderSlateList(scenes, newIds, 999);
  const out = applied(scenes, changed);
  eq('move down: display order matches the drop', ids(sortForDisplay(out)), ['s1', 's3', 's4', 's2', 's5']);
  eq('move down: story order (.order) is untouched', out.map((s) => s.order), [0, 1, 2, 3, 4]);
}

// -------------------------------------------------------------- to top -----
// Drag the last scene (s5) all the way to the top.
{
  const scenes = fiveScenes();
  const newIds = moveItem(ids(scenes), 4, 0);
  eq('moveItem: to top', newIds, ['s5', 's1', 's2', 's3', 's4']);

  const changed = reorderSlateList(scenes, newIds, 999);
  const out = applied(scenes, changed);
  eq('to top: display order matches the drop', ids(sortForDisplay(out)), ['s5', 's1', 's2', 's3', 's4']);
  eq(
    'to top: shootOrder assigned to every scene, not just the one dragged',
    out.map((s) => s.shootOrder),
    [1, 2, 3, 4, 0],
  );
}

// ------------------------------------------------------------ to bottom ----
// Drag the first scene (s1) all the way to the bottom.
{
  const scenes = fiveScenes();
  const newIds = moveItem(ids(scenes), 0, 4);
  eq('moveItem: to bottom', newIds, ['s2', 's3', 's4', 's5', 's1']);

  const changed = reorderSlateList(scenes, newIds, 999);
  const out = applied(scenes, changed);
  eq('to bottom: display order matches the drop', ids(sortForDisplay(out)), ['s2', 's3', 's4', 's5', 's1']);
}

// --------------------------------------------------------------- no-op -----
// Dropping a scene back where it started must not rewrite anything. Two
// layers guarantee that:
//  1. moveItem(ids, i, i) is the identity array — the UI's own signal to skip
//     calling the store at all for a "picked up, put back" gesture.
//  2. Even if the store method IS invoked with a project already in
//     shootOrder mode, handing it the SAME order writes nothing (idempotent).
{
  const scenes = fiveScenes();
  const sameIds = moveItem(ids(scenes), 2, 2);
  eq('moveItem: dropping in place is a no-op (identity array)', sameIds, ids(scenes));

  // Baseline the project into shootOrder mode first (as any real project that
  // has ever seen a drag would already be), THEN prove a genuine no-op drag
  // on top of that baseline writes nothing.
  const baselined = applied(scenes, reorderSlateList(scenes, ids(scenes), 100));
  const stillSameIds = moveItem(ids(baselined), 2, 2);
  const changed = reorderSlateList(baselined, stillSameIds, 999);
  eq('no-op drag on an already-baselined project writes nothing', changed.length, 0);
}

// ------------------------------------------------------- repeat is stable --
// Reordering to the SAME arrangement twice in a row must not thrash: the
// second call finds every shootOrder already correct and changes nothing.
{
  const scenes = fiveScenes();
  const newIds = moveItem(ids(scenes), 3, 0);
  const first = reorderSlateList(scenes, newIds, 100);
  const out = applied(scenes, first);
  const second = reorderSlateList(out, newIds, 200);
  eq('repeating the same reorder writes nothing the second time', second.length, 0);
}

// ------------------------------------------------------ unknown id safety --
// An id reorderSlateList doesn't recognise (e.g. a stale snapshot racing a
// delete) must never invent a row or throw.
{
  const scenes = fiveScenes();
  const changed = reorderSlateList(scenes, ['s1', 'ghost', 's2', 's3', 's4', 's5'], 999);
  eq('unknown id in the list is silently skipped, not invented', changed.some((s) => s.id === 'ghost'), false);
  eq('the known ids around it still get their shootOrder', changed.find((s) => s.id === 's2').shootOrder, 2);
}

// --------------------------------------------------------------- reporting --
console.log(`${pass} passed, ${fails.length} failed`);
if (fails.length) {
  for (const f of fails) console.error('  FAIL ' + f);
  process.exit(1);
}
