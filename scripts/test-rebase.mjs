// Sanity tests for rebaseClipNumbers (src/store/util.ts).
// Run: node scripts/test-rebase.mjs
// No test framework in this project; this is a one-off script like the timecode
// sanity checks. It type-strips util.ts via node's built-in TS support.

import { rebaseClipNumbers, reclaimClipNumbers, buildTakeClips } from '../src/store/util.ts';

let pass = 0;
const fails = [];

function eq(label, actual, expected) {
  const a = JSON.stringify(actual);
  const e = JSON.stringify(expected);
  if (a === e) pass++;
  else fails.push(`${label}\n    expected ${e}\n    actual   ${a}`);
}

// ---------------------------------------------------------------- fixtures --

function singleCamProject(nextClipNumber = 6) {
  return {
    id: 'p1',
    name: 'single',
    fps: 24,
    clipPrefix: 'C',
    nextClipNumber,
    clipPadding: 4,
    clipExt: '.MP4',
    tags: [],
    createdAt: 0,
    updatedAt: 0,
  };
}

function multiCamProject(nexts = { A: 6, B: 6 }) {
  return {
    ...singleCamProject(),
    cameras: [
      { letter: 'A', clipPrefix: 'C', nextClipNumber: nexts.A, clipPadding: 4, clipExt: '.MP4' },
      { letter: 'B', clipPrefix: 'GX', nextClipNumber: nexts.B, clipPadding: 2, clipExt: '.MP4' },
    ],
  };
}

/** Four independent units, A-D, each with its own prefix and counter. */
function fourCamProject(nexts = { A: 1, B: 1, C: 1, D: 1 }) {
  return {
    ...singleCamProject(),
    cameras: [
      { letter: 'A', clipPrefix: 'C', nextClipNumber: nexts.A, clipPadding: 4, clipExt: '.MP4' },
      { letter: 'B', clipPrefix: 'GX', nextClipNumber: nexts.B, clipPadding: 2, clipExt: '.MP4' },
      { letter: 'C', clipPrefix: 'A001C', nextClipNumber: nexts.C, clipPadding: 3, clipExt: '.MXF' },
      { letter: 'D', clipPrefix: 'DJI_', nextClipNumber: nexts.D, clipPadding: 4, clipExt: '.MP4' },
    ],
  };
}

/** Five takes, cut in order, clips C0001..C0005. take 3 is discarded. */
function singleCamTakes() {
  return [1, 2, 3, 4, 5].map((n) => ({
    id: `t${n}`,
    slateId: 's1',
    projectId: 'p1',
    number: n,
    clipName: `C${String(n).padStart(4, '0')}`,
    status: n === 3 ? 'discarded' : 'good',
    startedAt: n * 1000,
    durationMs: 500,
    createdAt: n * 1000,
    updatedAt: n * 1000,
  }));
}

function multiCamTakes() {
  return [1, 2, 3].map((n) => ({
    id: `t${n}`,
    slateId: 's1',
    projectId: 'p1',
    number: n,
    clipName: `C${String(n).padStart(4, '0')}`,
    clips: [
      { unit: 'A', clipName: `C${String(n).padStart(4, '0')}` },
      { unit: 'B', clipName: `GX${String(n).padStart(2, '0')}` },
    ],
    status: 'good',
    startedAt: n * 1000,
    durationMs: 500,
    createdAt: n * 1000,
    updatedAt: n * 1000,
  }));
}

const names = (takes) => takes.slice().sort((a, b) => a.createdAt - b.createdAt).map((t) => t.clipName);

/** Apply the returned changed-take patches onto the full list, as the store does. */
function applied(all, changed) {
  const byId = new Map(changed.map((t) => [t.id, t]));
  return all.map((t) => byId.get(t.id) ?? t);
}

// ------------------------------------------------------- the reported bug ---
// Kirtan edited a DISCARDED take's clip number; nothing after it moved, and the
// live counter kept its old value.
{
  const p = singleCamProject(6); // next CUT would be C0006
  const all = singleCamTakes();
  const r = rebaseClipNumbers(p, all, 't3', { A: 7 }, 999); // C0003 was really C0007

  eq('discarded take + later takes shift by +4', names(applied(all, r.takes)), [
    'C0001',
    'C0002',
    'C0007', // edited (discarded — the camera still wrote this file)
    'C0008',
    'C0009',
  ]);
  eq('live counter rides the same shift', r.project.nextClipNumber, 10);
  eq('only the edited take and later ones are written', r.takes.length, 3);
  eq('earlier takes untouched', names(applied(all, r.takes)).slice(0, 2), ['C0001', 'C0002']);
}

// --------------------------------------------------------------- negatives --
{
  const p = singleCamProject(6);
  const all = singleCamTakes();
  const r = rebaseClipNumbers(p, all, 't2', { A: 1 }, 999); // over-counted by 1

  eq('negative delta shifts back', names(applied(all, r.takes)), [
    'C0001',
    'C0001',
    'C0002',
    'C0003',
    'C0004',
  ]);
  eq('counter shifts back too', r.project.nextClipNumber, 5);
}

{
  const p = singleCamProject(6);
  const all = singleCamTakes();
  const r = rebaseClipNumbers(p, all, 't1', { A: 0 }, 999);
  eq('clamps at zero, never negative', names(applied(all, r.takes))[0], 'C0000');
  eq('counter clamps at zero', r.project.nextClipNumber >= 0, true);
}

// ------------------------------------------------------------- no-op edit ---
{
  const p = singleCamProject(6);
  const all = singleCamTakes();
  const r = rebaseClipNumbers(p, all, 't3', { A: 3 }, 999);
  eq('same number = only that row rewritten', r.takes.length, 1);
  eq('same number leaves the counter alone', r.project.nextClipNumber, 6);
}

// ------------------------------------------------------------- last take ----
{
  const p = singleCamProject(6);
  const all = singleCamTakes();
  const r = rebaseClipNumbers(p, all, 't5', { A: 9 }, 999);
  eq('editing the last take still moves the counter', r.project.nextClipNumber, 10);
  eq('editing the last take writes one row', r.takes.length, 1);
}

// --------------------------------------------------------------- multi-cam --
{
  const p = multiCamProject({ A: 4, B: 4 });
  const all = multiCamTakes();
  const r = rebaseClipNumbers(p, all, 't2', { B: 10 }, 999); // B-cam only, GX02 -> GX10
  const out = applied(all, r.takes);

  eq(
    'B shifts by +8 from the edit forward',
    out.map((t) => t.clips.find((c) => c.unit === 'B').clipName),
    ['GX01', 'GX10', 'GX11'],
  );
  eq(
    'A is completely untouched',
    out.map((t) => t.clips.find((c) => c.unit === 'A').clipName),
    ['C0001', 'C0002', 'C0003'],
  );
  eq('only B counter moves', [r.project.cameras[0].nextClipNumber, r.project.cameras[1].nextClipNumber], [4, 12]);
  eq('clipName mirrors unit A', out.map((t) => t.clipName), ['C0001', 'C0002', 'C0003']);
}

{
  const p = multiCamProject({ A: 4, B: 4 });
  const all = multiCamTakes();
  const r = rebaseClipNumbers(p, all, 't1', { A: 5, B: 5 }, 999); // both cams at once
  const out = applied(all, r.takes);
  eq(
    'both units shift independently',
    out.map((t) => `${t.clips[0].clipName}/${t.clips[1].clipName}`),
    ['C0005/GX05', 'C0006/GX06', 'C0007/GX07'],
  );
  eq('both counters shift', [r.project.cameras[0].nextClipNumber, r.project.cameras[1].nextClipNumber], [8, 8]);
}

// ------------------------------------------------ ordering is CUT order -----
{
  const p = singleCamProject(6);
  // Same takes handed over shuffled — result must not depend on array order.
  const all = singleCamTakes();
  const shuffled = [all[3], all[0], all[4], all[2], all[1]];
  const r = rebaseClipNumbers(p, shuffled, 't3', { A: 7 }, 999);
  eq('shuffled input still shifts by CUT time', names(applied(all, r.takes)), [
    'C0001',
    'C0002',
    'C0007',
    'C0008',
    'C0009',
  ]);
}


// ----------------------------------------------- delete reclaims the number --
// DELETE means the camera never wrote that file (the app rolled, the camera
// did not), so the number goes back and everything after slides DOWN one.
{
  const p = singleCamProject(6);
  const all = singleCamTakes();
  const r = reclaimClipNumbers(p, all, 't2', 999); // t2 was a phantom

  eq('later shots slide down one', names(applied(all, r.takes)), [
    'C0001',
    'C0002', // the doomed row itself is untouched; the caller deletes it
    'C0002',
    'C0003',
    'C0004',
  ]);
  eq('the doomed take is NOT returned for rewrite', r.takes.some((t) => t.id === 't2'), false);
  eq('live counter comes back one', r.project.nextClipNumber, 5);
}

{
  const p = singleCamProject(6);
  const all = singleCamTakes();
  const r = reclaimClipNumbers(p, all, 't5', 999); // last shot
  eq('deleting the last shot rewrites nothing', r.takes.length, 0);
  eq('deleting the last shot still frees the counter', r.project.nextClipNumber, 5);
}

{
  const p = singleCamProject(0);
  const all = singleCamTakes();
  const r = reclaimClipNumbers(p, all, 't1', 999);
  eq('counter never goes negative', r.project.nextClipNumber, 0);
}

{
  // Multi-cam: only the units that actually recorded a clip give a number back.
  const p = multiCamProject({ A: 4, B: 4 });
  const all = multiCamTakes().map((t, i) =>
    i === 1 ? { ...t, clips: [{ unit: 'B', clipName: 'GX02' }] } : t, // t2 = B only
  );
  const r = reclaimClipNumbers(p, all, 't2', 999);
  const out = applied(all, r.takes);
  eq(
    'B slides down after a B-only phantom',
    out.map((t) => t.clips.find((c) => c.unit === 'B')?.clipName),
    ['GX01', 'GX02', 'GX02'],
  );
  eq(
    'A never moves for a phantom it did not record',
    out.map((t) => t.clips.find((c) => c.unit === 'A')?.clipName ?? '-'),
    ['C0001', '-', 'C0003'],
  );
  eq('only B counter comes back', [r.project.cameras[0].nextClipNumber, r.project.cameras[1].nextClipNumber], [4, 3]);
}

// ------------------------------------------------- buildTakeClips: solo cam --
// Only the units that actually rolled get a clip, and only their counters
// advance. A camera that never rolled must not move at all.
{
  const p = fourCamProject({ A: 6, B: 6, C: 6, D: 6 });
  const input = {
    slateId: 's1',
    projectId: 'p1',
    startedAt: 1000,
    durationMs: 5000,
    units: [{ unit: 'B', startOffsetMs: 0, durationMs: 5000 }],
  };
  const { take, project: after } = buildTakeClips(p, 1, input, 999);

  eq('solo B take has exactly one clip', take.clips.length, 1);
  eq('the one clip is B, not A/C/D', take.clips[0].unit, 'B');
  eq('B clip carries the offset/duration it rolled', [take.clips[0].startOffsetMs, take.clips[0].durationMs], [0, 5000]);
  eq('clipName mirrors the only participating unit (B)', take.clipName, take.clips[0].clipName);
  eq(
    'only B advanced, A/C/D counters untouched',
    after.cameras.map((u) => u.nextClipNumber),
    [6, 7, 6, 6],
  );
}

// ---------------------------------------------- buildTakeClips: mid-take join --
// A camera can join a take already running; it gets the right startOffsetMs
// (time between the take starting and THIS unit's own roll) and its own
// durationMs (how long it actually rolled, which is less than the take).
{
  const p = fourCamProject({ A: 3, B: 3, C: 3, D: 3 });
  const input = {
    slateId: 's1',
    projectId: 'p1',
    startedAt: 10_000,
    durationMs: 8000, // A rolled the whole take: 0 -> 8000
    units: [
      { unit: 'A', startOffsetMs: 0, durationMs: 8000 },
      { unit: 'C', startOffsetMs: 2500, durationMs: 5500 }, // joined 2.5s in, ran to the end
    ],
  };
  const { take, project: after } = buildTakeClips(p, 1, input, 999);
  const byUnit = Object.fromEntries(take.clips.map((c) => [c.unit, c]));

  eq('two units rolled: A and C only', take.clips.map((c) => c.unit).sort(), ['A', 'C']);
  eq('A started with the take (offset 0), ran the full duration', [byUnit.A.startOffsetMs, byUnit.A.durationMs], [0, 8000]);
  eq('C joined 2500ms in and ran the remaining 5500ms', [byUnit.C.startOffsetMs, byUnit.C.durationMs], [2500, 5500]);
  eq(
    'A and C advanced; B and D (never rolled) did not',
    after.cameras.map((u) => u.nextClipNumber),
    [4, 3, 4, 3],
  );
}

// -------------------------------------------- buildTakeClips: legacy default --
// No `units` on the input at all (the shape every caller used before this
// feature existed) still rolls every configured unit together for the whole
// take, offset 0 - byte-identical to the old always-everyone behaviour.
{
  const p = multiCamProject({ A: 4, B: 4 });
  const input = { slateId: 's1', projectId: 'p1', startedAt: 0, durationMs: 3000 };
  const { take, project: after } = buildTakeClips(p, 1, input, 999);

  eq('legacy call still rolls every configured unit', take.clips.map((c) => c.unit), ['A', 'B']);
  eq(
    'every clip gets offset 0 and the full take duration',
    take.clips.map((c) => [c.startOffsetMs, c.durationMs]),
    [[0, 3000], [0, 3000]],
  );
  eq('every unit advances', [after.cameras[0].nextClipNumber, after.cameras[1].nextClipNumber], [5, 5]);
}

// single-cam (no project.cameras): `units` is meaningless and ignored, and the
// take still carries NO `clips` array at all - exactly the pre-existing shape.
{
  const p = singleCamProject(6);
  const input = { slateId: 's1', projectId: 'p1', startedAt: 0, durationMs: 1200 };
  const { take, project: after } = buildTakeClips(p, 1, input, 999);
  eq('single-cam take has no clips array', take.clips, undefined);
  eq('single-cam take carries the plain clipName', take.clipName, 'C0006');
  eq('single-cam counter advances exactly as before', after.nextClipNumber, 7);
}

// ------------------------------------- subset takes: rebase + reclaim -------
// Build a take with buildTakeClips itself (B-only), then prove rebaseClips and
// reclaimClipNumbers - which already special-case a take holding a SUBSET of
// units - carry it correctly end to end.
{
  const p = fourCamProject({ A: 6, B: 6, C: 6, D: 6 });
  const soloB = buildTakeClips(
    p,
    1,
    { slateId: 's1', projectId: 'p1', startedAt: 0, durationMs: 1000, units: [{ unit: 'B', startOffsetMs: 0, durationMs: 1000 }] },
    100,
  );
  const allBoth = buildTakeClips(
    soloB.project,
    2,
    { slateId: 's1', projectId: 'p1', startedAt: 2000, durationMs: 1000 }, // legacy: everyone rolls
    200,
  );
  const takes = [{ ...soloB.take, createdAt: 100 }, { ...allBoth.take, createdAt: 200 }];

  // Rebase the solo-B take's number - only B (and only forward) should move.
  const rebased = rebaseClipNumbers(allBoth.project, takes, soloB.take.id, { B: 20 }, 300);
  const out = applied(takes, rebased.takes);
  eq(
    'rebasing the B-only take shifts B forward on the LATER (all-cam) take too',
    out[1].clips.find((c) => c.unit === 'B').clipName,
    'GX21', // was GX07 (6+1), delta = 20-6=14 -> 21
  );
  eq(
    'A/C/D on the later take are untouched by a B-only rebase',
    ['A', 'C', 'D'].map((u) => out[1].clips.find((c) => c.unit === u)?.clipName),
    ['C0006', 'A001C006', 'DJI_0006'],
  );

  // Reclaim (delete) the solo-B take - only B slides down, A/C/D on the later
  // take (which never lost a number to the phantom B-only take) stay put.
  const reclaimed = reclaimClipNumbers(allBoth.project, takes, soloB.take.id, 400);
  const afterDelete = applied(takes, reclaimed.takes);
  eq('deleting the B-only take is not itself returned for rewrite', reclaimed.takes.some((t) => t.id === soloB.take.id), false);
  eq(
    'B on the later take slides down one after the B-only phantom is deleted',
    afterDelete[1].clips.find((c) => c.unit === 'B').clipName,
    'GX06', // was GX07
  );
  eq(
    'A/C/D on the later take are untouched by reclaiming a B-only take',
    ['A', 'C', 'D'].map((u) => afterDelete[1].clips.find((c) => c.unit === u)?.clipName),
    ['C0006', 'A001C006', 'DJI_0006'],
  );
  eq('only B counter comes back after reclaim', reclaimed.project.cameras.find((c) => c.letter === 'B').nextClipNumber, 7);
}

// ---------------------------------------- old-format takes keep working -----
// A take saved before this feature existed - multi-cam clips with no timing
// fields at all, and a single-cam take with no `clips` array whatsoever -
// must still rebase/reclaim exactly as it did before.
{
  const p = multiCamProject({ A: 4, B: 4 });
  const oldStyleTakes = multiCamTakes(); // clips have clipName/unit only, no timing fields
  eq('old-format clip has no startOffsetMs/durationMs', 'startOffsetMs' in oldStyleTakes[0].clips[0], false);

  const r = rebaseClipNumbers(p, oldStyleTakes, 't2', { B: 10 }, 999);
  const out = applied(oldStyleTakes, r.takes);
  eq(
    'old-format takes still rebase correctly (B shifts, A does not)',
    out.map((t) => `${t.clips.find((c) => c.unit === 'A').clipName}/${t.clips.find((c) => c.unit === 'B').clipName}`),
    ['C0001/GX01', 'C0002/GX10', 'C0003/GX11'],
  );

  const reclaimed = reclaimClipNumbers(p, oldStyleTakes, 't2', 999);
  eq('old-format takes still reclaim correctly', applied(oldStyleTakes, reclaimed.takes)[2].clips.find((c) => c.unit === 'B').clipName, 'GX02');
}
{
  // Single-cam take with no `clips` array at all (the universal pre-multi-cam
  // shape) still rebases/reclaims through the exact same code path.
  const p = singleCamProject(6);
  const oldSingleTakes = singleCamTakes();
  eq('old single-cam take has no clips array', 'clips' in oldSingleTakes[0], false);
  const r = rebaseClipNumbers(p, oldSingleTakes, 't3', { A: 7 }, 999);
  eq('old single-cam take still rebases correctly', names(applied(oldSingleTakes, r.takes)), [
    'C0001',
    'C0002',
    'C0007',
    'C0008',
    'C0009',
  ]);
}

// --------------------------------------------------------------- reporting --
console.log(`${pass} passed, ${fails.length} failed`);
if (fails.length) {
  for (const f of fails) console.error('  FAIL ' + f);
  process.exit(1);
}
