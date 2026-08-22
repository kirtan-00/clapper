// NEW ROLL — the one-tap path from a cold app to a rolling screen.
//
// The rule from the spec is "no project-setup ceremony": Home's hero has to
// land on a slate, never on a form. Everything here exists to make that one
// decision — WHICH scene, WHICH setup — without asking. WHICH PROJECT is not
// a decision this file makes anymore: a tap on Home always opens a fresh one.
//
// Two modes fan out from the hero (see HomeScreen.tsx's picker sheet):
//
//   DIRECTOR MODE is entirely ShotlistSheet's job — it always reads a fresh
//   PDF and always makes a NEW project. Nothing here is involved.
//
//   PODCAST MODE is this file's other job, `startPodcastRoll()`. It always
//   scratches a fresh project marked `mode: 'podcast'` (see types.ts) and
//   rolls on it. It used to resume the most recently touched podcast
//   project instead of making a new one; on a real set that meant a second
//   podcast tap on the same day dropped the operator into a PREVIOUS
//   recording, logging today's takes into yesterday's project. Fixed: every
//   tap here is a new project, full stop.
//
// The picking is pure and lives here (so it is testable without a store); the
// async orchestration that creates the project and its one scene is at the
// bottom.
//
// The one place a project is still resumed on purpose is Home's own "Where
// you were" row (`readResume`, below) — a person tapping back into the shoot
// they left, not a tap that means "start something". That stays unscoped
// across both modes, exactly as it always has.

import type { Project, Shot, Slate, Take } from '../types';
import { store } from '../store';
import { getDefaultTags } from './tagdefaults';

/** Which pool `pickResumeProject` draws from. Mirrors `Project.mode` —
 *  'video' is every project with no `mode` set, i.e. every legacy project and
 *  every one Director mode or the New project sheet makes. */
export type ProjectMode = 'video' | 'podcast';

function modeOf(p: Pick<Project, 'mode'>): ProjectMode {
  return p.mode === 'podcast' ? 'podcast' : 'video';
}

/** Newest thing that happened to a project, takes included. */
export function lastActivity(p: Project): number {
  return Math.max(
    p.updatedAt ?? 0,
    p.openShootDay?.lastTakeAt ?? 0,
    p.openShootDay?.firstTakeAt ?? 0,
  );
}

/**
 * The most recently touched project, or null when the pool is empty.
 * Projects carrying an open shoot day win outright — that is a shoot in
 * progress, and nothing else on the phone outranks it.
 *
 * NOT used by New roll or the mode tiles anymore (see the header comment):
 * those always scratch a fresh project. This is what Home's "Where you were"
 * row reads (`readResume`, below), always unscoped — the one legitimate
 * resume affordance on the app. `mode` still exists to scope the read (kept,
 * still tested) in case a future screen needs "most recent project of this
 * mode" without also needing to create one.
 */
export function pickResumeProject(projects: readonly Project[], mode?: ProjectMode): Project | null {
  const pool = mode ? projects.filter((p) => modeOf(p) === mode) : projects;
  if (pool.length === 0) return null;
  const open = pool.filter((p) => !!p.openShootDay);
  const scoped = open.length > 0 ? open : pool;
  return scoped.reduce((best, p) => (lastActivity(p) > lastActivity(best) ? p : best));
}

/** Scene order as the on-set list shows it: shooting order when someone has
 *  dragged one, story order otherwise. */
function sceneRank(s: Slate): number {
  return s.shootOrder ?? s.order;
}

/**
 * The scene to roll on. The scene of the most recent take first — that is
 * literally where the operator was standing — then whatever the call sheet
 * marked as today's, then the top of the list.
 *
 * A podcast project only ever carries the one slate `startPodcastRoll` makes
 * it (see below), so this is a same-answer-every-time lookup there; nothing
 * about that requires a special case here.
 */
export function pickSlate(slates: readonly Slate[], takes: readonly Take[]): Slate | null {
  if (slates.length === 0) return null;

  let newest: Take | null = null;
  for (const t of takes) if (!newest || t.startedAt > newest.startedAt) newest = t;
  const lastTake = newest;
  if (lastTake) {
    const was = slates.find((s) => s.id === lastTake.slateId);
    if (was) return was;
  }

  const ordered = [...slates].sort((a, b) => sceneRank(a) - sceneRank(b));
  return ordered.find((s) => s.today) ?? ordered[0];
}

/**
 * The setup to roll. Undefined for a scene with no breakdown, which logs takes
 * against the scene itself exactly as it always has — every podcast slate
 * included, since Podcast mode never gives one shots. For a scene WITH a
 * breakdown, the shot of its most recent take, else the first — never
 * nothing, because dropping onto a 47-setup scene with no setup selected
 * files the take in the wrong place silently.
 */
export function pickShot(slate: Slate, takes: readonly Take[]): Shot | undefined {
  const shots = slate.shots;
  if (!shots || shots.length === 0) return undefined;

  let newest: Take | null = null;
  for (const t of takes) {
    if (t.slateId !== slate.id || !t.shotId) continue;
    if (!newest || t.startedAt > newest.startedAt) newest = t;
  }
  const lastTake = newest;
  const was = lastTake ? shots.find((s) => s.id === lastTake.shotId) : undefined;
  return was ?? [...shots].sort((a, b) => a.order - b.order)[0];
}

/** "Shoot 14 Aug" / "Podcast 14 Aug" — a scratch project is named for the day
 *  it opened and the mode that made it, because that is the only thing about
 *  it anyone knows yet. No punctuation: this string ends up in exported
 *  filenames. */
export function scratchName(now: number = Date.now(), label = 'Shoot'): string {
  const d = new Date(now);
  return `${label} ${d.getDate()} ${d.toLocaleDateString('en-GB', { month: 'short' })}`;
}

/** What Home shows on the resume strip. */
export interface ResumeInfo {
  project: Project;
  takeCount: number;
  sceneCount: number;
  /** The open shoot day's number, absent until the first CUT opens day 1. */
  day?: number;
}

/** Read the one project Home's "Where you were" row cares about, plus its
 *  counts — the single most recently touched project on the phone, video or
 *  podcast alike. Null when empty. */
export async function readResume(): Promise<ResumeInfo | null> {
  const project = pickResumeProject(await store.listProjects());
  if (!project) return null;
  const bundle = await store.getBundle(project.id);
  return {
    project: bundle.project,
    takeCount: bundle.takes.length,
    sceneCount: bundle.slates.length,
    day: bundle.project.openShootDay?.index,
  };
}

/** Where a New roll tap ends up: a project screen with a rolling screen on it. */
export interface RollTarget {
  project: Project;
  slate: Slate;
  shot?: Shot;
  /** Always true now — every tap through this file invents a fresh project.
   *  Home still reads the field rather than assuming it, in case that ever
   *  stops being the only path here. */
  scratched: boolean;
}

/**
 * Make a brand new project and its one starting scene, and roll on it.
 * Never looks at what projects already exist: that lookup is exactly the bug
 * this function used to have (see the header comment above) — a project of
 * the right mode already on the phone is not a reason to hand its takes to
 * whoever tapped New roll today. The caller's busy guard is what stops a
 * double tap from writing two projects for one press, not a check in here.
 */
async function resolveRoll(
  make: () => Promise<Project>,
  slateName: string,
): Promise<RollTarget> {
  const project = await make();
  const slate = await store.createSlate(project.id, slateName);
  return { project, slate, shot: undefined, scratched: true };
}

/** Director mode's video maker — always scratches a fresh VIDEO project.
 *  Director mode itself never calls this (it always reads a fresh PDF via
 *  ShotlistSheet); this exists for a plain "just start shooting" roll with
 *  no shot list at all. */
export async function startNewRoll(): Promise<RollTarget> {
  return resolveRoll(
    () =>
      store.createProject({
        name: scratchName(),
        fps: 24,
        camera: 'custom',
        clipPrefix: 'C',
        clipSuffix: '',
        clipExt: '.MP4',
        nextClipNumber: 1,
        clipPadding: 4,
        tags: getDefaultTags('video'),
      }),
    'Scene 1',
  );
}

/**
 * Podcast mode's maker — always scratches a fresh project carrying
 * `mode: 'podcast'` and podcast-flavoured tags, never reuses one already on
 * the phone. Its one slate is named "Recording" rather than "Scene 1": a
 * podcast has no scenes, only sessions — every recording is another TAKE on
 * this one slate, numbered 1, 2, 3… same as a scene's takes always have
 * been, just never split across slates.
 */
export async function startPodcastRoll(): Promise<RollTarget> {
  return resolveRoll(
    () =>
      store.createProject({
        name: scratchName(Date.now(), 'Podcast'),
        fps: 24,
        camera: 'custom',
        clipPrefix: 'C',
        clipSuffix: '',
        clipExt: '.MP4',
        nextClipNumber: 1,
        clipPadding: 4,
        tags: getDefaultTags('podcast'),
        mode: 'podcast',
      }),
    'Recording',
  );
}
