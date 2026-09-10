// STEP DATA FOR EVERY CHAPTER. Pure data, no imports, same reason
// onboardingRules.ts has none: a step list is worth being able to state a
// test about without mounting a screen or touching localStorage.
//
// A "step" names a real element on a real screen (`target`, a `data-tour`
// id — see TOUR_IDS below) and how it is left: `'next-button'` is a caption
// you read and dismiss, `'on-action'` only moves on once the operator has
// actually done the thing — the real ROLL, the real CUT, the real tap. The
// engine that walks a chapter's list lives in TourController.tsx; the
// overlay that draws a step lives in TourSpotlight.tsx; which steps belong to
// which chapter lives in tourChapters.ts. This file only says what each stop
// is for.
//
// TWO STEPS CAN SHARE ONE TARGET ON PURPOSE. 'roll' and 'cut' both point at
// TOUR_IDS.rollCut — it is the SAME physical button on RollingScreen.tsx
// (ROLL becomes CUT the instant a take starts rolling). 'mark' and
// 'mark-out' do the same thing on TOUR_IDS.markIn — the button relabels
// itself MARK OUT the instant a range is armed (see RollingScreen.tsx's
// `markInOut`), so rather than swap the element's own `data-tour` value
// between the two — which would race the tap that changes it, since the
// engine's on-action listener has to still see the OLD value at the instant
// of that exact click — the tour rides the one id both moments, exactly the
// way the real screen does: one control, two moments, twice over.

/** Where a `data-tour` anchor id is spent. One source of truth, so a step
 *  here and the attribute on the real element can never drift apart under a
 *  rename — both sides import this object rather than typing the string. */
export const TOUR_IDS = {
  /** ProjectScreen.tsx — the first scene card in the scene list. */
  sceneFirst: 'tour-scene-first',
  /** RollingScreen.tsx — the big ROLL/CUT button. One element, two faces. */
  rollCut: 'tour-roll-cut',
  /** RollingScreen.tsx — MARK IN / MARK OUT. One element, two faces, same
   *  reason as rollCut above. */
  markIn: 'tour-mark-in',
  /** RollingScreen.tsx — the inline field that opens the instant a marked
   *  in→out range is closed (`rangeLabelTarget`), naming the range. */
  rangeName: 'tour-range-name',
  /** RollingScreen.tsx — the tag-pad container (coverage grid, key-moment
   *  list, or the flat quick-tag grid on a scene with no breakdown). */
  tags: 'tour-tags',
  /** RollingScreen.tsx — PostCutSheet's KEEP button (and its false-start
   *  sibling, "Stop rolling", for the rare tour take cut inside two
   *  seconds — see that component's own comment on FALSE_START_MS). */
  keep: 'tour-keep',
  /** ProjectScreen.tsx — the Export tile. Spent by EXPORT_STEPS' own
   *  'export-tile', below. */
  exportTile: 'tour-export-tile',
  /** ProjectScreen.tsx — the CSV row inside the Export sheet. Spent by
   *  EXPORT_STEPS' 'export-formats'. */
  exportCsv: 'tour-export-csv',
  /** ProjectScreen.tsx — the "..." button that opens the Setup sheet
   *  (`setSetupOpen`). Setup chapter's own door, same role exportTile plays
   *  for Export. */
  setupDoor: 'tour-setup-door',
  /** ProjectScreen.tsx, inside the Setup sheet — the 1/2/3/4 camera-count
   *  control (`ClipCounterSection`'s `.camcount` group). */
  setupCameras: 'tour-setup-cameras',
  /** ProjectScreen.tsx, inside the Setup sheet — `QuickTagsSection`, the
   *  project's default tag vocabulary (what Director's own 'tags' step later
   *  offers on the roll screen). */
  setupTags: 'tour-setup-tags',
  /** ProjectScreen.tsx — `FootageFolderSection`. Lives inside the SETUP
   *  sheet, not the Export one (see TourController.tsx's 'export' branch in
   *  `advance` for why the Export chapter has to swap sheets to reach it) —
   *  named `exportFolder` because it's the Export chapter's own step, not
   *  the Setup chapter's; the folder is what an exported XML relinks
   *  against, which is an export concern that happens to be edited from the
   *  Setup sheet. */
  exportFolder: 'tour-export-folder',
} as const;

export type TourTargetId = (typeof TOUR_IDS)[keyof typeof TOUR_IDS];

/** Which side of the target the caption card opens toward. 'auto' picks top
 *  or bottom off which half of the viewport the target sits in — see
 *  TourSpotlight.tsx's `placeCard`. */
export type TourPlacement = 'top' | 'bottom' | 'auto';

/** How a step is left. 'next-button' is watch-and-dismiss; 'on-action' only
 *  advances once the real element has actually been tapped — TourSpotlight
 *  listens for that click itself, on the real DOM node, so the app never
 *  has to know the tour exists. */
export type TourAdvanceMode = 'next-button' | 'on-action';

export interface TourStep {
  /** Stable, never shown — used for lookups and for `clapper.tourStep`.
   *  Unique within its own chapter; chapters do not currently share ids, but
   *  nothing requires that they never could. */
  id: string;
  target: TourTargetId;
  title: string;
  body: string;
  placement: TourPlacement;
  advance: TourAdvanceMode;
}

/**
 * THE DIRECTOR CHAPTER'S SPINE — a scene, a take, a tagged and kept take,
 * exactly one real move at a time. Ordered to match the screen, not a
 * checklist: every step from 'mark' through 'tags' lives inside
 * RollingScreen.tsx's own `{rolling && (...)}` block, which is why 'tags'
 * sits BEFORE 'cut' rather than after 'keep' — the tag pads simply do not
 * exist in the DOM once a take is cut (see TourSpotlight.tsx's "target not
 * found renders nothing"), so a step planted after 'keep' pointing at them
 * would draw no ring, offer no Next, and strand the tour mid-chapter.
 */
export const DIRECTOR_STEPS: readonly TourStep[] = [
  {
    id: 'scene',
    target: TOUR_IDS.sceneFirst,
    title: 'This is your set',
    body: 'A real project — scenes, shots, takes, exactly like a shoot day. Next opens the first scene.',
    placement: 'bottom',
    advance: 'next-button',
  },
  {
    id: 'roll',
    target: TOUR_IDS.rollCut,
    title: 'Start a take',
    body: 'Tap ROLL. For real — that starts the clock.',
    placement: 'top',
    advance: 'on-action',
  },
  {
    id: 'mark',
    target: TOUR_IDS.markIn,
    title: 'Mark it live',
    body: 'Something worth flagging just happened? Tap MARK IN while it happens, not after.',
    placement: 'top',
    advance: 'on-action',
  },
  {
    id: 'mark-out',
    // Same physical button as 'mark' — see the file header on why this is
    // deliberate rather than a missing anchor.
    target: TOUR_IDS.markIn,
    title: 'Close it out',
    body: "Whenever it's over, tap the same button again — now it says MARK OUT.",
    placement: 'top',
    advance: 'on-action',
  },
  {
    id: 'name-range',
    target: TOUR_IDS.rangeName,
    title: 'Name it',
    body: 'That marked moment just became a range. Give it a word or two so the editor knows what it is — Done closes it, optional either way.',
    placement: 'top',
    // A real tap closes this, not a caption read: Done is the dominant path
    // on a phone, and tapping into the field itself also counts (harmless —
    // the input stays live under the tour's own pointer-events:none overlay,
    // see TourSpotlight.tsx's header). The one gap is a physical Enter key
    // with no click at all — recoverable the same way any other on-action
    // step is: mark another range and the target remounts.
    advance: 'on-action',
  },
  {
    id: 'tags',
    target: TOUR_IDS.tags,
    title: 'Two kinds of tag',
    body: 'Coverage tags are shot-specific — WIDE, CU, INSERT. Key moments are film-specific — the beats this scene actually needs. Tap either any time you are rolling.',
    placement: 'top',
    advance: 'next-button',
  },
  {
    id: 'cut',
    target: TOUR_IDS.rollCut,
    title: 'CUT',
    body: 'Tap CUT. The take lands the instant you do — nothing left to save.',
    placement: 'top',
    advance: 'on-action',
  },
  {
    id: 'keep',
    target: TOUR_IDS.keep,
    title: 'The take',
    body: 'Keep it. Good takes stay in the log; Discard drops the bad ones clean.',
    placement: 'top',
    advance: 'on-action',
  },
] as const;

/** No Director step is safe to land on after an interrupted tour (a reload
 *  mid-flight): every one of them needs either a take actually in progress
 *  or a sheet that reload cannot hand back (PostCutSheet, the inline range
 *  field) — unlike the old export steps this chapter no longer carries,
 *  nothing here is reachable from a cold ProjectScreen alone. See
 *  TourController.tsx's resume effect for where this is spent, and
 *  tourChapters.ts for how a future chapter (Export, once Phase B lands its
 *  own two already-real anchors — TOUR_IDS.exportTile / exportCsv) can carry
 *  a non-empty set of its own. */
export const DIRECTOR_RESUMABLE_STEP_IDS: ReadonlySet<string> = new Set();

/**
 * THE SETUP CHAPTER — one door, two things behind it worth naming: how many
 * cameras, and the tag vocabulary every scene on this project reuses. Three
 * steps, not four: FpsSection and the footage folder are real controls in the
 * same sheet but neither earns its own stop here — frame rate is a one-time
 * decision made at project creation already, and the footage folder is the
 * EXPORT chapter's own step (`tour-export-folder`, below) even though it
 * lives in this sheet; see TourController.tsx's 'export' branch in `advance`
 * for why.
 *
 * 'setup-door' is the only step whose target sits on ProjectScreen itself —
 * the other two exist only once the Setup sheet is open, which nothing here
 * has to arrange: 'setup-door' is 'on-action', so the real tap that advances
 * it is the SAME tap that opens the sheet (ProjectScreen's own
 * `setSetupOpen(true)`), exactly the way Director's 'roll' step mounts MARK
 * IN just by being tapped for real.
 */
export const SETUP_STEPS: readonly TourStep[] = [
  {
    id: 'setup-door',
    target: TOUR_IDS.setupDoor,
    title: 'One door to setup',
    body: 'Cameras, sound, the tag vocabulary, the footage folder — everything you set once at the top of a shoot lives behind this. Tap it.',
    placement: 'bottom',
    advance: 'on-action',
  },
  {
    id: 'setup-cameras',
    target: TOUR_IDS.setupCameras,
    title: 'How many cameras',
    body: 'One camera rolling solo, or a whole multi-cam rig — pick a count and each one gets its own lettered clip counter, A, B, C.',
    placement: 'top',
    advance: 'next-button',
  },
  {
    id: 'setup-tags',
    target: TOUR_IDS.setupTags,
    title: 'The house tags',
    body: 'This is the tag vocabulary the roll screen offers on every take in this project — set it once here instead of per scene.',
    placement: 'top',
    advance: 'next-button',
  },
] as const;

/** Only 'setup-door' is safe to resume onto after a reload: its target sits
 *  on ProjectScreen itself, reachable cold the same way `demo.project` always
 *  is. 'setup-cameras' and 'setup-tags' both need the Setup sheet open, and a
 *  reload cannot hand that local component state back — see
 *  TourController.tsx's resume effect. */
export const SETUP_RESUMABLE_STEP_IDS: ReadonlySet<string> = new Set(['setup-door']);

/**
 * THE EXPORT CHAPTER — the tile nothing used to lead down to, what the free
 * CSV buys you versus the paid unlocks, and the one field that turns an
 * offline import into an online one. Three steps, one seam: 'export-folder's
 * target (`FootageFolderSection`) lives in the SETUP sheet, not the Export
 * one it is conceptually part of — see TourController.tsx's 'export' branch
 * in `advance`, which closes the Export sheet and opens Setup between
 * 'export-formats' and this step so TourSpotlight's occlusion guard
 * (TourSpotlight.tsx's `isReachable`) finds a real, unstacked target rather
 * than drawing nothing.
 */
export const EXPORT_STEPS: readonly TourStep[] = [
  {
    id: 'export-tile',
    target: TOUR_IDS.exportTile,
    title: 'Where the day becomes a file',
    body: 'At wrap, this tile is what hands the shoot to an editor. Tap it.',
    placement: 'top',
    advance: 'on-action',
  },
  {
    id: 'export-formats',
    target: TOUR_IDS.exportCsv,
    title: 'CSV is free',
    body: 'Any signed-in account exports CSV, forever, no limit. PDF, Premiere and Resolve are the paid unlocks, one tap below this.',
    placement: 'top',
    advance: 'next-button',
  },
  {
    id: 'export-folder',
    target: TOUR_IDS.exportFolder,
    title: 'Point it at the footage',
    body: 'Set the folder the cards get copied to on the edit machine, and the exported XML relinks every clip in Premiere online instead of offline.',
    placement: 'top',
    advance: 'next-button',
  },
] as const;

/** Only 'export-tile' is safe to resume onto after a reload — same reasoning
 *  as SETUP_RESUMABLE_STEP_IDS above: it is the one step in this chapter
 *  whose target sits on ProjectScreen itself with no sheet open first.
 *  'export-formats' needs the Export sheet open and 'export-folder' needs the
 *  Setup sheet open in its place; neither survives a reload. */
export const EXPORT_RESUMABLE_STEP_IDS: ReadonlySet<string> = new Set(['export-tile']);
