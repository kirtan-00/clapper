// Sanity tests for the SOUND numbering path in src/store/util.ts.
// Run: node scripts/test-sound.mjs
// Same plain-node style as test-rebase.mjs; type-strips util.ts via node's TS.

import { buildTakeClips, rebaseClipNumbers, reclaimClipNumbers } from '../src/store/util.ts';

let pass = 0;
const fails = [];

function eq(label, actual, expected) {
  const a = JSON.stringify(actual);
  const e = JSON.stringify(expected);
  if (a === e) pass++;
  else fails.push(`${label}\n    expected ${e}\n    actual   ${a}`);
}

const pad4 = (n) => String(n).padStart(4, '0');

// ---------------------------------------------------------------- fixtures --

function singleCamProject(nextClipNumber = 6) {
  return {
    id: 'p1', name: 'snd', fps: 24,
    clipPrefix: 'C', nextClipNumber, clipPadding: 4, clipExt: '.MP4',
    tags: [], createdAt: 0, updatedAt: 0,
  };
}

function soundProject(nextClip = 6, nextFile = 6) {
  return {
    ...singleCamProject(nextClip),
    sound: { filePrefix: 'SND_', nextFileNumber: nextFile, filePadding: 4, fileExt: '.WAV' },
  };
}

function multiCamSoundProject() {
  return {
    ...soundProject(),
    cameras: [
      { letter: 'A', clipPrefix: 'C', nextClipNumber: 6, clipPadding: 4, clipExt: '.MP4' },
      { letter: 'B', clipPrefix: 'GX', nextClipNumber: 6, clipPadding: 2, clipExt: '.MP4' },
    ],
  };
}

/** Five single-cam takes, each with a sound file SND_0001..0005. take 3 discarded. */
function soundTakes(opts = {}) {
  const skipSoundOn = opts.skipSoundOn ?? []; // take numbers where sound did NOT roll
  return [1, 2, 3, 4, 5].map((n) => ({
    id: `t${n}`, slateId: 's1', projectId: 'p1', number: n,
    clipName: `C${pad4(n)}`,
    ...(skipSoundOn.includes(n) ? {} : { sound: { fileName: `SND_${pad4(n)}` } }),
    status: n === 3 ? 'discarded' : 'good',
    startedAt: n * 1000, durationMs: 500, createdAt: n * 1000, updatedAt: n * 1000,
  }));
}

const soundNames = (takes) =>
  takes.slice().sort((a, b) => a.createdAt - b.createdAt).map((t) => t.sound?.fileName ?? null);
const clipNames = (takes) =>
  takes.slice().sort((a, b) => a.createdAt - b.createdAt).map((t) => t.clipName);

function applied(all, changed) {
  const byId = new Map(changed.map((t) => [t.id, t]));
  return all.map((t) => byId.get(t.id) ?? t);
}

const baseInput = { slateId: 's1', projectId: 'p1', startedAt: 1000, durationMs: 500 };

// ------------------------------------------------------------------- build --
{
  const p = soundProject(6, 6);
  const r = buildTakeClips(p, 6, { ...baseInput, sound: { startOffsetMs: 0, durationMs: 500 } }, 111);
  eq('build: clip name', r.take.clipName, 'C0006');
  eq('build: sound file name', r.take.sound?.fileName, 'SND_0006');
  eq('build: sound timing kept', [r.take.sound?.startOffsetMs, r.take.sound?.durationMs], [0, 500]);
  eq('build: clip counter advanced', r.project.nextClipNumber, 7);
  eq('build: sound counter advanced', r.project.sound.nextFileNumber, 7);
}
{
  // Sound did NOT roll this take -> no sound stamped, sound counter frozen.
  const p = soundProject(6, 6);
  const r = buildTakeClips(p, 6, { ...baseInput }, 111);
  eq('build no-sound: take.sound absent', r.take.sound ?? null, null);
  eq('build no-sound: sound counter frozen', r.project.sound.nextFileNumber, 6);
  eq('build no-sound: clip counter still advances', r.project.nextClipNumber, 7);
}
{
  // Project has no Sound unit but input.sound present -> ignored entirely.
  const p = singleCamProject(6);
  const r = buildTakeClips(p, 6, { ...baseInput, sound: { startOffsetMs: 0, durationMs: 500 } }, 111);
  eq('build no-unit: take.sound absent', r.take.sound ?? null, null);
  eq('build no-unit: project.sound absent', r.project.sound ?? null, null);
}
{
  // Multi-cam + sound: both camera clips AND the sound file are stamped together.
  const p = multiCamSoundProject();
  const r = buildTakeClips(p, 6, { ...baseInput, sound: { startOffsetMs: 0, durationMs: 500 } }, 111);
  eq('build multicam: clips', r.take.clips?.map((c) => c.clipName), ['C0006', 'GX06']);
  eq('build multicam: sound', r.take.sound?.fileName, 'SND_0006');
  eq('build multicam: cameras advanced', r.project.cameras.map((u) => u.nextClipNumber), [7, 7]);
  eq('build multicam: sound advanced', r.project.sound.nextFileNumber, 7);
}

// ------------------------------------------------------------------ rebase --
{
  // Correct take 3's sound to SND_0007 (+4); later sound files ride the shift.
  const p = soundProject(6, 6);
  const all = soundTakes();
  const r = rebaseClipNumbers(p, all, 't3', {}, 999, 7);
  eq('rebase sound: files shift by +4', soundNames(applied(all, r.takes)),
    ['SND_0001', 'SND_0002', 'SND_0007', 'SND_0008', 'SND_0009']);
  eq('rebase sound: counter rides shift', r.project.sound.nextFileNumber, 10);
  eq('rebase sound: clip names untouched', clipNames(applied(all, r.takes)),
    ['C0001', 'C0002', 'C0003', 'C0004', 'C0005']);
  eq('rebase sound: clip counter untouched', r.project.nextClipNumber, 6);
}
{
  // Camera-only correction must NOT disturb sound.
  const p = soundProject(6, 6);
  const all = soundTakes();
  const r = rebaseClipNumbers(p, all, 't3', { A: 7 }, 999);
  eq('rebase cam-only: sound files untouched', soundNames(applied(all, r.takes)),
    ['SND_0001', 'SND_0002', 'SND_0003', 'SND_0004', 'SND_0005']);
  eq('rebase cam-only: sound counter untouched', r.project.sound.nextFileNumber, 6);
  eq('rebase cam-only: clips shift +4', clipNames(applied(all, r.takes)),
    ['C0001', 'C0002', 'C0007', 'C0008', 'C0009']);
}
{
  // Sound delta 0 (reformat only) -> verbatim on the edited take, no shift.
  const p = soundProject(6, 6);
  const all = soundTakes();
  const r = rebaseClipNumbers(p, all, 't3', {}, 999, 3);
  eq('rebase sound delta0: no later shift', soundNames(applied(all, r.takes)),
    ['SND_0001', 'SND_0002', 'SND_0003', 'SND_0004', 'SND_0005']);
  eq('rebase sound delta0: counter frozen', r.project.sound.nextFileNumber, 6);
}

// ----------------------------------------------------------------- reclaim --
{
  // DELETE take 2: later sound files (and clips) slide DOWN one, counters too.
  const p = soundProject(6, 6);
  const all = soundTakes();
  const r = reclaimClipNumbers(p, all, 't2', 999);
  eq('reclaim: later sound slides down', soundNames(applied(all, r.takes.concat())).filter((_, i) => i !== 1),
    ['SND_0001', 'SND_0002', 'SND_0003', 'SND_0004']);
  eq('reclaim: sound counter -1', r.project.sound.nextFileNumber, 5);
  eq('reclaim: clip counter -1', r.project.nextClipNumber, 5);
}
{
  // A middle take with NO sound is skipped on slide-down (no phantom number).
  const p = soundProject(6, 6);
  const all = soundTakes({ skipSoundOn: [3] }); // take 3 recorded no sound
  const r = reclaimClipNumbers(p, all, 't1', 999);
  eq('reclaim skip: soundless take stays null',
    soundNames(applied(all, r.takes)),
    ['SND_0001', 'SND_0001', null, 'SND_0003', 'SND_0004']);
  // t2:0002->0001, t3 none, t4:0004->0003, t5:0005->0004. (t1 still 0001, it's the doomed row the caller deletes.)
  eq('reclaim skip: counter -1', r.project.sound.nextFileNumber, 5);
}

// ------------------------------------------------------------------ report --
if (fails.length) {
  console.error(`\nSOUND TESTS FAILED (${fails.length}):\n`);
  for (const f of fails) console.error('  ✗ ' + f + '\n');
  process.exit(1);
}
console.log(`sound numbering: ${pass} assertions passed`);
