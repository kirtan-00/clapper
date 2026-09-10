// TOUR STATE — the `clapper.*` keys the tour owns, next to the other ones
// (see Onboarding.tsx's ONBOARDING_KEY, theme.ts's THEME_KEY). Guarded the
// same way every storage read/write in this app is: Safari private mode and
// a blocked cookie jar throw outright, and a tour is never worth taking the
// app down for.

export const TOUR_DONE_KEY = 'clapper.tourDone';
export const TOUR_STEP_KEY = 'clapper.tourStep';
export const TOUR_PROJECT_KEY = 'clapper.tourProjectId';
export const TOUR_CHAPTER_KEY = 'clapper.tourChapter';
/** JSON array of completed chapter ids — see markChapterDone/isChapterDone
 *  below. Separate from TOUR_DONE_KEY on purpose: that flag means "the
 *  operator has engaged with and left the tour at least once" (it gates the
 *  auto-offer — see tourRules.ts's shouldOfferTour) and stays true forever
 *  once set; this one is what paints the chapter tab bar's own checkmarks,
 *  and keeps growing as more chapters get walked. */
export const TOUR_CHAPTERS_DONE_KEY = 'clapper.tourChaptersDone';

function safeGet(key: string): string | null {
  try {
    return localStorage.getItem(key);
  } catch {
    return null;
  }
}

function safeSet(key: string, value: string): void {
  try {
    localStorage.setItem(key, value);
  } catch {
    /* the tour still runs for this session, it just will not survive it */
  }
}

function safeRemove(key: string): void {
  try {
    localStorage.removeItem(key);
  } catch {
    /* best-effort, same as every other write in this file */
  }
}

/** The whole tour has been finished, or explicitly skipped, at least once. */
export function isTourDone(): boolean {
  return safeGet(TOUR_DONE_KEY) === '1';
}

/** The end of the road, whichever way it was reached — finished or skipped
 *  are the same signal here, same as onboarding's own `finish()` does not
 *  distinguish "not now" from "done". Clears the in-flight bookkeeping too,
 *  so a stale step index can never outlive the tour it belonged to. Does NOT
 *  touch chapter completion — those checkmarks are their own record, read
 *  back the next time the chapter bar opens regardless of this flag. */
export function markTourDone(): void {
  safeSet(TOUR_DONE_KEY, '1');
  clearActiveTourStep();
}

/** Written on every advance while a chapter is running, so a reload
 *  mid-flight has something to read back — see TourController.tsx's resume
 *  effect for what it does with this. Which step ids within a chapter are
 *  actually safe to resume onto lives on that chapter's own descriptor
 *  (tourChapters.ts's `resumableStepIds`), not here. */
export function saveActiveTourStep(chapterId: string, index: number, projectId: string): void {
  safeSet(TOUR_CHAPTER_KEY, chapterId);
  safeSet(TOUR_STEP_KEY, String(index));
  safeSet(TOUR_PROJECT_KEY, projectId);
}

export function clearActiveTourStep(): void {
  safeRemove(TOUR_CHAPTER_KEY);
  safeRemove(TOUR_STEP_KEY);
  safeRemove(TOUR_PROJECT_KEY);
}

export interface ActiveTourStep {
  chapterId: string;
  index: number;
  projectId: string;
}

/** The in-flight step, or null when there is none (or the record is
 *  half-written — any key missing reads as absent, not as a guess). */
export function readActiveTourStep(): ActiveTourStep | null {
  const chapterId = safeGet(TOUR_CHAPTER_KEY);
  const raw = safeGet(TOUR_STEP_KEY);
  const projectId = safeGet(TOUR_PROJECT_KEY);
  if (!chapterId || raw === null || projectId === null || projectId === '') return null;
  const index = Number(raw);
  if (!Number.isInteger(index) || index < 0) return null;
  return { chapterId, index, projectId };
}

/** Every chapter id the operator has actually finished, across every visit —
 *  what paints the tab bar's checkmarks. A corrupt or foreign value in
 *  storage degrades to "nothing done" rather than throwing. */
export function readCompletedChapters(): ReadonlySet<string> {
  const raw = safeGet(TOUR_CHAPTERS_DONE_KEY);
  if (!raw) return new Set();
  try {
    const parsed: unknown = JSON.parse(raw);
    if (!Array.isArray(parsed)) return new Set();
    return new Set(parsed.filter((v): v is string => typeof v === 'string'));
  } catch {
    return new Set();
  }
}

/** One chapter finished. Additive — never removes another chapter's mark. */
export function markChapterDone(chapterId: string): void {
  const next = new Set(readCompletedChapters());
  next.add(chapterId);
  safeSet(TOUR_CHAPTERS_DONE_KEY, JSON.stringify([...next]));
}

export function isChapterDone(chapterId: string): boolean {
  return readCompletedChapters().has(chapterId);
}
