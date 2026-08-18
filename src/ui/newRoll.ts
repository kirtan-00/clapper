// NEW ROLL — the one-tap path from a cold app to a rolling screen.
//
// The rule from the spec is "no project-setup ceremony": Home's hero has to
// land on a slate, never on a form. Everything here exists to make that one
// decision — WHICH project, WHICH scene, WHICH setup — without asking.
//
// Two modes fan out from the hero (see HomeScreen.tsx's picker sheet):
//
//   DIRECTOR MODE is entirely ShotlistSheet's job — it always reads a fresh
//   PDF and always makes a NEW project. Nothing here is involved.
//
//   PODCAST MODE is this file's other job, `startPodcastRoll()`. It runs the
//   exact same resume-or-create ladder `startNewRoll()` always has, scoped to
//   projects already marked `mode: 'podcast'` (see types.ts) so it can never
//   drop the operator mid-scene into whichever VIDEO shoot was touched most
//   recently — the two modes' projects are resumed from separate pools.
//
// The picking is pure and lives here (so it is testable without a store); the
// async orchestration that creates what is missing is at the bottom.
//
// DEVIATION FROM THE SPEC, on purpose. The spec says "if there is an open shoot
// day it resumes that; if there is not, it makes a scratch project". Taken
// literally that scratches past a shotlist you imported ten seconds ago,
// because `openShootDay` is only stamped by the FIRST CUT (see
// store/util.ts::openShootDayIfNeeded) — a real project with real scenes and no
// takes yet has none. So the ladder is:
//
//   1. a project (in the target pool) with an open shoot day -> resume it
//      (the spec's case)
//   2. otherwise the most recently touched project in the pool -> roll on it
//   3. nothing in the pool -> scratch project, one scene, roll
//
// Only a genuinely empty pool ever makes a scratch project.

import type { Project, ProjectBundle, Shot, Slate, Take } from '../types';
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
 * The project New roll should land in, or null when the pool is empty.
 * Projects carrying an open shoot day win outright — that is a shoot in
 * progress, and nothing else on the phone outranks it.
 *
 * `mode` scopes the pool: pass it to draw only from that mode's projects
 * (Podcast mode's own resume ladder). Omit it for the mode-agnostic "most
 * recently touched project, whatever it is" read Home's own resume row
 * uses — that row is a general "back to what you had open" affordance, not
 * part of either mode's ladder, so it stays unscoped on purpose.
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
  /** True when this tap had to invent the project — Home says so afterwards. */
  scratched: boolean;
}

/**
 * Resolve (and, where needed, create) a project+scene to roll on, scoped to
 * ONE mode's pool. One call creates at most one project and one scene, and
 * only when there is genuinely nothing to resume IN THAT POOL — so the common
 * double tap, on a phone that already has a project of that mode, writes
 * nothing at all. Two calls genuinely racing on a pool with nothing in it
 * would each see zero projects and each create one, which is what the
 * caller's busy guard is for; this function does not try to be a lock.
 */
async function resolveRoll(
  mode: ProjectMode,
  make: () => Promise<Project>,
  slateName: string,
): Promise<RollTarget> {
  const existing = pickResumeProject(await store.listProjects(), mode);
  const scratched = !existing;
  const project = existing ?? (await make());

  const bundle: ProjectBundle = await store.getBundle(project.id);
  const slate = pickSlate(bundle.slates, bundle.takes) ?? (await store.createSlate(project.id, slateName));
  return { project: bundle.project, slate, shot: pickShot(slate, bundle.takes), scratched };
}

/** Director mode's video ladder — resumes the most recently active VIDEO
 *  project, or scratches one. Director mode itself never calls this (it
 *  always reads a fresh PDF via ShotlistSheet); this exists for a plain
 *  "just start shooting" roll with no shot list at all. */
export async function startNewRoll(): Promise<RollTarget> {
  return resolveRoll(
    'video',
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
 * Podcast mode's ladder — resumes the most recently active PODCAST project
 * (never a video/director one), or scratches one carrying `mode: 'podcast'`
 * and podcast-flavoured tags. The scratch project's one slate is named
 * "Recording" rather than "Scene 1": a podcast has no scenes, only sessions —
 * every recording is another TAKE on this one slate, numbered 1, 2, 3… same
 * as a scene's takes always have been, just never split across slates.
 */
export async function startPodcastRoll(): Promise<RollTarget> {
  return resolveRoll(
    'podcast',
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
