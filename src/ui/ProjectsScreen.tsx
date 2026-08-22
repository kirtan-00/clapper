// The projects list. Since the shell landed, this screen is the list and its
// stack, and nothing else — the settings-shaped things that used to be welded
// to the bottom of it (the guide, Restore, Feedback, the account row) now live
// on the Settings and Account tabs. Shotlist import is still here on purpose:
// the spec moves it to Home, which another agent owns, and leaving it
// reachable beats making it unreachable in the meantime. (The install nudge
// used to sit here too. It is gone — the first-open flow in ui/Onboarding.tsx
// asks that question once, from the shell, instead of twice from two tabs.) The
// shotlist flow itself is no longer written here: this file carried a private
// near-copy of it that handed its pack to what was then a fourteen-field New
// project sheet, so the same job looked like two different products depending
// on which tab you started from. It mounts <ShotlistSheet> now, same as Home —
// and the blank-project path is <NewProjectSheet>, five stages on the same
// shared rail, rather than the form that used to be written at the bottom of
// this file.
//
// THE SHAPE, since the repaint: one dark mass for the shoot that is happening,
// quiet ivory rows for everything else, and a real filing system underneath.
// The hierarchy is carried by MATERIAL rather than by size, which is what makes
// it survive a director with forty projects and one shoot day — a bigger card
// stops being bigger once there are three of them.

import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type CSSProperties,
  type PointerEvent as ReactPointerEvent,
} from 'react';
import type { Project } from '../types';
import { store } from '../store';
import { Sheet, SheetClose, Confirm, Rail } from './common';
import { ShotlistSheet } from './ShotlistSheet';
import { NewProjectSheet } from './NewProjectSheet';
import { ScreenHeader } from './glist';
import { lastActivity } from './newRoll';
import { PlusMark, ListMark } from './marks';
import * as haptics from './haptics';

export interface Row {
  project: Project;
  takeCount: number;
  sceneCount: number;
  /** Total shots across every scene's breakdown. 0 = no shot list anywhere
   *  on this project - the one condition that turns the progress bar off
   *  rather than have it measure a denominator that isn't there. */
  shotTotal: number;
  /** Shots carrying at least one KEPT (status 'good') take. See
   *  `summarizeProject` in store/util.ts for the exact rule. */
  shotsInCan: number;
  /** Scenes not yet fully covered by the shot list above. Only meaningful -
   *  and only shown - once `shotTotal` says there is a bar to go with it. */
  scenesLeft: number;
  /** Every scene's name, for the search box below. Free: the read that
   *  builds the counts above already has them. */
  sceneNames: string[];
}

/**
 * The date as the list wants it: a WEEKDAY inside the last week, "28 Jul"
 * beyond it, and the year only once it stops being obvious.
 *
 * "Aug 17, 2026" is three facts in a column where the eye is scanning for one.
 * Inside a week a director thinks in weekdays — "that was Monday" — and past
 * that the day of the month is the landmark; the year is noise until it isn't.
 */
function fmtWhen(now: number, ms: number): string {
  const d = new Date(ms);
  if (startOfDay(ms) === startOfDay(now)) return 'Today';
  const days = (now - ms) / DAY_MS;
  if (days < 7) return d.toLocaleDateString(undefined, { weekday: 'short' });
  if (d.getFullYear() === new Date(now).getFullYear()) {
    return d.toLocaleDateString(undefined, { day: 'numeric', month: 'short' });
  }
  return d.toLocaleDateString(undefined, { month: 'short', year: 'numeric' });
}

// Recency buckets, seeded-and-measured against a real 25+ project list: with
// ONE creation-order pile a director scrolling for a shoot from six weeks ago
// has no landmark to stop at. Four bands mirror the Photos/Files idiom
// everyone's phone already teaches — the smallest structure that turns a
// scroll into a scan. A single band renders no header at all (see `grouped`
// below): a lone pile has nothing to be distinguished from, so a phone with a
// handful of projects touched around the same time looks exactly as plain as
// it does today.
const BUCKETS = ['Today', 'This week', 'This month', 'Earlier'] as const;
type Bucket = (typeof BUCKETS)[number];
const DAY_MS = 86400000;

/** Midnight, local time, for the day `ms` falls on — CALENDAR day, not a
 *  rolling 24h window. A take logged at 11pm and one logged at 6am the next
 *  morning are eight hours apart and both "yesterday" by the clock, but the
 *  crew calls the second one a new day; a stopwatch boundary would still be
 *  calling the first one TODAY at 5am the morning after. */
function startOfDay(ms: number): number {
  const d = new Date(ms);
  d.setHours(0, 0, 0, 0);
  return d.getTime();
}

function bucketFor(now: number, p: Project): Bucket {
  const touched = lastActivity(p);
  if (startOfDay(touched) === startOfDay(now)) return 'Today';
  const days = (now - touched) / DAY_MS;
  if (days < 7) return 'This week';
  if (days < 30) return 'This month';
  return 'Earlier';
}

/** How much of a shoot a row is, in one line: 24 fps · 2 cams + sound · 8 scenes.
 *  HERO ONLY, now - the row it is the only project on screen, so the rig it
 *  is shot on earns the line. Everywhere else this screen is asking "which
 *  one, and how far along", not "on what", so plain rows carry `rowMeta`'s
 *  line instead (see below). */
function shapeOf(row: Row): string {
  const { project, sceneCount } = row;
  const cams = project.cameras?.length ?? 1;
  const parts = [
    `${project.fps} fps`,
    `${cams} cam${cams === 1 ? '' : 's'}${project.sound ? ' + sound' : ''}`,
    `${sceneCount} scene${sceneCount === 1 ? '' : 's'}`,
  ];
  return parts.join(' · ');
}

// ========================================================== THE BAR & THE
// ROW FACTS. THE OWNER'S OWN METRIC: shots in the can - a shot with a first
// KEPT (status 'good') take - out of the shot breakdown total. Scanning
// thirty projects for "the shoot I was on last Tuesday" wants three things
// most: recency (the band headers and `fmtWhen` already carry that), the day
// number, and whether it's finished. This is where those two plus the bar's
// numbers turn into the words a row actually prints - pure, so the format is
// pinned by ProjectsScreen.test.ts rather than by eye.

export interface RowMeta {
  day: number;
  /** WRAP DAY was just pressed and nothing has rolled on the new day since -
   *  the same test ProjectScreen's own "undo wrap" button already runs (see
   *  `canUndo` there). NOT `openShootDay.wrappedAt`: `wrapShootDay` (see
   *  store/util.ts) advances `openShootDay` to the NEXT, unwrapped day the
   *  instant it wraps the one before it, so that field is never true on a
   *  project's live, persisted state - the wrapped day's own `wrappedAt`
   *  survives only inside `pendingWrapUndo.previousDay`, a snapshot for the
   *  undo button, not a status flag. `pendingWrapUndo` present AND the new
   *  day still untouched IS "wrapped, nothing since" - it reverts to false
   *  the instant a take lands, same as the undo button does.
   *
   *  Never coloured with the accent when shown: that word is spent once
   *  already (see `.pj-key__live` in projects.css), and a status flag is a
   *  fact, not the one thing on the screen worth interrupting a scan for. */
  wrapped: boolean;
  /** False = no shot list anywhere on this project. Draw no bar; a bar with
   *  no real denominator is worse than none. */
  hasBar: boolean;
  pct: number;
  /** "14/22 shots" - empty when `hasBar` is false. */
  fractionLabel: string;
  /** "2 scenes left" / "every scene covered" - empty when `hasBar` is false. */
  scenesLeftLabel: string;
  /** Scenes exist, but none of them has a breakdown - the fact that explains
   *  why there is no bar, said once next to the name rather than left for
   *  the reader to infer from an absence. */
  noShotList: boolean;
  /** The one line a plain row prints under its bar (or instead of one). */
  metaLine: string;
}

export function rowMeta(project: Project, row: Row): RowMeta {
  const day = project.openShootDay?.index ?? (row.takeCount === 0 ? 0 : 1);
  const wrapped = !!project.pendingWrapUndo && project.openShootDay?.firstTakeAt === undefined;
  const hasBar = row.shotTotal > 0;
  const noShotList = !hasBar && row.sceneCount > 0;
  const pct = hasBar ? Math.round((row.shotsInCan / row.shotTotal) * 100) : 0;
  const fractionLabel = hasBar ? `${row.shotsInCan}/${row.shotTotal} shots` : '';
  const scenesLeftLabel = hasBar
    ? row.scenesLeft === 0
      ? 'every scene covered'
      : `${row.scenesLeft} scene${row.scenesLeft === 1 ? '' : 's'} left`
    : '';
  const takeWord = row.takeCount === 1 ? 'take' : 'takes';
  const sceneWord = row.sceneCount === 1 ? 'scene' : 'scenes';

  // "Wrapped" LEADS the line rather than sitting beside the name. Next to
  // the name it was a flex:none sibling squeezing a flex:1 one - on a name
  // as ordinary as "The Long Wait" it crushed the name down to "The…", the
  // one thing a scan actually needs. Leading the meta line instead costs it
  // nothing: this line already truncates most-load-bearing-first (see
  // fmtWhen's own note above), so on a narrow phone it is "Wrapped…" that
  // gives, never the name.
  const parts: string[] = [];
  if (wrapped) parts.push('Wrapped');
  if (row.takeCount === 0) {
    // The day has not opened yet (see the fallback above) - "Day 0" is
    // arithmetic about nothing, so this line drops the day and the take
    // count both, the same call HeroMass's cold state already makes.
    parts.push('No takes yet');
    if (row.sceneCount > 0) parts.push(`${row.sceneCount} ${sceneWord}`);
  } else if (hasBar) {
    parts.push(`Day ${day}`, `${row.takeCount} ${takeWord}`, scenesLeftLabel);
  } else {
    parts.push(`Day ${day}`, `${row.takeCount} ${takeWord}`, `${row.sceneCount} ${sceneWord}`);
  }
  const metaLine = parts.join(' · ');

  return { day, wrapped, hasBar, pct, fractionLabel, scenesLeftLabel, noShotList, metaLine };
}

/**
 * The Projects search box's match rule: project names always, and scene
 * names too. CHOICE, and why: a director hunting for "the diner scene" is
 * hunting ACROSS projects, not inside the one they're already in (that
 * search already exists, scoped, on the Clip log) - and the scene names cost
 * nothing extra to check, since `summarizeProject` reads them off the same
 * slates it counts shots from (see `sceneNames` on Row).
 *
 * Shot CODES are deliberately left OUT. "5.31" only means something inside
 * the one project that printed it - cross-project it collides constantly
 * (every shoot has a shot "1.1") and adds noise a name or scene match never
 * would. Matching them would also cost real work for no real recall: it is
 * not data this screen already has in hand the way scene names are.
 */
export function matchesQuery(query: string, project: Project, row: Row): boolean {
  const q = query.trim().toLowerCase();
  if (!q) return true;
  if (project.name.toLowerCase().includes(q)) return true;
  return row.sceneNames.some((name) => name.toLowerCase().includes(q));
}

// ============================================================== FILING ======
//
// A real filing system, kept entirely on the device and entirely OUT of the
// Project record.
//
// WHY NOT A FIELD ON `Project`. Which folder a shoot sits in is not a fact
// about the shoot — it is a fact about how one person likes their list. It
// never exports, never syncs, never reaches a PDF, and two people looking at
// the same backup should be free to file it differently. Putting it in the
// store would also mean a schema migration and a write on every drag, which is
// a lot of machinery to move a card six inches.
//
// Guarded exactly the way theme.ts guards its own key: storage throws outright
// in Safari private mode and with cookies blocked, and a filing preference is
// never worth taking the app down for. Every failure resolves to "unfiled",
// which is the shape the list had before folders existed.

const FILING_KEY = 'clapper.folders.v1';

/** The one non-folder destination. Never a folder id, so it can never collide. */
const ARCHIVE = '__archive__';

interface Folder {
  id: string;
  name: string;
  order: number;
}

interface Filing {
  folders: Folder[];
  /** projectId -> folder id, or ARCHIVE. Absent = unfiled. */
  filed: Record<string, string>;
}

const EMPTY_FILING: Filing = { folders: [], filed: {} };

function readFiling(): Filing {
  try {
    const raw = localStorage.getItem(FILING_KEY);
    if (!raw) return EMPTY_FILING;
    const parsed = JSON.parse(raw) as Partial<Filing>;
    return {
      folders: Array.isArray(parsed.folders) ? parsed.folders : [],
      filed: parsed.filed && typeof parsed.filed === 'object' ? parsed.filed : {},
    };
  } catch {
    return EMPTY_FILING;
  }
}

function writeFiling(next: Filing): void {
  try {
    localStorage.setItem(FILING_KEY, JSON.stringify(next));
  } catch {
    /* the filing still works for this session, it just will not survive it */
  }
}

/**
 * AUTO-ARCHIVE, round 2 §folders — implemented as a READ, not a write.
 *
 * The pitch asks for "auto-files 30 days after wrap, because on-set apps never
 * get housekeeping time". A background job cannot be the answer: this app is
 * offline-first and is opened on a set, in a hurry, weeks apart — there is no
 * moment it can be trusted to run, and a sweep that fires on launch would
 * rewrite the user's list while they are looking for something in it.
 *
 * So archive is DERIVED. A project nobody has filed and nobody has touched for
 * thirty days is in the Archive, and the instant it is touched again it walks
 * straight back out — which is the behaviour the feature was actually asking
 * for, with no state to get stale and nothing to undo.
 *
 * GENERALISED FROM "after wrap" TO "after neglect" deliberately. Wrap is a
 * button a human presses, and the shoots most in need of filing themselves are
 * exactly the ones nobody remembered to wrap. Keying on the wrap alone would
 * leave every abandoned recce sitting at the top of the list forever, which is
 * the mess the feature exists to clear.
 *
 * An EXPLICIT filing always wins. A decision a person made is never overridden
 * by a rule about time — including filing something into the Archive by hand,
 * which is how "get this out of my face" works and why it has to survive being
 * touched.
 */
const ARCHIVE_AFTER_MS = 30 * DAY_MS;

function isAutoArchived(now: number, p: Project): boolean {
  return now - lastActivity(p) >= ARCHIVE_AFTER_MS;
}

/** Where a project lives: a folder id, ARCHIVE, or '' for the unfiled bands. */
function placeOf(filing: Filing, now: number, p: Project): string {
  const explicit = filing.filed[p.id];
  if (explicit) {
    // A folder that was deleted out from under a project leaves it unfiled
    // rather than invisible.
    if (explicit === ARCHIVE) return ARCHIVE;
    return filing.folders.some((f) => f.id === explicit) ? explicit : '';
  }
  return isAutoArchived(now, p) ? ARCHIVE : '';
}

// ---------------------------------------------------------------- marks ----
// One weight, one 24 grid, round caps and joins, currentColor — the same hand
// glist.tsx and TabTray draw in, so a folder here and a chevron there read as
// one set. Local rather than added to marks.tsx: these three are the filing
// system's own vocabulary and nothing outside this screen has asked for them.

const STROKE = {
  fill: 'none',
  stroke: 'currentColor',
  strokeWidth: 1.75,
  strokeLinecap: 'round' as const,
  strokeLinejoin: 'round' as const,
};

function FolderMark(props: { size?: number }) {
  const s = props.size ?? 17;
  return (
    <svg viewBox="0 0 24 24" width={s} height={s} aria-hidden="true" focusable="false">
      <path d="M3 7.6A2.1 2.1 0 0 1 5.1 5.5h4.2l2.4 2.7h7.2A2.1 2.1 0 0 1 21 10.3v8A2.1 2.1 0 0 1 18.9 20.4H5.1A2.1 2.1 0 0 1 3 18.3z" {...STROKE} />
    </svg>
  );
}

/** A box with a lid: the crate a wrapped shoot goes into. */
function ArchiveMark(props: { size?: number }) {
  const s = props.size ?? 17;
  return (
    <svg viewBox="0 0 24 24" width={s} height={s} aria-hidden="true" focusable="false">
      <rect x="3" y="4" width="18" height="5" rx="1.4" {...STROKE} />
      <path d="M5 9v8.6A2.1 2.1 0 0 0 7.1 19.7h9.8A2.1 2.1 0 0 0 19 17.6V9" {...STROKE} />
      <path d="M9.8 13h4.4" {...STROKE} />
    </svg>
  );
}

/** Opens the filing sheet. Three dots, not a chevron: this row does not go
 *  anywhere, it offers a menu — and iOS spells that with an ellipsis. */
function MoreMark() {
  return (
    <svg viewBox="0 0 24 24" width="18" height="18" aria-hidden="true" focusable="false">
      <circle cx="5.5" cy="12" r="1.6" fill="currentColor" />
      <circle cx="12" cy="12" r="1.6" fill="currentColor" />
      <circle cx="18.5" cy="12" r="1.6" fill="currentColor" />
    </svg>
  );
}

function ChevronMark(props: { down?: boolean }) {
  return (
    <svg viewBox="0 0 24 24" width="13" height="13" aria-hidden="true" focusable="false">
      <path d={props.down ? 'M5 9.5 12 16.5l7-7' : 'M9.5 5.5 16 12l-6.5 6.5'} {...STROKE} strokeWidth={2} />
    </svg>
  );
}

function TickMark() {
  return (
    <svg viewBox="0 0 24 24" width="16" height="16" aria-hidden="true" focusable="false">
      <path d="M4 12.5 9.5 18 20 6.5" {...STROKE} strokeWidth={2.2} />
    </svg>
  );
}

function PlusRowMark() {
  return (
    <svg viewBox="0 0 24 24" width="16" height="16" aria-hidden="true" focusable="false">
      <path d="M12 5v14M5 12h14" {...STROKE} strokeWidth={2} />
    </svg>
  );
}

function Grip() {
  return (
    <span className="pj-grip" aria-hidden="true">
      <i />
      <i />
      <i />
      <i />
      <i />
      <i />
    </span>
  );
}

// ================================================================= DRAG =====
//
// Long-press → lift → drop. Two-handed and fast; the ⋯ sheet is the same move
// for one hand in a glove, and both have to exist because both happen.
//
// HOW LONG A LONG-PRESS IS. 400ms, with an 8px movement cancel. Under ~350 a
// scroll flick registers as a lift and the list starts snatching cards out of
// itself; over ~500 the gesture stops feeling connected to the finger. The
// cancel is what makes the two gestures coexist on the same pixel: move first
// and it is a scroll, wait first and it is a lift.
const LIFT_MS = 400;
const LIFT_CANCEL_PX = 8;

interface DragState {
  projectId: string;
  /** Live pointer offset from where the press started. */
  dx: number;
  dy: number;
  /** The drop zone under the finger right now: folder id, ARCHIVE, or ''. */
  over: string;
}

export function ProjectsScreen(props: { onOpen: (project: Project) => void }) {
  const [rows, setRows] = useState<Row[] | null>(null);
  const [creating, setCreating] = useState(false);
  const [loadingScript, setLoadingScript] = useState(false);
  const [filing, setFiling] = useState<Filing>(() => readFiling());
  // Which folders are open. Absent = closed; a folder opens on tap and stays
  // open for the session, which is short enough that persisting it would be
  // remembering something nobody asked to be remembered.
  const [open, setOpen] = useState<Set<string>>(() => new Set());
  // The project whose "File under…" sheet is up, and the new-folder prompt.
  const [filingRow, setFilingRow] = useState<Row | null>(null);
  const [liveMsg, setLiveMsg] = useState('');
  // The search box's own text. NOT auto-focused and never revealed behind a
  // tap - see the field's own comment at the render site for why: this
  // screen opens on set, one-handed, and a keyboard nobody asked for is a
  // worse first frame than a screen with no search box at all.
  const [query, setQuery] = useState('');

  async function refresh() {
    const projects = await store.listProjects();
    // The one you touched last is the one you want — same read `startNewRoll`
    // already uses to pick where New roll lands (src/ui/newRoll.ts), reused
    // rather than sorting by creation date, which stops answering "where was
    // I" the moment a director reopens an old project for a pickup shoot.
    // Tie-break on id, the same way ClipLogScreen's take sort does, so two
    // projects that landed the same millisecond never swap places between
    // renders.
    projects.sort(
      (a, b) => lastActivity(b) - lastActivity(a) || (a.id < b.id ? 1 : a.id > b.id ? -1 : 0),
    );
    // ONE cheap read per project - two indexed table scans, no moments, no
    // per-take fan-out - never `getBundle`, which would pull every take's
    // full moment log for a list that only ever reads counts. See
    // Store.getProjectSummary and summarizeProject in store/util.ts.
    const withCounts = await Promise.all(
      projects.map(async (project) => {
        const s = await store.getProjectSummary(project.id);
        return {
          project,
          takeCount: s.takeCount,
          sceneCount: s.sceneCount,
          shotTotal: s.shotTotal,
          shotsInCan: s.shotsInCan,
          scenesLeft: s.scenesLeft,
          sceneNames: s.sceneNames,
        };
      }),
    );
    setRows(withCounts);
  }

  useEffect(() => {
    void refresh();
  }, []);

  function commitFiling(next: Filing) {
    setFiling(next);
    writeFiling(next);
  }

  /** File one project, or unfile it with `null`. */
  const fileUnder = useCallback(
    (projectId: string, place: string | null, label: string) => {
      haptics.tap();
      setFiling((prev) => {
        const filed = { ...prev.filed };
        if (place === null) delete filed[projectId];
        else filed[projectId] = place;
        const next = { ...prev, filed };
        writeFiling(next);
        return next;
      });
      setLiveMsg(label);
    },
    [],
  );

  // ------------------------------------------------------------- the drag --
  // Adapted from the scene reorder on ProjectScreen (same pointer + rAF idiom,
  // same "listeners on window so the finger can leave the element" contract).
  // What is different is the target: that drag reorders inside one list, this
  // one moves a card BETWEEN containers, so the hit test is against registered
  // drop zones rather than against sibling row centres.
  const zones = useRef<Map<string, HTMLElement>>(new Map());
  const [drag, setDrag] = useState<DragState | null>(null);
  const dragRef = useRef<{
    pointerId: number;
    projectId: string;
    startX: number;
    startY: number;
    lifted: boolean;
    timer: number | null;
    rafId: number | null;
    latest: { x: number; y: number };
  } | null>(null);

  function setZone(key: string, el: HTMLElement | null) {
    if (el) zones.current.set(key, el);
    else zones.current.delete(key);
  }

  /** Which registered zone is under this point. '' (the unfiled bands) is the
   *  fallback, so a drop in the gutter always means something. */
  function zoneAt(x: number, y: number): string {
    for (const [key, el] of zones.current) {
      const r = el.getBoundingClientRect();
      if (x >= r.left && x <= r.right && y >= r.top && y <= r.bottom) return key;
    }
    return '';
  }

  const endDrag = useCallback((commit: boolean) => {
    const meta = dragRef.current;
    dragRef.current = null;
    if (meta?.timer) window.clearTimeout(meta.timer);
    if (meta?.rafId) cancelAnimationFrame(meta.rafId);
    window.removeEventListener('pointermove', onMove);
    window.removeEventListener('pointerup', onUp);
    window.removeEventListener('pointercancel', onCancel);
    setDrag((prev) => {
      if (prev && commit && meta?.lifted) {
        const place = prev.over === '' ? null : prev.over;
        const name =
          place === null
            ? 'Unfiled'
            : place === ARCHIVE
              ? 'Archive'
              : (filingRef.current.folders.find((f) => f.id === place)?.name ?? 'a folder');
        fileUnder(prev.projectId, place, `Filed under ${name}`);
      }
      return null;
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [fileUnder]);

  // `filing` read from inside the stable pointer handlers, kept fresh each
  // render rather than re-binding three window listeners on every keystroke.
  const filingRef = useRef(filing);
  filingRef.current = filing;

  const onMove = useCallback((e: PointerEvent) => {
    const meta = dragRef.current;
    if (!meta || e.pointerId !== meta.pointerId) return;
    meta.latest = { x: e.clientX, y: e.clientY };
    if (!meta.lifted) {
      // Still inside the hold. A finger that travels is scrolling, not lifting.
      const moved = Math.hypot(e.clientX - meta.startX, e.clientY - meta.startY);
      if (moved > LIFT_CANCEL_PX) endDrag(false);
      return;
    }
    e.preventDefault();
    if (meta.rafId !== null) return;
    meta.rafId = requestAnimationFrame(() => {
      const m = dragRef.current;
      if (!m) return;
      m.rafId = null;
      setDrag((prev) =>
        prev
          ? {
              ...prev,
              dx: m.latest.x - m.startX,
              dy: m.latest.y - m.startY,
              over: zoneAt(m.latest.x, m.latest.y),
            }
          : prev,
      );
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [endDrag]);

  const onUp = useCallback(() => endDrag(true), [endDrag]);
  const onCancel = useCallback(() => endDrag(false), [endDrag]);

  function startPress(e: ReactPointerEvent<HTMLElement>, projectId: string) {
    if (e.pointerType === 'mouse' && e.button !== 0) return;
    if (dragRef.current) return;
    const startX = e.clientX;
    const startY = e.clientY;
    dragRef.current = {
      pointerId: e.pointerId,
      projectId,
      startX,
      startY,
      lifted: false,
      rafId: null,
      latest: { x: startX, y: startY },
      timer: window.setTimeout(() => {
        const meta = dragRef.current;
        if (!meta) return;
        meta.lifted = true;
        meta.timer = null;
        haptics.tap();
        setDrag({ projectId, dx: 0, dy: 0, over: zoneAt(startX, startY) });
      }, LIFT_MS),
    };
    window.addEventListener('pointermove', onMove, { passive: false });
    window.addEventListener('pointerup', onUp);
    window.addEventListener('pointercancel', onCancel);
  }

  // Belt-and-braces: a screen that unmounts mid-drag drops its listeners.
  useEffect(() => {
    return () => {
      window.removeEventListener('pointermove', onMove);
      window.removeEventListener('pointerup', onUp);
      window.removeEventListener('pointercancel', onCancel);
    };
  }, [onMove, onUp, onCancel]);

  // ------------------------------------------------------------- the shape --
  // One pass over the list into hero / folders / unfiled bands / archive.
  // `now` is captured once (not read again per row) so a card can never wander
  // bands mid-scroll while the clock ticks under it.
  const shape = useMemo(() => {
    if (!rows) return null;
    const now = Date.now();
    const byId = new Map(rows.map((r) => [r.project.id, r]));

    const archived: Row[] = [];
    const inFolder = new Map<string, Row[]>();
    const unfiled: Row[] = [];
    for (const row of rows) {
      const place = placeOf(filing, now, row.project);
      if (place === ARCHIVE) archived.push(row);
      else if (place === '') unfiled.push(row);
      else {
        const list = inFolder.get(place);
        if (list) list.push(row);
        else inFolder.set(place, [row]);
      }
    }

    // The hero is the most recently touched shoot that is not in the Archive.
    // ALWAYS one, if there is one at all: the mass is the screen's signature
    // and the first thing the eye lands on, and a list that loses it the
    // moment its owner files everything has quietly become a different screen.
    const hero = rows.find((r) => placeOf(filing, now, r.project) !== ARCHIVE) ?? null;
    const heroPlace = hero ? placeOf(filing, now, hero.project) : '';
    const heroFolder = filing.folders.find((f) => f.id === heroPlace)?.name;

    const bands = new Map<Bucket, Row[]>();
    for (const row of unfiled) {
      if (row === hero) continue;
      const b = bucketFor(now, row.project);
      const list = bands.get(b);
      if (list) list.push(row);
      else bands.set(b, [row]);
    }

    const folders = [...filing.folders]
      .sort((a, b) => a.order - b.order || (a.name < b.name ? -1 : 1))
      .map((folder) => ({
        folder,
        // The hero is shown once, at the top. Its folder still COUNTS it —
        // "3 shoots" has to keep meaning three shoots — it just does not draw
        // it twice, and the hero names the folder it came from instead.
        rows: (inFolder.get(folder.id) ?? []).filter((r) => r !== hero),
        count: (inFolder.get(folder.id) ?? []).length,
      }));

    return {
      now,
      hero,
      heroFolder,
      folders,
      bands: BUCKETS.filter((b) => bands.has(b)).map((b) => ({ bucket: b, rows: bands.get(b)! })),
      archived: archived.filter((r) => r !== hero),
      byId,
    };
  }, [rows, filing]);

  // A typed query FLATTENS the screen: folders, the archive and "Where you
  // were" all exist to make browsing thirty projects bearable, and none of
  // them are the question a search is asking. `null` (no query) leaves
  // `shape` above as the thing that renders; a query, even an empty-results
  // one, always renders this instead - never both at once, so there is one
  // reading of what's on screen, not a search overlaying a browse.
  const matches = useMemo(() => {
    if (!rows) return null;
    const q = query.trim();
    if (!q) return null;
    return rows.filter((r) => matchesQuery(q, r.project, r));
  }, [rows, query]);

  function toggleFolder(id: string) {
    haptics.tap();
    setOpen((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }

  /**
   * One project, wherever it is drawn. `tone` picks the material: a key
   * standing on a folder's mass, or a quiet rule-separated row on the ground.
   *
   * A PLAIN FUNCTION CALLED INLINE, never `<ProjectLine/>`. A component
   * declared inside a render body is a NEW type on every render, so React
   * would tear the whole list down and rebuild it sixty times a second while a
   * card is being dragged across it. Called as a function it just returns
   * elements into the parent's tree and reconciles by key like any other list.
   */
  function renderLine(row: Row, tone: 'key' | 'row') {
    const { project } = row;
    const lifted = drag?.projectId === project.id;
    // Same rule everywhere below the hero, filed or not: the owner's own
    // metric (shots in the can), and the two facts scanning thirty projects
    // actually wants - day number, whether it's finished. See rowMeta above.
    const rm = rowMeta(project, row);
    // NOT `!project.openShootDay.wrappedAt` (what this read before rowMeta
    // existed): `wrapShootDay` always advances `openShootDay` to the NEXT,
    // unwrapped day the moment it wraps the one before it (see rowMeta's own
    // `wrapped` doc), so that check was true - and this badge showed - on
    // EVERY project with any shoot day at all, wrapped or not. It only ever
    // read right because nothing on screen said "Wrapped" to contradict it.
    // The instant that flag existed, a filed project could show LIVE and
    // Wrapped on the same row, which is exactly the seeded screenshot below
    // caught. `rm.wrapped` is the one correct signal for "finished, for
    // now" - LIVE is just its negation.
    const live = !!project.openShootDay && !rm.wrapped;
    // The tilt goes through a CUSTOM PROPERTY so the reduce block in
    // skin/projects.css can zero it. The translate cannot be zeroed and must
    // not be: a card that follows the finger 1:1 is direct manipulation, which
    // is the one kind of movement prefers-reduced-motion is not asking about.
    // The 1.6 degrees is the decorative half, so that is the half that goes.
    const style: CSSProperties | undefined = lifted
      ? { transform: `translate(${drag!.dx}px, ${drag!.dy}px) rotate(var(--pj-tilt, 1.6deg))` }
      : undefined;

    // TWO BOXES WHILE LIFTED, ONE AT REST. The outer keeps the card's place in
    // the list and draws the dashed hole it came out of; the inner is what the
    // finger is carrying. Without the split, a lifted card leaves a plain void
    // in its folder — which is the exact "a mass with nothing on it reads as
    // broken" failure the empty-folder state exists to avoid.
    const inner = (
      <div
        className={`${tone === 'key' ? 'pj-key' : 'pj-row'}${lifted ? ' pj-key--lifted' : ''}`}
        style={style}
      >
        <span
          className="pj-handle"
          role="button"
          tabIndex={0}
          aria-label={`Move ${project.name}. Hold to lift it, or press to choose a folder.`}
          onPointerDown={(e) => startPress(e, project.id)}
          onKeyDown={(e) => {
            if (e.key === 'Enter' || e.key === ' ') {
              e.preventDefault();
              setFilingRow(row);
            }
          }}
        >
          <Grip />
        </span>
        <button
          type="button"
          className="pj-line"
          onClick={() => {
            if (drag) return; // a lift that ended on this card is not a tap
            haptics.tap();
            props.onOpen(project);
          }}
        >
          <span className={tone === 'key' ? 'pj-key__text' : 'pj-row__text'}>
            <span className={tone === 'key' ? 'pj-key__toprow' : 'pj-row__toprow'}>
              <span className={tone === 'key' ? 'pj-key__name' : 'pj-row__name'}>{project.name}</span>
              {/* NOT "Wrapped" here too - see the comment on rowMeta's
                  `parts` above. Two flex:none flags next to a flex:1 name
                  crushed an ordinary name ("The Long Wait") down to "The…",
                  which is worse than the fact either flag is there to give.
                  "Wrapped" leads the meta line below instead; this is the
                  one flag the name has to make room for. */}
              {rm.noShotList && <span className="pj-flag">No shot list</span>}
            </span>
            {/* The bar only exists when there's a real denominator - see
                `hasBar` on RowMeta. A project with no shot list gets the flag
                above instead of a bar measuring nothing. */}
            {rm.hasBar && (
              <span className={`pj-bar-row${tone === 'key' ? ' pj-bar-row--mass' : ''}`}>
                <span className={`pj-bar${tone === 'key' ? ' pj-bar--mass' : ''}`} aria-hidden="true">
                  <span className="pj-bar__fill" style={{ width: `${rm.pct}%` }} />
                </span>
                <span className="pj-bar__cap tnum">{rm.fractionLabel}</span>
              </span>
            )}
            <span className={tone === 'key' ? 'pj-key__meta' : 'pj-row__meta'}>{rm.metaLine}</span>
          </span>
          {live && tone === 'key' && <span className="pj-key__live">live</span>}
          {tone === 'row' && (
            <span className="pj-row__when">{fmtWhen(Date.now(), lastActivity(project))}</span>
          )}
        </button>
        <button
          type="button"
          className="pj-more"
          aria-label={`File ${project.name} under…`}
          onClick={() => {
            haptics.tap();
            setFilingRow(row);
          }}
        >
          <MoreMark />
        </button>
      </div>
    );
    return lifted ? (
      <div key={project.id} className="pj-slot">
        {inner}
      </div>
    ) : (
      <div key={project.id} className="pj-holder">
        {inner}
      </div>
    );
  }

  return (
    <div className="app pj">
      {/* Was an app icon, the wordmark and a tagline: a website header, on a tab
          that is not even called Clapper. It is now the same large title the
          other three roots carry, from the same component, so all four shrink
          into the material bar on the same beat. */}
      <ScreenHeader title="Projects" />

      <div className="visually-hidden" role="status" aria-live="polite">
        {liveMsg}
      </div>

      {/* ALWAYS ON, NEVER FOCUSED. Two decisions, and both matter on a phone
          held one-handed on set:

          VISIBLE, not behind a tap - the same call the Clip log's own finder
          already made (see ClipLogScreen.tsx's `.mclip__find`). A search a
          director has to go looking for before they can use it has already
          lost the "just tell me where" moment it exists for.

          NEVER `autoFocus`. A field that raises the keyboard the instant this
          screen mounts covers the very list it's meant to search - the exact
          failure the brief calls out. It waits for a deliberate tap, same as
          every other field in the app. */}
      {rows !== null && rows.length > 0 && (
        <input
          className="pj-search"
          type="search"
          inputMode="search"
          aria-label="Find a project"
          placeholder="Find a project · name or scene"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
        />
      )}

      {rows === null ? (
        <div className="empty">Loading projects</div>
      ) : rows.length === 0 ? (
        /* FIRST RUN. Not an error, and it must not look like one: one line of
           what to do, on the same dashed slot an empty folder uses, so the two
           empties on this screen are visibly the same kind of nothing. */
        <div className="pj-empty">
          <b>No projects yet</b>
          <span>Start one for your shoot day. Day 1 opens itself with your first take.</span>
        </div>
      ) : matches ? (
        /* A QUERY FLATTENS THE SCREEN. See the comment on `matches` above -
           folders, the archive and the hero all exist to make BROWSING
           bearable, and none of them are what a search is asking. Sorted the
           same way the base list already is (most recently touched first),
           because that ordering is still right once the list is short. */
        <section className="pj-band">
          <h2 className="pj-band__hdr">
            {matches.length} matching
          </h2>
          {matches.length === 0 ? (
            <div className="pj-empty">
              <b>No projects match &ldquo;{query.trim()}&rdquo;</b>
              <span>Try just the name, or a scene from the breakdown.</span>
            </div>
          ) : (
            matches.map((row) => renderLine(row, 'row'))
          )}
        </section>
      ) : (
        shape && (
          <>
            {shape.hero && (
              <section className="pj-band">
                {/* NOT `bucketFor(...)`. The hero is excluded from the bands
                    below but was still labelled with the SAME vocabulary they
                    use, so a shoot touched today printed "TODAY" twice on one
                    screen — once over the hero, once over the list it had just
                    been lifted out of. The hero is not a date bucket; it is the
                    shoot you were last in, which is the same object Home calls
                    "Where you were". Same object, same name, in both places. */}
                <h2 className="pj-band__hdr">Where you were</h2>
                <HeroMass
                  row={shape.hero}
                  folderName={shape.heroFolder}
                  onOpen={() => {
                    haptics.tap();
                    props.onOpen(shape.hero!.project);
                  }}
                />
              </section>
            )}

            {shape.folders.map(({ folder, rows: folderRows, count }) => {
              const isOpen = open.has(folder.id);
              // A slot where the card ALREADY lives promises a move that will
              // not happen. The lift still reads as picked-up; there is just
              // nothing to land in until the finger reaches somewhere else.
              const dropping =
                drag?.over === folder.id && filing.filed[drag.projectId] !== folder.id;
              // An EMPTY folder stays quiet even when open: a mass with nothing
              // on it is a slab, and a slab reads as broken where a dashed slot
              // reads as an invitation.
              const asMass = isOpen && (folderRows.length > 0 || dropping);
              return (
                <section
                  className="pj-band"
                  key={folder.id}
                  ref={(el) => setZone(folder.id, el)}
                >
                  {asMass ? (
                    <div className="pj-mass pj-folder">
                      <button type="button" className="pj-fhead" onClick={() => toggleFolder(folder.id)}>
                        <span className="pj-fhead__mark"><FolderMark /></span>
                        <span className="pj-fhead__name">{folder.name}</span>
                        <span className="pj-fhead__count">
                          {count} shoot{count === 1 ? '' : 's'}
                        </span>
                        <span className="pj-fhead__chev"><ChevronMark down /></span>
                      </button>
                      {folderRows.map((row) => renderLine(row, 'key'))}
                      {dropping && <div className="pj-drop">Drop to file here</div>}
                    </div>
                  ) : (
                    <>
                      <button type="button" className="pj-fhead" onClick={() => toggleFolder(folder.id)}>
                        <span className="pj-fhead__mark"><FolderMark /></span>
                        <span className="pj-fhead__name">{folder.name}</span>
                        <span className="pj-fhead__count">
                          {count === 0 ? 'empty' : `${count} shoot${count === 1 ? '' : 's'}`}
                        </span>
                        <span className="pj-fhead__chev"><ChevronMark down={isOpen} /></span>
                      </button>
                      {isOpen && (
                        <div className="pj-drop pj-drop--sheet">Nothing filed — drag a shoot in</div>
                      )}
                    </>
                  )}
                </section>
              );
            })}

            <div ref={(el) => setZone('', el)}>
              {shape.bands.map(({ bucket, rows: bandRows }) => (
                <section className="pj-band" key={bucket}>
                  <h2 className="pj-band__hdr">{bucket}</h2>
                  {bandRows.map((row) => renderLine(row, 'row'))}
                </section>
              ))}
              {drag && drag.over === '' && filing.filed[drag.projectId] !== undefined && (
                <div className="pj-drop pj-drop--sheet">Drop to take it out of its folder</div>
              )}
            </div>

            {(shape.archived.length > 0 || filing.folders.length > 0) && (
              <section className="pj-band pj-archive" ref={(el) => setZone(ARCHIVE, el)}>
                <button type="button" className="pj-fhead" onClick={() => toggleFolder(ARCHIVE)}>
                  <span className="pj-fhead__mark"><ArchiveMark /></span>
                  <span className="pj-fhead__name">Archive</span>
                  <span className="pj-fhead__count tnum">{shape.archived.length}</span>
                  <span className="pj-fhead__chev"><ChevronMark down={open.has(ARCHIVE)} /></span>
                </button>
                {/* Said once, under the row it is about. It used to ride in the
                    count, where at 390px the folder name truncated to "Arc…". */}
                <p className="pj-band__note">Shoots file themselves here after 30 quiet days.</p>
                {drag?.over === ARCHIVE && filing.filed[drag.projectId] !== ARCHIVE && (
                  <div className="pj-drop pj-drop--sheet">Drop to archive</div>
                )}
                {open.has(ARCHIVE) &&
                  (shape.archived.length === 0 ? (
                    <div className="pj-drop pj-drop--sheet">Nothing archived yet</div>
                  ) : (
                    shape.archived.map((row) => renderLine(row, 'row'))
                  ))}
              </section>
            )}
          </>
        )
      )}

      <button
        type="button"
        className="newproject newproject--primary"
        onClick={() => {
          haptics.tap();
          setCreating(true);
        }}
      >
        <PlusMark /> New project
      </button>

      <button
        type="button"
        className="newproject newproject--ghost"
        onClick={() => {
          haptics.tap();
          setLoadingScript(true);
        }}
      >
        <ListMark /> Shotlist · from a PDF
      </button>

      <div style={{ marginTop: 22 }}>
        <Rail thin />
      </div>

      {filingRow && (
        <FileUnderSheet
          row={filingRow}
          filing={filing}
          onClose={() => setFilingRow(null)}
          onFile={(place, label) => {
            fileUnder(filingRow.project.id, place, label);
            setFilingRow(null);
          }}
          onNewFolder={(name) => {
            const folder: Folder = {
              id: `f${Date.now().toString(36)}`,
              name,
              order: filing.folders.length,
            };
            const next: Filing = {
              folders: [...filing.folders, folder],
              filed: { ...filing.filed, [filingRow.project.id]: folder.id },
            };
            commitFiling(next);
            setOpen((prev) => new Set(prev).add(folder.id));
            setLiveMsg(`Filed under ${name}`);
            setFilingRow(null);
          }}
        />
      )}

      {/* THE BLANK-PROJECT PATH, and it is not written here either. It used to
          be a fourteen-field form in one sheet with the whole multi-cam rig
          folded in behind a segmented control; it is five stages now, on the
          same shared rail the shotlist import and the first-open flow use. See
          NewProjectSheet.tsx for what it stopped asking for and why. */}
      {creating && (
        <NewProjectSheet
          onClose={() => setCreating(false)}
          onCreated={(project) => {
            setCreating(false);
            props.onOpen(project);
          }}
        />
      )}

      {/* ONE shotlist flow, and it is not written here. This screen used to
          carry a private near-copy of the read half and then hand its pack to
          the fourteen-field New project sheet, which meant the same job wore
          two different faces depending on which tab you started from. See the
          header of ShotlistSheet.tsx for why the setup half is deliberately
          three values. */}
      {loadingScript && (
        <ShotlistSheet
          onClose={() => setLoadingScript(false)}
          onImported={(project) => {
            setLoadingScript(false);
            props.onOpen(project);
          }}
        />
      )}

    </div>
  );
}

/**
 * Today's shoot, as a block of dark metal set into the ground.
 *
 * The joint between TAKES and SHOOT DAY is the screen's signature: a slot of
 * ground milled UP into the mass, its mouth flared by two concave curves (see
 * skin/projects.css). It is doing a job as well as being a move — the two
 * numbers are different KINDS of number, one a tally and one an index, and the
 * slot says so without a label or a rule.
 */
function HeroMass(props: { row: Row; folderName?: string; onOpen: () => void }) {
  const { row } = props;
  const { project } = row;
  // A day that has not started yet. Round 3: this is a normal state, not an
  // empty one — the strip is dark, the numbers are quiet, and the caption says
  // the one true thing rather than apologising.
  const cold = row.takeCount === 0;
  const rm = rowMeta(project, row);
  const day = rm.day;

  return (
    <button
      type="button"
      className={`pj-mass pj-hero${cold ? ' pj-hero--cold' : ''}`}
      onClick={props.onOpen}
    >
      <span className="pj-hero__top">
        <span className="pj-hero__name">{project.name}</span>
        <span className="pj-hero__chev"><ChevronMark /></span>
      </span>
      {/* Where it is filed, when it is filed. It is an EYEBROW rather than a
          fourth clause on the fact line below: appended there it truncated the
          line it was appended to, and "8 scenes · Riverside…" reads as a broken
          sentence where a caps line above the title reads as a heading. It
          exists at all because this shoot is ALSO drawn inside that folder's
          count further down, and the two have to be visibly the same thing. */}
      {props.folderName && <span className="pj-hero__filed">{props.folderName}</span>}
      {/* "Wrapped" leads this line rather than sitting beside the name above,
          the same call the plain rows make (see rowMeta's `parts`), for the
          same reason: a flex:none flag next to a flex:1 name is the name
          losing, and the name is the one thing a "Where you were" card
          cannot afford to lose. */}
      <span className="pj-hero__meta">{rm.wrapped ? `Wrapped · ${shapeOf(row)}` : shapeOf(row)}</span>

      {/* THE OWNER'S METRIC: shots in the can, out of the shot breakdown
          total - never scenes. A scene with an eight-shot breakdown and one
          shot done is one eighth done, not "started", and this is where that
          shows. No shot list anywhere on the project is the one case that
          gets no bar (see `hasBar` on RowMeta) rather than one measuring a
          denominator that was never there. */}
      {row.sceneCount === 0 ? (
        <span className="pj-hero__cold">No scenes yet - add the first setup</span>
      ) : rm.hasBar ? (
        <>
          <span className="pj-bar-row pj-bar-row--mass">
            <span className="pj-bar pj-bar--mass" aria-hidden="true">
              <span className="pj-bar__fill" style={{ width: `${rm.pct}%` }} />
            </span>
            <span className="pj-bar__cap tnum">{rm.fractionLabel}</span>
          </span>
          <span className="pj-cov__cap">{rm.scenesLeftLabel}</span>
        </>
      ) : (
        <span className="pj-hero__cold">
          No shot list yet - {row.sceneCount} scene{row.sceneCount === 1 ? '' : 's'} logged
        </span>
      )}

      <span className="pj-stats">
        <span className="pj-stat">
          <span className="pj-stat__k">Takes</span>
          <span className="pj-stat__v tnum">{row.takeCount}</span>
        </span>
        {/* The joint used to be a `.pj-notch` here — a slot of ground cut up
            into the mass. It never read as one. With the mass and the ground
            both near-black it came out as a black drip hanging off the card,
            which is the same artifact that was already pulled off the rolling
            screen's stat pair. That screen replaced it with a hairline between
            the cells and the hairline was right, so this uses the hairline too:
            one way of separating two numbers in the app, not two. */}
        <span className="pj-stat">
          <span className="pj-stat__k">Shoot day</span>
          <span className="pj-stat__v tnum">{day || '—'}</span>
        </span>
      </span>
    </button>
  );
}

/**
 * File under… — the one-handed path.
 *
 * Drag is faster and wants two hands and a steady arm. This is the same move
 * from inside a glove, holding a slate, at 5am. The current folder is
 * pre-checked because the first question the sheet has to answer is "where is
 * this now", and Archive sits below a rule because it is a different kind of
 * move — the same sheet serves "put this with the others" and "get this out of
 * my face", and those must not look like neighbours.
 */
function FileUnderSheet(props: {
  row: Row;
  filing: Filing;
  onClose: () => void;
  onFile: (place: string | null, label: string) => void;
  onNewFolder: (name: string) => void;
}) {
  const { row, filing } = props;
  const [naming, setNaming] = useState(false);
  const [name, setName] = useState('');
  const here = filing.filed[row.project.id];
  const counts = useMemo(() => {
    const map = new Map<string, number>();
    for (const place of Object.values(filing.filed)) {
      map.set(place, (map.get(place) ?? 0) + 1);
    }
    return map;
  }, [filing]);

  const folders = [...filing.folders].sort((a, b) => a.order - b.order);

  return (
    <Sheet onClose={props.onClose}>
      <div className="pj-filehead">
        <span className="pj-filehead__chip">{row.project.name}</span>
        <span className="pj-filehead__label">File under…</span>
      </div>

      {naming ? (
        <div className="formrow">
          <label className="label" htmlFor="pj-newfolder">
            New folder
          </label>
          <input
            id="pj-newfolder"
            className="field"
            value={name}
            autoFocus
            placeholder="e.g. Northwind Films · client"
            onChange={(e) => setName(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter' && name.trim()) props.onNewFolder(name.trim());
            }}
          />
          <div className="sheet__actions">
            <button type="button" className="btn btn--ghost" onClick={() => setNaming(false)}>
              Back
            </button>
            <button
              type="button"
              className="btn btn--go"
              disabled={!name.trim()}
              onClick={() => props.onNewFolder(name.trim())}
            >
              Create folder
            </button>
          </div>
        </div>
      ) : (
        <>
          {/* Unfiled is a destination too. Without it there is no way back out
              of a folder except into another one. */}
          <button
            type="button"
            className={`pj-filerow${here === undefined ? ' pj-filerow--here' : ''}`}
            onClick={() => props.onFile(null, 'Unfiled')}
          >
            <span className="pj-filerow__ic"><FolderMark size={16} /></span>
            <span className="pj-filerow__name pj-filerow__name--quiet">Not in a folder</span>
            {here === undefined && <span className="pj-filerow__tick"><TickMark /></span>}
          </button>

          {folders.map((folder) => (
            <button
              type="button"
              key={folder.id}
              className={`pj-filerow${here === folder.id ? ' pj-filerow--here' : ''}`}
              onClick={() => props.onFile(folder.id, `Filed under ${folder.name}`)}
            >
              <span className="pj-filerow__ic"><FolderMark size={16} /></span>
              <span className="pj-filerow__name">{folder.name}</span>
              {here === folder.id ? (
                <span className="pj-filerow__tick"><TickMark /></span>
              ) : (
                <span className="pj-filerow__count tnum">{counts.get(folder.id) ?? 0}</span>
              )}
            </button>
          ))}

          <button
            type="button"
            className="pj-filerow"
            onClick={() => {
              haptics.tap();
              setNaming(true);
            }}
          >
            <span className="pj-filerow__ic"><PlusRowMark /></span>
            <span className="pj-filerow__name pj-filerow__name--quiet">New folder…</span>
          </button>

          <button
            type="button"
            className={`pj-filerow pj-filerow--cut${here === ARCHIVE ? ' pj-filerow--here' : ''}`}
            onClick={() => props.onFile(ARCHIVE, 'Archived')}
          >
            <span className="pj-filerow__ic"><ArchiveMark size={16} /></span>
            <span className="pj-filerow__name pj-filerow__name--quiet">Archive now</span>
            {here === ARCHIVE && <span className="pj-filerow__tick"><TickMark /></span>}
          </button>

          <div className="sheet__actions">
            <SheetClose className="btn btn--ghost" onClose={props.onClose}>
              Cancel
            </SheetClose>
          </div>
        </>
      )}
    </Sheet>
  );
}
