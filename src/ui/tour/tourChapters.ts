// THE CHAPTER BAR'S OWN DATA — three chapters, one tour. Pure descriptors,
// same reasoning as tourSteps.ts: a list worth testing without mounting a
// screen. TourChapterMenu.tsx renders this list as tabs; TourController.tsx
// walks whichever chapter's `steps` the operator picks, the same engine that
// used to walk one flat list before this file existed.
//
// PHASE A BUILT 'director'; Phases B+C added 'setup' and 'export'. The
// 'podcast' chapter was dropped entirely: podcast mode's Home entry point was
// retired in the new-roll reframe (see newRoll.ts), so there is no reachable
// screen for a Podcast chapter to walk. The `comingSoon` field stays on the
// interface — a future chapter can use it — but no shipping chapter sets it.

import {
  DIRECTOR_RESUMABLE_STEP_IDS,
  DIRECTOR_STEPS,
  EXPORT_RESUMABLE_STEP_IDS,
  EXPORT_STEPS,
  SETUP_RESUMABLE_STEP_IDS,
  SETUP_STEPS,
  type TourStep,
} from './tourSteps';

export const TOUR_CHAPTER_IDS = ['director', 'setup', 'export'] as const;
export type TourChapterId = (typeof TOUR_CHAPTER_IDS)[number];

export interface TourChapter {
  id: TourChapterId;
  /** Shown on the tab. */
  label: string;
  /** One line, shown under the label while the tab bar is up. */
  blurb: string;
  steps: readonly TourStep[];
  /** True while a chapter has no walkthrough yet — the tab shows "Coming
   *  up" and refuses the tap rather than running an empty chapter that
   *  would complete itself with nothing shown. */
  comingSoon?: boolean;
  /** Step ids inside THIS chapter safe to resume after an interrupted tour
   *  (a reload mid-flight). Empty by default — a chapter earns entries here
   *  only once a specific step in it is provably reachable from a cold
   *  screen; see DIRECTOR_RESUMABLE_STEP_IDS's own header for why Director
   *  carries none in Phase A. */
  resumableStepIds?: ReadonlySet<string>;
}

export const TOUR_CHAPTERS: readonly TourChapter[] = [
  {
    id: 'director',
    label: 'Director',
    blurb: 'Shoot a scene — roll, mark, tag, cut, keep.',
    steps: DIRECTOR_STEPS,
    resumableStepIds: DIRECTOR_RESUMABLE_STEP_IDS,
  },
  {
    id: 'setup',
    label: 'Setup',
    blurb: 'Cameras and the house tags.',
    steps: SETUP_STEPS,
    resumableStepIds: SETUP_RESUMABLE_STEP_IDS,
  },
  {
    id: 'export',
    label: 'Export',
    blurb: 'The file your editor opens.',
    steps: EXPORT_STEPS,
    resumableStepIds: EXPORT_RESUMABLE_STEP_IDS,
  },
] as const;

/** A tab is tappable only once it actually has somewhere to take the
 *  operator — `comingSoon` is the authored intent, the empty `steps` check
 *  is the same rule enforced structurally, so one flag flipped without the
 *  other can never open a walkthrough with nothing in it. */
export function isChapterSelectable(chapter: TourChapter): boolean {
  return !chapter.comingSoon && chapter.steps.length > 0;
}

export function findChapter(id: TourChapterId): TourChapter | undefined {
  return TOUR_CHAPTERS.find((c) => c.id === id);
}
