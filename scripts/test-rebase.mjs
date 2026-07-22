// Sanity tests for rebaseClipNumbers (src/store/util.ts).
// Run: node scripts/test-rebase.mjs
// No test framework in this project; this is a one-off script like the timecode
// sanity checks. It type-strips util.ts via node's built-in TS support.

import { rebaseClipNumbers, reclaimClipNumbers } from '../src/store/util.ts';

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

// --------------------------------------------------------------- reporting --
console.log(`${pass} passed, ${fails.length} failed`);
if (fails.length) {
  for (const f of fails) console.error('  FAIL ' + f);
  process.exit(1);
}
