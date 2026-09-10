// THE TOUR ENGINE — mounted once, at the shell, same address as Onboarding
// and RollRecovery (see AppShell.tsx). It owns four things: starting a real
// example shoot, showing the CHAPTER BAR (TourChapterMenu.tsx) that picks
// which chapter's steps to walk, walking whichever chapter's own step list
// against the real screens that example shoot puts on the phone (returning
// to the chapter bar once that chapter runs out — see `advance` below), and
// the two entry points that can ask it to start (Settings' permanent row,
// and a first-open offer that ships dark — see TOUR_AUTOSTART below).
//
// IT DRIVES THE REAL APP, NOT A REPLICA. Starting the tour imports one of
// Script Mode's own EXAMPLE_PACKS (scriptpack.ts) exactly the way that mode
// already does, then pushes the SAME route Home's own "Start rolling now"
// pushes first (`{name:'project'}` — see newRoll.ts/HomeScreen.tsx's
// `startRolling`) so the operator lands on the real ProjectScreen with a
// real project under it, and the chapter bar floats over that. Picking a
// chapter with real steps (Director, so far) pushes `{name:'rolling'}` the
// same way — see `advance` below. From there this file steps out of the way
// for every hands-on step — TourSpotlight listens for the real ROLL/MARK
// IN/CUT/Keep taps on the real elements; this file only performs the real
// navigations those taps do NOT themselves cause and keeps the current
// chapter and step index.
//
// DIRECTOR, SETUP AND EXPORT ALL HAVE STEPS NOW (see tourChapters.ts).
// Podcast still shows in the bar as "Coming up" and refuses the tap —
// podcast mode has no real screen to walk yet. Setup and Export needed one
// thing Director never did: a real Sheet (ProjectScreen's own `setupOpen`,
// ExportBar's own `exportOpen`) to be open before their later steps' targets
// even exist. Neither sheet is a `Route`, so `nav.push`/`nav.pop` cannot
// reach them the way Director's rolling screen does — see the
// `requestSetupSheet`/`requestExportSheet` pub-sub below, and `advance`'s
// 'setup'/'export' branches that call them.
//
// NEVER MID-SHOOT. `canStartTour` (tourRules.ts) refuses to start while
// `route.name === 'rolling'`. Reachability already makes this rare — the tab
// tray, and Settings' "Take the tour" row with it, is unmounted on that exact
// route (see AppShell.tsx's `tray` calc) — this is the second lock on the
// same door, for the auto-offer below and any future entry point that does
// not go through the tray.
//
import { useEffect, useRef, useState } from 'react';
import type { Project, Slate } from '../../types';
import { store } from '../../store';
import { sortForDisplay } from '../../store/util';
import { importScriptPack, EXAMPLE_PACKS } from '../scriptpack';
import type { Nav, Route } from '../nav';
import { Sheet, SheetClose } from '../common';
import { track } from '../../net/analytics';
import { isOnboardingDone } from '../Onboarding';
import { TourSpotlight } from './TourSpotlight';
import { TourChapterMenu } from './TourChapterMenu';
import { findChapter, isChapterSelectable, TOUR_CHAPTER_IDS, type TourChapterId } from './tourChapters';
import { canStartTour, clampStepIndex, nextStepIndex, shouldOfferTour } from './tourRules';
import {
  clearActiveTourStep,
  isTourDone,
  markChapterDone,
  markTourDone,
  readActiveTourStep,
  readCompletedChapters,
  saveActiveTourStep,
} from './tourState';

// TOUR_AUTOSTART = false. The permanent Settings entry works regardless of
// this flag; only the unsolicited "want a 2-minute tour?" offer is behind it.
// Flip it once the offer's own timing (see shouldOfferTour in tourRules.ts —
// after onboarding has settled, after at least one real take exists, never
// mid-shoot) has actually been watched happen on a real phone. Until then the
// offer's code path is exercised by tourRules.test.ts and simply never runs.
export const TOUR_AUTOSTART = false;

// TOUR_ENTRY_ENABLED = false hides the one manual door (Settings' "Take the
// tour" row) so the tour is unreachable in prod while it is still partial
// (Director/Setup/Export, no Podcast). The whole tour stays built and tested;
// flip this to true — alongside TOUR_AUTOSTART if desired — to relaunch it.
export const TOUR_ENTRY_ENABLED = false;

// ------------------------------------------------------------ the launcher
// A tiny pub-sub, same shape as Onboarding.tsx's dev-only face switch: a
// caller anywhere in the tree (SettingsScreen's "Take the tour" row) asks the
// one mounted TourController to start, without nav having to be threaded
// down to a settings row that otherwise has no business holding it.

type Listener = () => void;
const startListeners = new Set<Listener>();

/** Ask the mounted TourController to start the tour. Best-effort: if nothing
 *  is listening yet (impossible in practice — TourController mounts with the
 *  shell, before any screen that could call this), it is simply a no-op. */
export function requestTourStart(): void {
  for (const fn of startListeners) fn();
}

// DEV-ONLY render hook (reverted after screenshotting the tour). Lets the
// Chrome harness trigger the tour without a touch tap the desktop drops.
if (import.meta.env.DEV) {
  (globalThis as any).__tourStart = requestTourStart;
}

function useTourStartRequests(handler: () => void): void {
  const ref = useRef(handler);
  ref.current = handler;
  useEffect(() => {
    const fn = () => ref.current();
    startListeners.add(fn);
    return () => {
      startListeners.delete(fn);
    };
  }, []);
}

// ------------------------------------------------- setup/export sheet doors
// SETUP and EXPORT each walk a real Sheet local to a component this file
// does not own (ProjectScreen's `setupOpen`, ExportBar's `exportOpen`) —
// neither is a `Route`, so there is nothing for `nav` to push or pop the way
// Director's rolling screen works. Same pub-sub shape as `requestTourStart`
// above, one pair per sheet: the component that owns the state subscribes
// once with its own setter, and `advance` below asks for it open or shut
// between two steps of the SAME chapter — see its 'export' branch, which has
// to close Export and open Setup because `FootageFolderSection` (the
// 'export-folder' step's target) actually lives in the Setup sheet. Neither
// ProjectScreen nor ExportBar has to import anything about the tour beyond
// the one hook call.
type SheetListener = (open: boolean) => void;
const setupSheetListeners = new Set<SheetListener>();
const exportSheetListeners = new Set<SheetListener>();

/** Ask ProjectScreen's own Setup sheet open or shut. Best-effort, same as
 *  `requestTourStart` — a no-op if nothing is listening yet. */
export function requestSetupSheet(open: boolean): void {
  for (const fn of setupSheetListeners) fn(open);
}

/** Ask ExportBar's own Export sheet open or shut. */
export function requestExportSheet(open: boolean): void {
  for (const fn of exportSheetListeners) fn(open);
}

/** ProjectScreen calls this once, alongside its own `setSetupOpen` state. */
export function useSetupSheetOpenRequests(setOpen: (open: boolean) => void): void {
  const ref = useRef(setOpen);
  ref.current = setOpen;
  useEffect(() => {
    const fn = (open: boolean) => ref.current(open);
    setupSheetListeners.add(fn);
    return () => {
      setupSheetListeners.delete(fn);
    };
  }, []);
}

/** ExportBar calls this once, alongside its own `setExportOpen` state. */
export function useExportSheetOpenRequests(setOpen: (open: boolean) => void): void {
  const ref = useRef(setOpen);
  ref.current = setOpen;
  useEffect(() => {
    const fn = (open: boolean) => ref.current(open);
    exportSheetListeners.add(fn);
    return () => {
      exportSheetListeners.delete(fn);
    };
  }, []);
}

// The example pack every chapter shoots against. "Grandfather ad" — the
// shortest of the three EXAMPLE_PACKS (scriptpack.ts), and every scene
// carries both coverage and key-moment chips, which is what lets the
// Director chapter's tag steps mean something.
const DEMO_PACK_KEY = 'grandfather';

interface Demo {
  project: Project;
  slate: Slate | null;
}

/** Runtime guard for a value read back out of localStorage — see the resume
 *  effect below. A stored chapter id from an older build, or a corrupted
 *  write, must degrade to "nothing to resume" rather than a bad lookup. */
function isTourChapterId(v: string): v is TourChapterId {
  return (TOUR_CHAPTER_IDS as readonly string[]).includes(v);
}

export function TourController(props: { nav: Nav; route: Route }) {
  const { nav, route } = props;
  const [demo, setDemo] = useState<Demo | null>(null);
  // Which chapter is actively walking its own step list right now — null
  // whenever the chapter bar (or nothing) is what's on screen.
  const [activeChapterId, setActiveChapterId] = useState<TourChapterId | null>(null);
  const [stepIndex, setStepIndex] = useState(0);
  // THE CHAPTER BAR. Up whenever the tour has a demo project loaded and no
  // chapter is actively walking — on first start, and again the instant a
  // chapter finishes (see `advance` below).
  const [menuShowing, setMenuShowing] = useState(false);
  const [offering, setOffering] = useState(false);
  // Loaded once at mount from localStorage — see tourState.ts's
  // readCompletedChapters — then kept in sync locally so the bar's own
  // checkmarks repaint the instant a chapter finishes, with no extra read.
  const [completed, setCompleted] = useState<ReadonlySet<TourChapterId>>(
    () => new Set([...readCompletedChapters()].filter(isTourChapterId)),
  );
  // THE CLOSING BEAT. Shown on exit (Done, or Skip tour mid-step) once at
  // least one chapter has actually been finished this session — see
  // `exitTour` below. markTourDone has already fired by the time this flips
  // true, so this sheet is purely a "you're done for now" moment, never a
  // gate on the tour actually finishing.
  const [finishShowing, setFinishShowing] = useState(false);
  const busyRef = useRef(false);
  const offerLatchedRef = useRef(false);

  async function start(): Promise<void> {
    if (busyRef.current || activeChapterId || menuShowing || finishShowing) return;
    if (!canStartTour(route.name === 'rolling')) return;
    busyRef.current = true;
    try {
      const entry = EXAMPLE_PACKS.find((p) => p.key === DEMO_PACK_KEY);
      if (!entry) return; // defensive; the key above is a literal from that same file
      const project = await importScriptPack(entry.pack, {
        // Prefixed so it never reads as one of the operator's own films in
        // the Projects list. It is otherwise a completely real project —
        // never-delete applies to it exactly as it does to every other one.
        name: `Tutorial — ${entry.pack.project.name}`,
      });
      const slates = sortForDisplay(await store.listSlates(project.id));
      setDemo({ project, slate: slates[0] ?? null });
      track('tour', { action: 'started' });
      // Same landing HomeScreen's own shot-list road uses (see its
      // `onCreated`): reset the Projects tab first, so BACK out of the tour's
      // project screen lands on the list rather than wherever that stack was
      // last left.
      nav.switchTab('projects', { reset: true });
      nav.push({ name: 'project', project });
      setMenuShowing(true);
    } catch {
      /* best-effort — the tour just does not start */
    } finally {
      busyRef.current = false;
    }
  }

  /** A selectable tab was tapped — begin walking that chapter's own steps
   *  from the top. No-op on a coming-soon chapter (the tab is disabled, but
   *  this is the second lock, same reasoning as canStartTour's own header). */
  function selectChapter(id: TourChapterId): void {
    if (!demo) return;
    const chapter = findChapter(id);
    if (!chapter || !isChapterSelectable(chapter)) return;
    setMenuShowing(false);
    setActiveChapterId(id);
    setStepIndex(0);
    saveActiveTourStep(id, 0, demo.project.id);
    track('tour', { action: 'chapter_started', chapter: id });
  }

  /** Leave the tour entirely — the persistent Done/Skip tour row in the
   *  chapter bar, and TourSpotlight's own "Skip tour" button mid-step alike.
   *  A chapter already finished is not undone by this; it is the WHOLE tour
   *  that ends, same promise `markTourDone` always made. */
  function exitTour(): void {
    const chapter = activeChapterId ? findChapter(activeChapterId) : undefined;
    const current = chapter?.steps[stepIndex];
    track('tour', { action: 'skipped', chapter: activeChapterId ?? undefined, step: current?.id });
    markTourDone();
    const hadProgress = completed.size > 0;
    setMenuShowing(false);
    setActiveChapterId(null);
    setStepIndex(0);
    setDemo(null);
    if (hadProgress) {
      setFinishShowing(true);
    } else {
      nav.switchTab('home', { reset: true });
    }
  }

  /**
   * Past the current step, inside whichever chapter is active. Director's
   * two steps that need a REAL navigation the tap that just landed does not
   * itself cause:
   *
   *   'scene' — the operator read the caption and tapped Next, which is
   *             SIMULATING the tap ProjectScreen's own scene card would take;
   *             nothing about reading a caption opens the rolling screen on
   *             its own.
   *   'keep'  — tapping Keep closes PostCutSheet and leaves the operator on
   *             the SAME rolling screen, ready for another take, exactly as
   *             a real shoot day wants. The tour is not shooting another
   *             take; it needs the chapter bar to land back over
   *             ProjectScreen, not over an idle rolling screen (where the tab
   *             tray — and any future re-entry — is unmounted), so this pops
   *             exactly one level — the same `nav.pop()` a real BACK tap
   *             performs (see App.tsx's `rolling` route).
   *
   * Every other step's target simply exists because of what the operator
   * just did for real: ROLL makes MARK IN mount, MARK OUT opens the range
   * name field, CUT opens PostCutSheet. Nothing here has to know any of that.
   * A future chapter with its own navigation needs is free to add its own
   * branch here the same way, keyed on its own id.
   *
   * SETUP and EXPORT need no navigation at all for their OWN door — same
   * reasoning as Director's mid-chapter steps: 'setup-door' and
   * 'export-tile' are both 'on-action' on a button whose real onClick already
   * opens its sheet (ProjectScreen's `setSetupOpen`, ExportBar's
   * `setExportOpen`), so the tap that advances the step is the SAME tap that
   * opens it. What DOES need this file's help is the one seam between them:
   * 'export-folder's target (`FootageFolderSection`) lives in the Setup
   * sheet, not the Export one its own chapter is walking, and the two sheets
   * cannot both be open — the Export sheet stacked on top would leave
   * TourSpotlight's own occlusion guard (`isReachable`) unable to reach a
   * target sitting underneath it, drawing nothing. So leaving
   * 'export-formats' swaps Export shut for Setup open, and leaving
   * 'export-folder' (the chapter's last step) closes Setup again, so the
   * chapter bar lands back over a clean ProjectScreen exactly like Director's
   * `nav.pop()` off 'keep' does. Setup's own last step ('setup-tags') gets
   * the same courtesy, closing the sheet it opened.
   */
  function advance(): void {
    if (!activeChapterId || !demo) return;
    const chapter = findChapter(activeChapterId);
    if (!chapter) return;
    const current = chapter.steps[stepIndex];
    if (!current) return;
    if (chapter.id === 'director') {
      if (current.id === 'scene' && demo.slate) {
        nav.push({ name: 'rolling', project: demo.project, slate: demo.slate });
      } else if (current.id === 'keep') {
        nav.pop();
      }
    } else if (chapter.id === 'setup') {
      if (current.id === 'setup-tags') {
        requestSetupSheet(false);
      }
    } else if (chapter.id === 'export') {
      if (current.id === 'export-formats') {
        requestExportSheet(false);
        requestSetupSheet(true);
      } else if (current.id === 'export-folder') {
        requestSetupSheet(false);
      }
    }
    track('tour', { action: 'advance', chapter: chapter.id, step: current.id });
    const next = nextStepIndex(stepIndex, chapter.steps.length);
    if (next === null) {
      // THIS CHAPTER IS DONE. Mark it now, not on some later confirmation —
      // same reasoning `markTourDone` always used: a reload right here must
      // never resume into a stale step of a chapter already finished.
      // Unlike the old single-chapter tour, finishing a chapter does not
      // finish the WHOLE tour — it returns to the bar so another one (or
      // Done) can be picked.
      track('tour', { action: 'chapter_completed', chapter: chapter.id, step: current.id });
      markChapterDone(chapter.id);
      setCompleted((prev) => {
        const next = new Set(prev);
        next.add(chapter.id);
        return next;
      });
      clearActiveTourStep();
      setActiveChapterId(null);
      setStepIndex(0);
      setMenuShowing(true);
      return;
    }
    setStepIndex(next);
    saveActiveTourStep(chapter.id, next, demo.project.id);
  }

  /** The finish card's own Finish button (and its backdrop dismiss — closing
   *  it unread means the same thing). The tour is already marked done (see
   *  `exitTour` above); this only closes the card and hands the operator back
   *  to Home, the same place a cold launch lands (nav.ts's INITIAL_TAB). */
  function finishTour(): void {
    setFinishShowing(false);
    nav.switchTab('home', { reset: true });
  }

  // RESUME. Runs once, at mount. Cold launch always lands on Home (nav.ts),
  // so a tour interrupted mid-flight (the tab reloaded) cannot be put back on
  // the exact live screen it was on — only a step inside its own chapter's
  // `resumableStepIds` is safe to resume, because whatever earns a chapter
  // that entry has already written its proof to the store by the time that
  // step can be reached. Director carries none in Phase A (see
  // DIRECTOR_RESUMABLE_STEP_IDS's own header in tourSteps.ts), so this
  // effect currently always clears — the plumbing is here for the chapter
  // that first earns a real entry.
  useEffect(() => {
    const saved = readActiveTourStep();
    if (!saved || isTourDone() || !isTourChapterId(saved.chapterId)) {
      clearActiveTourStep();
      return;
    }
    const chapter = findChapter(saved.chapterId);
    if (!chapter) {
      clearActiveTourStep();
      return;
    }
    const idx = clampStepIndex(saved.index, chapter.steps.length);
    const step = chapter.steps[idx];
    if (!step || !chapter.resumableStepIds?.has(step.id)) {
      clearActiveTourStep();
      return;
    }
    if (!canStartTour(route.name === 'rolling')) return; // try again next load
    let alive = true;
    void (async () => {
      const project = await store.getProject(saved.projectId);
      if (!alive) return;
      if (!project) {
        clearActiveTourStep();
        return;
      }
      setDemo({ project, slate: null });
      setActiveChapterId(chapter.id);
      setStepIndex(idx);
      track('tour', { action: 'resumed', chapter: chapter.id, step: step.id });
      nav.switchTab('projects', { reset: true });
      nav.push({ name: 'project', project });
    })();
    return () => {
      alive = false;
    };
    // Mount-only by design — see the comment above.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useTourStartRequests(() => void start());

  // THE AUTO-OFFER. Dark until TOUR_AUTOSTART flips true — see that
  // constant's header. Every branch below short-circuits on the very first
  // line while it is false, so this costs nothing in the shipped app: no
  // store read, no render, nothing latched.
  useEffect(() => {
    if (!TOUR_AUTOSTART) return;
    if (activeChapterId || menuShowing || offering || offerLatchedRef.current) return;
    const rolling = route.name === 'rolling';
    if (rolling) return;
    let alive = true;
    void (async () => {
      const takeCount = await countAllTakes();
      if (!alive) return;
      const show = shouldOfferTour({
        autostart: TOUR_AUTOSTART,
        tourDone: isTourDone(),
        onboardingDone: isOnboardingDone(),
        rolling,
        takeCount,
      });
      if (show) {
        offerLatchedRef.current = true;
        setOffering(true);
      }
    })();
    return () => {
      alive = false;
    };
  }, [route.name, activeChapterId, menuShowing, offering]);

  const activeChapter = activeChapterId ? findChapter(activeChapterId) : undefined;
  const step = activeChapter && demo ? activeChapter.steps[stepIndex] : undefined;

  return (
    <>
      {step && activeChapter && (
        <TourSpotlight
          step={step}
          stepNumber={stepIndex + 1}
          totalSteps={activeChapter.steps.length}
          onAdvance={advance}
          onSkip={exitTour}
        />
      )}
      {menuShowing && demo && (
        <TourChapterMenu completed={completed} onSelect={selectChapter} onDone={exitTour} />
      )}
      {/* THE FINISH CARD. A plain centred Sheet, not a TourSpotlight step —
          it has no real element to ring, and it needs to stand on its own
          regardless of whatever screen the operator exited from. One button:
          Finish marks nothing further (the tour is already done — see
          `exitTour` above) and hands back to Home. */}
      {finishShowing && (
        <Sheet title="That chapter's a wrap" onClose={finishTour}>
          <p className="camnote" style={{ marginTop: 0 }}>
            You ran a real take start to finish — nothing here was a demo. The rest of the tour picks
            up right where you left off, whenever you come back for it from Settings.
          </p>
          <div className="sheet__actions">
            <SheetClose className="btn btn--go" onClose={finishTour}>
              Finish
            </SheetClose>
          </div>
        </Sheet>
      )}
      {offering && (
        <Sheet
          title="Take a 2-minute tour?"
          onClose={() => {
            markTourDone();
            setOffering(false);
          }}
        >
          <p className="camnote" style={{ marginTop: 0 }}>
            A real example shoot, chapter by chapter — start with Director: roll, mark, tag, cut.
          </p>
          <div className="sheet__actions">
            <SheetClose
              className="btn btn--ghost"
              onClose={() => {
                markTourDone();
                setOffering(false);
              }}
            >
              Not now
            </SheetClose>
            <button
              type="button"
              className="btn btn--go"
              onClick={() => {
                setOffering(false);
                void start();
              }}
            >
              Take it
            </button>
          </div>
        </Sheet>
      )}
    </>
  );
}

/**
 * Every take on this phone, across every project. Mirrors Onboarding.tsx's
 * own (unexported) `countTakes` — same walk, same "null means the read never
 * happened, not zero" rule — kept as its own copy rather than importing that
 * one: the two flows are only allowed to share the store's contract, not each
 * other's internals.
 */
async function countAllTakes(): Promise<number | null> {
  try {
    const projects = await store.listProjects();
    const perProject = await Promise.all(
      projects.map(async (p) => {
        const slates = await store.listSlates(p.id);
        const perSlate = await Promise.all(slates.map((sl) => store.listTakes(sl.id)));
        return perSlate.reduce((n, list) => n + list.length, 0);
      }),
    );
    return perProject.reduce((n, c) => n + c, 0);
  } catch {
    return null;
  }
}
