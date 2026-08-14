// NEW ROLL — the one-tap path from a cold app to a rolling screen.
//
// The rule from the spec is "no project-setup ceremony": tapping the hero on
// Home has to land on a slate, never on a form. Everything here exists to make
// that one decision — WHICH project, WHICH scene, WHICH setup — without asking.
//
// The picking is pure and lives here (so it is testable without a store); the
// async orchestration that creates what is missing is `startNewRoll` at the
// bottom.
//
// DEVIATION FROM THE SPEC, on purpose. The spec says "if there is an open shoot
// day it resumes that; if there is not, it makes a scratch project". Taken
// literally that scratch-projects past a shotlist you imported ten seconds ago,
// because `openShootDay` is only stamped by the FIRST CUT (see
// store/util.ts::openShootDayIfNeeded) — a real project with real scenes and no
// takes yet has none. So the ladder is:
//
//   1. a project with an open shoot day  -> resume it (the spec's case)
//   2. otherwise the most recently touched project -> roll on it
//   3. nothing at all -> scratch project, one scene, roll
//
// Only a genuinely empty app ever makes a scratch project.

import type { Project, ProjectBundle, Shot, Slate, Take } from '../types';
import { store } from '../store';

/** The quick-tag chips a scratch project starts with — the same set the New
 *  project sheet offers, so a scratch shoot is not a lesser project. */
export const SCRATCH_TAGS = ['WIDE', 'MID', 'CU', 'OTS', 'INSERT', 'GOLD', 'PICKUP', 'NOISE'];

/** Newest thing that happened to a project, takes included. */
export function lastActivity(p: Project): number {
  return Math.max(
    p.updatedAt ?? 0,
    p.openShootDay?.lastTakeAt ?? 0,
    p.openShootDay?.firstTakeAt ?? 0,
  );
}

/**
 * The project New roll should land in, or null when the app is empty. Projects
 * carrying an open shoot day win outright — that is a shoot in progress, and
 * nothing else on the phone outranks it.
 */
export function pickResumeProject(projects: readonly Project[]): Project | null {
  if (projects.length === 0) return null;
  const open = projects.filter((p) => !!p.openShootDay);
  const pool = open.length > 0 ? open : projects;
  return pool.reduce((best, p) => (lastActivity(p) > lastActivity(best) ? p : best));
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
 * against the scene itself exactly as it always has. For a scene WITH one, the
 * shot of its most recent take, else the first — never nothing, because
 * dropping onto a 47-setup scene with no setup selected files the take in the
 * wrong place silently.
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

/** "Shoot 14 Aug" — a scratch project is named for the day it opened, because
 *  that is the only thing about it anyone knows yet. No punctuation: this
 *  string ends up in exported filenames. */
export function scratchName(now: number = Date.now()): string {
  const d = new Date(now);
  return `Shoot ${d.getDate()} ${d.toLocaleDateString('en-GB', { month: 'short' })}`;
}

/** What Home shows on the resume strip. */
export interface ResumeInfo {
  project: Project;
  takeCount: number;
  sceneCount: number;
  /** The open shoot day's number, absent until the first CUT opens day 1. */
  day?: number;
}

/** Read the one project Home cares about, plus its counts. Null when empty. */
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
 * Resolve (and, where needed, create) everything a roll needs. One call creates
 * at most one project and one scene, and only when there is genuinely nothing
 * to resume — so the common double tap, on a phone that already has a project,
 * writes nothing at all. Two calls genuinely racing on an EMPTY phone would
 * each see zero projects and each create one, which is what the caller's busy
 * guard is for; this function does not try to be a lock.
 */
export async function startNewRoll(): Promise<RollTarget> {
  const existing = pickResumeProject(await store.listProjects());
  const scratched = !existing;
  const project =
    existing ??
    (await store.createProject({
      name: scratchName(),
      fps: 24,
      camera: 'custom',
      clipPrefix: 'C',
      clipSuffix: '',
      clipExt: '.MP4',
      nextClipNumber: 1,
      clipPadding: 4,
      tags: SCRATCH_TAGS,
    }));

  const bundle: ProjectBundle = await store.getBundle(project.id);
  const slate = pickSlate(bundle.slates, bundle.takes) ?? (await store.createSlate(project.id, 'Scene 1'));
  return { project: bundle.project, slate, shot: pickShot(slate, bundle.takes), scratched };
}
