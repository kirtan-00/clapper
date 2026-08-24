import { Fragment, useEffect, useRef, useState } from 'react';
import type { ChangeEvent, ReactNode } from 'react';
import type { CameraUnit, Fps, Project, Slate } from '../types';
import { isMultiCam } from '../types';
import { FPS_OPTIONS, FPS_WARNING } from './fps';
import { store } from '../store';
import { formatClip, moveItem, sortForDisplay, undoWrapShootDay, wrapShootDay } from '../store/util';
import { tc } from '../export/timecode';
import { exporter, shareBlob, buildBackupBlob, buildMediaIndex, countMatched } from '../export';
import type { MediaIndex } from '../export';
import { clearMediaIndex, loadMediaIndex, saveMediaIndex } from '../store/medialink';
import { pickerKind, pickFolderViaHandle, pickedFromFiles, type PickedFolder } from './folderpick';
import { exportDateStamp, shortDateLabel } from '../export/order';
import { clampClipNumber, findPreset, renderUnitClip, UNIT_LETTERS } from './cameras';
import { slug } from './share';
import { Sheet, SheetClose, Confirm, Rail } from './common';
import { useScrolled } from './glist';
import { BackButton, ForwardMark, DownMark, CheckMark, ExportMark, CloudMark, StopMark } from './marks';
import { SignInSheet } from './SignInSheet';
import { ProCta } from './ProCta';
import { useSession } from '../net/auth';
import { gateExport, FREE_LIMITS, type GatedFormat, type GateResult } from '../net/quota';
import { track } from '../net/analytics';
import * as haptics from './haptics';
import { extractPdfText } from './pdftext';
import { breakdownCallSheet, SignInRequiredError } from './breakdown';
import { TagEditor } from './TagEditor';
import { getDefaultTags } from './tagdefaults';
import type { ProjectMode } from './newRoll';

// Vertical gap between scene cards — must match `.stack`'s `gap` in
// styles.css. Used to size the "make room" shift while dragging.
const ROW_GAP = 12;

/** 1st / 2nd / 3rd / 4th / ... 11th-13th all "th". */
function ordinal(n: number): string {
  const v = n % 100;
  if (v >= 11 && v <= 13) return `${n}th`;
  switch (n % 10) {
    case 1:
      return `${n}st`;
    case 2:
      return `${n}nd`;
    case 3:
      return `${n}rd`;
    default:
      return `${n}th`;
  }
}

interface SlateStat {
  slate: Slate;
  takeCount: number;
  goodCount: number; // kept takes — a scene with >=1 is "in the can"
  totalMs: number;
  covered: number;   // setups with at least one keeper; 0 for a scene with no shots
}

function clipName(prefix: string, n: number, pad: number, suffix = ''): string {
  return prefix + String(Math.max(0, n)).padStart(pad, '0') + suffix;
}

// One-time "tap a scene to roll" hint. Dismissed for good the first time a user
// opens any scene into Rolling, since by then they clearly get it.
const ROLL_HINT_KEY = 'clapper.rollHintSeen';
function rollHintSeen(): boolean {
  try {
    return localStorage.getItem(ROLL_HINT_KEY) === '1';
  } catch {
    return false;
  }
}
function markRollHintSeen(): void {
  try {
    localStorage.setItem(ROLL_HINT_KEY, '1');
  } catch {
    /* private mode / storage blocked: fine, hint just shows again next time */
  }
}

/** Opens the Setup sheet. Three dots, not a chevron: the header control does
 *  not go anywhere, it offers a menu. Same idiom and same construction as
 *  ProjectsScreen's own row-level MoreMark, restated locally rather than
 *  imported so this file's one export stays the screen itself. */
function MoreMark() {
  return (
    <svg viewBox="0 0 24 24" width="20" height="20" aria-hidden="true" focusable="false">
      <circle cx="5.5" cy="12" r="1.6" fill="currentColor" />
      <circle cx="12" cy="12" r="1.6" fill="currentColor" />
      <circle cx="18.5" cy="12" r="1.6" fill="currentColor" />
    </svg>
  );
}

export function ProjectScreen(props: {
  project: Project;
  /** The name of the screen BACK lands on. The router knows it; this does not. */
  backLabel: string;
  onBack: () => void;
  /** The project is gone; leave this screen. */
  onDeleted: () => void;
  onOpenSlate: (project: Project, slate: Slate) => void;
  onProjectChanged: (project: Project) => void;
  onOpenClipLog: () => void;
}) {
  const [project, setProject] = useState<Project>(props.project);
  const [slates, setSlates] = useState<SlateStat[] | null>(null);
  // Each scene's 1-based position in STORY order (sorted by `.order`, ignoring
  // `shootOrder`) — used only to show the "9th in script" hint when a scene's
  // shooting position has drifted from where it sits in the script.
  const [storyPos, setStoryPos] = useState<Map<string, number>>(new Map());
  const [addName, setAddName] = useState('');
  const [renaming, setRenaming] = useState<Slate | null>(null);
  const [deleting, setDeleting] = useState<Slate | null>(null);
  const [deletingProject, setDeletingProject] = useState(false);
  // The "..." sheet: everything touched once at the start of a shoot, not
  // every time you open the project. See the SETUP sheet render below for
  // what actually lives in here and why, in order.
  const [setupOpen, setSetupOpen] = useState(false);
  const [hintSeen, setHintSeen] = useState<boolean>(() => rollHintSeen());
  const [liveMsg, setLiveMsg] = useState('');
  // Takes logged against the currently OPEN shoot day — what the "DAY 3 · 31
  // Jul · 47 takes" line on ShootDaySection shows. Recomputed whenever the
  // freshest project loads (see the mount effect below) and after WRAP DAY /
  // undo, never derived from `slates` (those stats are ALL-TIME per scene,
  // not scoped to one day).
  const [dayTakeCount, setDayTakeCount] = useState(0);

  // ------------------------------------------------------ call sheet ------
  // Loading today's call sheet reorders this project's scenes so today's shoot
  // sits at the top (stamps Slate.shootOrder via the same reorderSlates atomic
  // write drag-to-reorder uses) and flags each scene's Slate.today. Mirrors
  // Script Mode's own upload → sign-in → error pattern (see ProjectsScreen).
  const { session: csSession } = useSession();
  const [csPhase, setCsPhase] = useState<'idle' | 'reading' | 'thinking'>('idle');
  const [csError, setCsError] = useState<string | null>(null);
  const [csNote, setCsNote] = useState<string | null>(null);
  const [csShowSignIn, setCsShowSignIn] = useState(false);
  const csBusy = csPhase !== 'idle';

  function openSlate(slate: Slate) {
    if (!hintSeen) {
      markRollHintSeen();
      setHintSeen(true);
    }
    props.onOpenSlate(project, slate);
  }

  useEffect(() => {
    setProject(props.project);
  }, [props.project]);

  async function refresh() {
    const list = await store.listSlates(project.id); // story order (.order)
    setStoryPos(new Map(list.map((s, i) => [s.id, i + 1])));
    const displayList = sortForDisplay(list); // on-set order: shootOrder ?? order
    const stats = await Promise.all(
      displayList.map(async (slate) => {
        const takes = await store.listTakes(slate.id);
        const good = takes.filter((t) => t.status === 'good');
        const totalMs = good.reduce((sum, t) => sum + t.durationMs, 0);
        // How many of the scene's setups have a keeper. This is the number an
        // AD tracks - coverage - as distinct from how often the camera rolled.
        const shotIds = new Set(good.map((t) => t.shotId).filter(Boolean));
        const covered = (slate.shots ?? []).filter((sh) => shotIds.has(sh.id)).length;
        return { slate, takeCount: takes.length, goodCount: good.length, totalMs, covered };
      }),
    );
    setSlates(stats);
  }

  // ---------------------------------------------------------- drag reorder --
  // Pointer-events-only drag: the handle is the ONLY thing that starts a drag
  // (touch-action: none on it), so a swipe anywhere else on the card still
  // scrolls the page normally. While dragging, the picked-up row follows the
  // finger 1:1; every other row between its start and current slot slides by
  // exactly the dragged row's own height to open/close a gap — correct
  // regardless of each row's own height, since it's the SAME hole moving.
  const rowRefs = useRef<Map<string, HTMLDivElement>>(new Map());
  const dragMeta = useRef<{
    pointerId: number;
    startClientY: number;
    latestClientY: number;
    centers: number[]; // each row's original viewport center-Y, snapshotted at pointerdown
    rafId: number | null;
  } | null>(null);
  const [drag, setDrag] = useState<{
    id: string;
    startIndex: number;
    hoverIndex: number;
    deltaY: number;
    height: number;
  } | null>(null);
  // The latest commitReorder, kept fresh every render so the stable
  // (create-once) pointer listeners below always call into current state.
  const commitRef = useRef<(from: number, to: number) => void>(() => {});
  const onDragMoveRef = useRef<((e: PointerEvent) => void) | null>(null);
  const onDragEndRef = useRef<((e: PointerEvent) => void) | null>(null);

  function setRowRef(id: string, el: HTMLDivElement | null) {
    if (el) rowRefs.current.set(id, el);
    else rowRefs.current.delete(id);
  }

  async function commitReorder(fromIndex: number, toIndex: number) {
    if (!slates) return;
    const currentIds = slates.map((s) => s.slate.id);
    const newIds = moveItem(currentIds, fromIndex, toIndex);
    if (newIds.join('|') === currentIds.join('|')) return; // genuine no-op: nothing to persist
    const movedName = slates[fromIndex].slate.name;
    haptics.tap();
    await store.reorderSlates(project.id, newIds);
    await refresh();
    setLiveMsg(`Moved ${movedName} to position ${toIndex + 1} of ${newIds.length}`);
  }
  commitRef.current = (from, to) => void commitReorder(from, to);

  if (!onDragMoveRef.current) {
    onDragMoveRef.current = (e: PointerEvent) => {
      const meta = dragMeta.current;
      if (!meta || e.pointerId !== meta.pointerId) return;
      e.preventDefault();
      meta.latestClientY = e.clientY;
      if (meta.rafId !== null) return;
      meta.rafId = window.requestAnimationFrame(() => {
        const m = dragMeta.current;
        if (!m) return;
        m.rafId = null;
        const deltaY = m.latestClientY - m.startClientY;
        setDrag((prev) => {
          if (!prev) return prev;
          const draggedCenterNow = m.centers[prev.startIndex] + deltaY;
          let hoverIndex = prev.startIndex;
          if (deltaY > 0) {
            for (let i = prev.startIndex + 1; i < m.centers.length; i++) {
              if (draggedCenterNow > m.centers[i]) hoverIndex = i;
              else break;
            }
          } else if (deltaY < 0) {
            for (let i = prev.startIndex - 1; i >= 0; i--) {
              if (draggedCenterNow < m.centers[i]) hoverIndex = i;
              else break;
            }
          }
          return { ...prev, deltaY, hoverIndex };
        });
      });
    };
  }

  if (!onDragEndRef.current) {
    onDragEndRef.current = (e: PointerEvent) => {
      const meta = dragMeta.current;
      if (!meta || e.pointerId !== meta.pointerId) return;
      window.removeEventListener('pointermove', onDragMoveRef.current!);
      window.removeEventListener('pointerup', onDragEndRef.current!);
      window.removeEventListener('pointercancel', onDragEndRef.current!);
      dragMeta.current = null;
      setDrag((prev) => {
        if (prev && prev.hoverIndex !== prev.startIndex) {
          commitRef.current(prev.startIndex, prev.hoverIndex);
        }
        return null;
      });
    };
  }

  // Belt-and-braces: if the screen unmounts mid-drag, drop the listeners.
  useEffect(() => {
    return () => {
      if (onDragMoveRef.current) window.removeEventListener('pointermove', onDragMoveRef.current);
      if (onDragEndRef.current) {
        window.removeEventListener('pointerup', onDragEndRef.current);
        window.removeEventListener('pointercancel', onDragEndRef.current);
      }
    };
  }, []);

  function startDrag(e: React.PointerEvent<HTMLButtonElement>, index: number) {
    if (!slates) return;
    if (e.pointerType === 'mouse' && e.button !== 0) return;
    const rects = slates.map(({ slate }) => rowRefs.current.get(slate.id)?.getBoundingClientRect());
    if (rects.some((r) => !r)) return;
    const centers = rects.map((r) => r!.top + r!.height / 2);
    const height = rects[index]!.height;
    dragMeta.current = {
      pointerId: e.pointerId,
      startClientY: e.clientY,
      latestClientY: e.clientY,
      centers,
      rafId: null,
    };
    setDrag({ id: slates[index].slate.id, startIndex: index, hoverIndex: index, deltaY: 0, height });
    haptics.tap();
    window.addEventListener('pointermove', onDragMoveRef.current!);
    window.addEventListener('pointerup', onDragEndRef.current!);
    window.addEventListener('pointercancel', onDragEndRef.current!);
  }

  function onGripKeyDown(e: React.KeyboardEvent, index: number) {
    if (!slates) return;
    if (e.key === 'ArrowUp' && index > 0) {
      e.preventDefault();
      void commitReorder(index, index - 1);
    } else if (e.key === 'ArrowDown' && index < slates.length - 1) {
      e.preventDefault();
      void commitReorder(index, index + 1);
    }
  }

  /** Visual translateY for a non-dragged row: shift by exactly the dragged
   * row's own height to open/close the gap it will land in. */
  function shiftFor(index: number): number {
    if (!drag || index === drag.startIndex) return 0;
    const amount = drag.height + ROW_GAP;
    if (drag.hoverIndex > drag.startIndex && index > drag.startIndex && index <= drag.hoverIndex) {
      return -amount;
    }
    if (drag.hoverIndex < drag.startIndex && index >= drag.hoverIndex && index < drag.startIndex) {
      return amount;
    }
    return 0;
  }

  /** How many takes have landed against the given open day so far — pure
   * lookup, no writes. `undefined` (no open day yet, e.g. a brand new
   * project) reads as zero. */
  async function refreshDayCount(openDay: Project['openShootDay']) {
    if (!openDay) {
      setDayTakeCount(0);
      return;
    }
    const list = await store.listSlates(project.id);
    const perSlate = await Promise.all(list.map((s) => store.listTakes(s.id)));
    setDayTakeCount(perSlate.flat().filter((t) => t.shootDay === openDay.date).length);
  }

  useEffect(() => {
    void refresh();
    // reload the freshest project (clip counter may have moved while rolling)
    void store.getProject(project.id).then((p) => {
      if (p) {
        setProject(p);
        props.onProjectChanged(p);
        void refreshDayCount(p.openShootDay);
      }
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [project.id]);

  async function commitProject(patch: Partial<Project>) {
    const updated = await store.updateProject(project.id, patch);
    setProject(updated);
    props.onProjectChanged(updated);
  }

  // All-time take count across every scene, not the "today" count
  // ShootDaySection tracks (dayTakeCount, above) - FpsSection needs to know
  // whether ANY take exists anywhere in the project before it decides a rate
  // change is free or needs a named confirm. `slates` already carries a
  // per-scene takeCount from `refresh()`, so this is just the sum, not a
  // second store query.
  const totalTakeCount = slates?.reduce((sum, s) => sum + s.takeCount, 0) ?? 0;

  // The nav bar is sticky material; the hairline under it arrives only once
  // there is a list behind it to separate from.
  const scrolled = useScrolled();

  return (
    /* `pj` opts this screen into skin/projects.css: the ground it repaints, the
       night palette round 3 approved, the accent focus ring, and the notch the
       camera units are joined by. Taking the class off puts the old screen back
       intact — nothing below depends on it structurally. */
    <div className="app pj">
      <div className="topbar" data-scrolled={scrolled ? '' : undefined}>
        <BackButton label={props.backLabel} onClick={props.onBack} />
        <div style={{ flex: 1, minWidth: 0 }}>
          <h1 className="topbar__title">{project.name}</h1>
          <div className="topbar__sub">
            {project.fps} fps <span aria-hidden="true">&middot;</span>{' '}
            {isMultiCam(project) ? (
              <span className="tnum">
                {(project.cameras ?? []).map((u) => `${u.letter} ${renderUnitClip(u)}`).join('  ·  ')}
              </span>
            ) : (
              <>
                next clip{' '}
                <span className="tnum">
                  {clipName(project.clipPrefix, project.nextClipNumber, project.clipPadding, project.clipSuffix ?? '')}
                </span>
              </>
            )}
          </div>
        </div>
        {/* THE ONE DOOR TO SETUP. Cameras, sound, tags, the footage folder,
            the call sheet loader and delete project all lived on this screen
            at full weight, alternating with the things you touch every scene
            or every day: that is why the owner read the whole page as one
            endless scroll with nothing to skim. None of that admin belongs at
            this altitude: it is set once, at the top of a shoot, then left
            alone. It moves in here, behind the same "..." iOS spells "more"
            with everywhere else in this app (see ProjectsScreen's own
            MoreMark on the row-level filing menu). */}
        <button
          type="button"
          className="iconbtn"
          aria-label="Project setup"
          onClick={() => {
            haptics.tap();
            setSetupOpen(true);
          }}
        >
          <MoreMark />
        </button>
      </div>

      <Rail thin />

      {/* The signed-out warning that used to sit here is gone from this screen.
          It was two lines of ambient dread on EVERY visit to EVERY project, and
          it is not a fact about this project: it is a fact about the account,
          which is why it now reads as a badged row on the Account tab
          ("Your shoots - This phone only"). The guide's wrap section carries
          the same warning next to the Backup button that answers it. */}
      <section className="section">
        <div className="section__head">
          <span className="label">Scenes</span>
          {slates && slates.length > 0 && (
            <span className="section__note">
              {slates.filter((s) => s.goodCount > 0).length}/{slates.length} in the can
            </span>
          )}
        </div>

        <div className="visually-hidden" role="status" aria-live="polite">
          {liveMsg}
        </div>

        {slates === null ? (
          <div className="empty">Loading scenes</div>
        ) : slates.length === 0 ? (
          /* FIRST RUN, round 3. A project with nothing in it is a normal state
             and must not be dressed as an error: one line of what to do, and
             the one fact nobody has been told yet — the day opens itself. */
          <div className="pj-empty">
            <b>No scenes yet</b>
            <span>Add your first setup below. Day 1 opens itself with your first take.</span>
          </div>
        ) : (
          <>
            {!hintSeen && (
              <div className="rollhint">
                Tap a scene to start rolling
                <span className="rollhint__arrow" aria-hidden="true">
                  <DownMark />
                </span>
              </div>
            )}
            {/* One mass, every scene a raised key standing on it — the same
                idiom a folder on the projects list already draws for the
                shoots filed inside it. `.pj-mass` is reused verbatim from
                skin/projects.css; `.scenemass` (skin/detail.css) only trims
                its padding down to the tighter rhythm a stack of keys wants.
                The drag math (ROW_GAP, centers, shiftFor) never looked at the
                DOM depth outside `.stack`, so wrapping it here changes
                nothing about how a row measures or moves. */}
            <div className="pj-mass scenemass">
            <div className="stack">
            {slates.map(({ slate, takeCount, goodCount, totalMs, covered }, i) => {
              const isDragging = drag?.id === slate.id;
              const shift = isDragging ? drag!.deltaY : shiftFor(i);
              const displayPos = i + 1;
              const scriptPos = storyPos.get(slate.id);
              const showStoryHint = scriptPos !== undefined && scriptPos !== displayPos;
              return (
                <div
                  key={slate.id}
                  ref={(el) => setRowRef(slate.id, el)}
                  className={`cardrow${isDragging ? ' cardrow--dragging' : ''}`}
                  style={{
                    transform: shift ? `translateY(${shift}px)` : undefined,
                    transition: isDragging ? 'none' : 'transform 150ms ease',
                  }}
                >
                  {/* ONE reorder affordance. There used to be three - a grip,
                      a pair of up/down steppers, and drag - all doing the same
                      job, which reads as three tries at the problem rather than
                      one answer. The grip survives because it is the only one
                      that is also the drag target AND takes the arrow keys, so
                      nothing was lost with the steppers: see onGripKeyDown. */}
                  <div className="scenehandle">
                    <button
                      type="button"
                      className="scenehandle__grip"
                      aria-label={`Reorder ${slate.name}. Position ${displayPos} of ${slates.length} in shooting order. Drag it, or use the up and down arrow keys.`}
                      onPointerDown={(e) => startDrag(e, i)}
                      onKeyDown={(e) => onGripKeyDown(e, i)}
                    >
                      <svg width="16" height="16" viewBox="0 0 16 16" aria-hidden="true" focusable="false">
                        <circle cx="4" cy="3" r="1.4" fill="currentColor" />
                        <circle cx="12" cy="3" r="1.4" fill="currentColor" />
                        <circle cx="4" cy="8" r="1.4" fill="currentColor" />
                        <circle cx="12" cy="8" r="1.4" fill="currentColor" />
                        <circle cx="4" cy="13" r="1.4" fill="currentColor" />
                        <circle cx="12" cy="13" r="1.4" fill="currentColor" />
                      </svg>
                    </button>
                  </div>
                  <button
                    type="button"
                    className={`card${goodCount > 0 ? ' card--done' : ''}`}
                    onClick={() => openSlate(slate)}
                  >
                    <div className="card__row">
                      <span className="card__namewrap">
                        <span
                          className={`scene-dot${goodCount > 0 ? ' scene-dot--done' : ''}`}
                          aria-label={goodCount > 0 ? 'Shot' : 'Not shot yet'}
                        />
                        <span className="card__name">{slate.name}</span>
                        {slate.today && <span className="cambadge">Today</span>}
                      </span>
                      <span className="card__count">{takeCount}</span>
                      <span className="card__chevron" aria-hidden="true">
                        <ForwardMark />
                      </span>
                    </div>
                    {slate.summary && <div className="card__summary">{slate.summary}</div>}
                    <div className="card__meta">
                      {showStoryHint && (
                        <span className="card__storyhint">{ordinal(scriptPos)} in script</span>
                      )}
                      {/* Coverage is the number an AD actually tracks: how many
                          of the scene's setups are in the can, not how many
                          times the camera rolled. */}
                      {slate.shots?.length ? (
                        <span>
                          <b className="tnum">{covered}</b>/
                          <span className="tnum">{slate.shots.length}</span> shots
                        </span>
                      ) : null}
                      <span>{takeCount === 1 ? '1 take' : `${takeCount} takes`}</span>
                      <span>
                        roll <b className="tnum">{tc.msToClock(totalMs)}</b>
                      </span>
                      {/* DELETE NO LONGER RENDERS AT REST. The single most
                          destructive control on the screen used to sit inside
                          every card, ten of them, on a list you thumb-scroll
                          past at 5am. iOS puts destroy behind swipe or an edit
                          mode; this app already had an edit affordance, so
                          delete moved inside it and still confirms exactly as
                          it did before. */}
                      <span
                        className="rowedit"
                        role="button"
                        tabIndex={0}
                        aria-label={`Edit scene ${slate.name}`}
                        onClick={(e) => {
                          e.stopPropagation();
                          setRenaming(slate);
                        }}
                        onKeyDown={(e) => {
                          if (e.key === 'Enter' || e.key === ' ') {
                            e.preventDefault();
                            e.stopPropagation();
                            setRenaming(slate);
                          }
                        }}
                      >
                        Edit
                      </span>
                    </div>
                  </button>
                </div>
              );
            })}
            </div>
            </div>
          </>
        )}

        {/* THE CALL SHEET LOADER USED TO SIT HERE and does not any more. It was
            a full-width button between the scene list and the one control that
            actually adds a scene, so the thing you do on every project was
            pushed below the thing you do on maybe one shoot in five, and both
            wore the same pill. It is not deleted: onPickCallSheet and its
            cs* state below are intact and move under the project's ⋯ menu with
            the rest of the once-a-shoot admin. */}

        {/* ADD SCENE IS THE PRIMARY ACTION OF THIS SCREEN. A project with no
            scenes cannot roll, and the first thing anyone does on a new project
            is type scene numbers in. It was a 60px `Add` hanging off the end of
            a wide field, which reads as the field's accessory rather than as
            the control. Now the field is sized to what actually goes in it -
            "14A", never a sentence - and the button carries its own verb at
            full weight beside it.

            STILL THE ONE PRIMARY CONTROL now that Setup and Export have moved
            off this screen: it is the only `.btn--go` fill anywhere on it.
            Wrap day, Clip log, Export and Backup all stay the outlined
            SECONDARY face - each is pressed once a day at most, none of them
            is what gets a brand new project moving. */}
        <div className="addline addline--scene">
          <input
            className="field"
            value={addName}
            placeholder="New scene e.g. 14A"
            aria-label="New scene name"
            onChange={(e) => setAddName(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter') void addSlate();
            }}
          />
          <button type="button" className="btn btn--go addline__go" onClick={() => void addSlate()}>
            Add scene
          </button>
        </div>
      </section>

      {csShowSignIn && <SignInSheet onClose={() => setCsShowSignIn(false)} />}

      {/* WRAP DAY, then check the clips, then hand off: the three things you do
          at the end of a shoot day, one below the other, under ONE head - not
          three sections each restating "Shoot day" / "Clip log" / "Hand off
          to editor" in its own label before you reach the button under it.
          Clip log keeps its old place directly above the handoff, because
          that is when it gets used: the last thing you do before sending the
          day to the editor is check that every clip is filed under the setup
          it was actually shot on. */}
      <ShootDaySection
        project={project}
        dayTakeCount={dayTakeCount}
        onCommit={commitProject}
        onWrapped={() => setDayTakeCount(0)}
        onUndone={(openDay) => void refreshDayCount(openDay)}
        tiles={
          <>
            <button type="button" className="tile tile--rolled" onClick={props.onOpenClipLog}>
              <span className="tile__icon" aria-hidden="true">
                <CheckMark />
              </span>
              <span className="tile__label">All rolled</span>
            </button>
            <ExportBar project={project} />
          </>
        }
      />

      {/* THE SETUP SHEET. Everything below used to run down this screen at the
          same weight as SCENES and SHOOT DAY - the two things actually touched
          every scene or every day - which is the "endless scroll" the owner
          flagged twice. None of it is gone or reduced: cameras and clip
          counters, production sound, quick tags, the footage folder link,
          today's call sheet and delete project are all still one tap away,
          behind the header's "..." Order matches the owner's spec exactly,
          with two additions the spec did not name but that still have to
          live SOMEWHERE (a re-layout moves every existing control, it
          deletes none): the timecode calculator, which keeps its old
          position directly after the footage folder, ahead of the call
          sheet loader; and frame rate, new here, placed FIRST, ahead of the
          clip counter it used to be locked inside at project creation. Every
          camera in the project shares one rate and every timecode below
          depends on it, so it reads as the project's clock before it reads
          as a camera setting. See FpsSection for why changing it after
          takes exist is safe, and why it still isn't a bare toggle. */}
      {setupOpen && (
        <Sheet title="Setup" onClose={() => setSetupOpen(false)}>
          <FpsSection project={project} takeCount={totalTakeCount} onCommit={commitProject} />

          <ClipCounterSection project={project} onCommit={commitProject} />

          <SoundSection project={project} onCommit={commitProject} />

          <QuickTagsSection project={project} onCommit={commitProject} />

          <FootageFolderSection project={project} onCommit={commitProject} />

          <TcCalculator project={project} />

          {/* TODAY'S CALL SHEET, re-attached. onPickCallSheet and its cs* state
              were left in place when the button that reaches them was pulled
              off the scene section in 1b49a4d, with a note that they would
              move under this menu. This is that move: nothing about the
              upload -> read -> match -> reorder path below changed. */}
          {slates && slates.length >= 2 && (
            <div className="section">
              <label className={`btn btn--full sp-upload${csBusy ? ' btn--disabled' : ''}`}>
                {csPhase === 'reading'
                  ? 'Reading call sheet…'
                  : csPhase === 'thinking'
                    ? 'Matching scenes…'
                    : "Today's call sheet"}
                <input
                  type="file"
                  accept="application/pdf,.pdf"
                  hidden
                  disabled={csBusy}
                  onChange={onPickCallSheet}
                />
              </label>
              {csError && (
                <span className="tnum tnum--bad" style={{ display: 'block', marginTop: 8 }}>
                  {csError}
                </span>
              )}
              {csNote && !csError && (
                <span className="section__note" style={{ display: 'block', marginTop: 8 }}>
                  {csNote}
                </span>
              )}
            </div>
          )}

          {/* DELETE THE PROJECT stays the last item in the menu, which is where
              iOS puts destroy inside a settings surface (delete-contact,
              delete-album) - unchanged from where it sat at the bottom of the
              page, only now the page it is the bottom of is this sheet. Its
              confirmation is untouched: `deletingProject` still drives the
              same Confirm rendered below, at the screen level, so a second
              sheet stacks over this one exactly the way scene delete already
              stacks a Confirm over the rename sheet. */}
          <section className="section">
            <button
              type="button"
              className="btn btn--danger btn--full"
              onClick={() => {
                haptics.tap();
                setSetupOpen(false);
                setDeletingProject(true);
              }}
            >
              Delete project
            </button>
          </section>
        </Sheet>
      )}

      {renaming && (
        <RenameSheet
          slate={renaming}
          onClose={() => setRenaming(null)}
          onSave={async (name) => {
            await store.updateSlate(renaming.id, { name });
            setRenaming(null);
            void refresh();
          }}
          onDelete={() => {
            const slate = renaming;
            setRenaming(null);
            setDeleting(slate);
          }}
        />
      )}

      {/* A project called "Again?" was producing "Delete Again??". */}
      {deletingProject && (
        <Confirm
          title={`Delete ${project.name.replace(/[?!.]+$/, '')}?`}
          message="This removes the project and every scene, shot, take and moment in it. This cannot be undone."
          confirmLabel="Delete project"
          onCancel={() => setDeletingProject(false)}
          onConfirm={async () => {
            await store.deleteProject(project.id);
            setDeletingProject(false);
            props.onDeleted();
          }}
        />
      )}

      {deleting && (
        <Confirm
          title={`Delete scene ${deleting.name}?`}
          message="This removes the scene and all of its shots, takes and moments. This cannot be undone."
          confirmLabel="Delete scene"
          onCancel={() => setDeleting(null)}
          onConfirm={async () => {
            await store.deleteSlate(deleting.id);
            setDeleting(null);
            void refresh();
          }}
        />
      )}
    </div>
  );

  async function addSlate() {
    const name = addName.trim();
    if (!name) return;
    haptics.tap();
    await store.createSlate(project.id, name);
    setAddName('');
    void refresh();
  }

  async function onPickCallSheet(e: ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0];
    e.target.value = ''; // let the same file be picked again after an error
    if (!file || !slates) return;
    setCsError(null);
    setCsNote(null);
    if (!csSession) {
      setCsShowSignIn(true);
      return;
    }
    try {
      setCsPhase('reading');
      const text = await extractPdfText(file);
      if (text.trim().length < 40) {
        throw new Error('That PDF had no readable text. A scan or photo will not work. Use a text PDF.');
      }
      setCsPhase('thinking');
      const currentSlates = slates.map((s) => s.slate);
      const scenes = currentSlates.map((s) => ({ ref: s.scriptRef || s.id, name: s.name }));
      const { today } = await breakdownCallSheet(text, file.name, scenes);

      // Match each call-sheet entry back to a slate (scriptRef, else id), then
      // sort the matches into the call sheet's own order.
      const byRef = new Map(currentSlates.map((s) => [s.scriptRef, s]));
      const byId = new Map(currentSlates.map((s) => [s.id, s]));
      const matched: { slate: Slate; order: number }[] = [];
      for (const entry of today) {
        const slate = byRef.get(entry.ref) ?? byId.get(entry.ref);
        if (slate) matched.push({ slate, order: entry.order });
      }
      matched.sort((a, b) => a.order - b.order);

      const todaySlateIds = new Set(matched.map((m) => m.slate.id));
      const remaining = sortForDisplay(currentSlates).filter((s) => !todaySlateIds.has(s.id));
      const orderedIds = [...matched.map((m) => m.slate.id), ...remaining.map((s) => s.id)];

      haptics.tap();
      await store.reorderSlates(project.id, orderedIds);
      await Promise.all(
        currentSlates.map((s) => store.updateSlate(s.id, { today: todaySlateIds.has(s.id) })),
      );
      await refresh();
      setCsPhase('idle');
      setCsNote(`Today: ${matched.length} scene${matched.length === 1 ? '' : 's'}`);
      setLiveMsg(`Loaded today's call sheet: ${matched.length} scenes moved to the top`);
    } catch (err) {
      setCsPhase('idle');
      if (err instanceof SignInRequiredError) {
        setCsShowSignIn(true);
        return;
      }
      if (err instanceof Error && err.message === 'CAP') {
        track('cap_hit', { which: 'callsheet' });
        setCsError('Free limit reached. More coming soon.');
        return;
      }
      setCsError(err instanceof Error ? err.message : 'Could not process that PDF.');
    }
  }
}

interface UnitDraft {
  camera?: string;
  prefix: string;
  num: string;
  pad: string;
  ext: string;
  suffix: string;
  operator: string;
}

// Seed one draft per possible unit (A-D) from the project. Unit A of a single-cam
// project comes from the top-level clip fields; empty slots get sensible defaults.
function draftsFromProject(project: Project): UnitDraft[] {
  const presetExt = findPreset(project.camera)?.ext ?? '';
  return UNIT_LETTERS.map((_, i) => {
    const u = project.cameras?.[i];
    if (u) {
      return {
        camera: u.camera,
        prefix: u.clipPrefix,
        num: String(u.nextClipNumber),
        pad: String(u.clipPadding),
        ext: u.clipExt ?? '',
        suffix: u.clipSuffix ?? '',
        operator: u.operator ?? '',
      };
    }
    if (i === 0 && !project.cameras) {
      return {
        camera: project.camera,
        prefix: project.clipPrefix,
        num: String(project.nextClipNumber),
        pad: String(project.clipPadding),
        ext: project.clipExt ?? presetExt,
        suffix: project.clipSuffix ?? '',
        operator: '',
      };
    }
    return { camera: 'sony', prefix: 'C', num: '1', pad: '4', ext: '.MP4', suffix: '', operator: '' };
  });
}

/**
 * Every counter WRAP DAY is about to reset, in the same "PrefixNNNN" shape
 * the rest of the project screen already shows — named units for multi-cam,
 * the single top-level counter otherwise, plus the sound file counter when
 * the project carries one. This is what "naming what will happen" in the
 * confirmation means: the operator sees the exact numbers before agreeing to
 * a destructive reset, not just the word "reset".
 */
function wrapPreview(project: Project): string {
  const parts: string[] =
    project.cameras && project.cameras.length > 0
      ? project.cameras.map(
          (u) => `${u.letter} ${clipName(u.clipPrefix, u.clipStart ?? 1, u.clipPadding, u.clipSuffix)}`,
        )
      : [clipName(project.clipPrefix, project.clipStart ?? 1, project.clipPadding, project.clipSuffix ?? '')];
  if (project.sound) {
    parts.push(
      `SND ${formatClip(project.sound.filePrefix, project.sound.fileStart ?? 1, project.sound.filePadding, project.sound.fileSuffix)}`,
    );
  }
  return parts.join('  ·  ');
}

// Shoot day: WRAP DAY is a human signal, never a clock guess - the operator
// presses it once a day's cards are formatted and the counters reset
// IMMEDIATELY, so the crew sees C0001 waiting the next morning. Lives on the
// project screen, right above the clip counters it resets - never on the
// rolling screen, which is already at its size budget (see
// scripts/measure-roll.mjs).
function ShootDaySection(props: {
  project: Project;
  dayTakeCount: number;
  onCommit: (patch: Partial<Project>) => Promise<void>;
  onWrapped: () => void;
  onUndone: (openDay: Project['openShootDay']) => void;
  /** All rolled, Export and Backup, pre-built as three tile buttons in that
   *  order. Rendered under the same "Shoot day" head as Wrap day — see the
   *  call site's comment for why none of the four get their own section
   *  head, and this component's own render for how Wrap day's tile joins
   *  them into one 2x2 grid. */
  tiles: ReactNode;
}) {
  const { project } = props;
  const day = project.openShootDay;
  const [confirming, setConfirming] = useState(false);
  const [wrapped, setWrapped] = useState(false);
  const [undoError, setUndoError] = useState<string | null>(null);

  async function doWrap() {
    const { project: next } = wrapShootDay(project, Date.now());
    await props.onCommit(next);
    // A PRESS count, never presented as "shoot days": a crew that forgets to
    // wrap simply keeps logging under the day that's still open, and this
    // event has no way to tell that apart from a day that genuinely had one
    // long session. See the dashboard's own "Not shown" card for the same
    // caveat already written about ROLL/CUT.
    track('wrap_day', { action: 'wrap' });
    setConfirming(false);
    setWrapped(true);
    props.onWrapped();
    window.setTimeout(() => setWrapped(false), 1400);
  }

  async function doUndo() {
    setUndoError(null);
    const result = undoWrapShootDay(project, Date.now());
    if (!result.ok) {
      setUndoError(result.reason);
      return;
    }
    await props.onCommit(result.project);
    track('wrap_day', { action: 'undo' });
    props.onUndone(result.project.openShootDay);
  }

  const dayLabel = day ? `Day ${day.index}` : 'Day 1';
  const dateLabel = day ? shortDateLabel(day.date) : '';
  const takeWord = props.dayTakeCount === 1 ? 'take' : 'takes';
  // Hide the button once a take has landed on the new day rather than show a
  // dead one — undoWrapShootDay's own refusal (surfaced via undoError) is
  // still the backstop if this device's state is a beat behind another's.
  const canUndo = !!project.pendingWrapUndo && day?.firstTakeAt === undefined;

  return (
    <section className="section">
      <div className="section__head">
        <span className="label">Shoot day</span>
      </div>
      <div className="clipwidget__preview" style={{ marginBottom: 14 }}>
        <span className="label">
          {dayLabel}
          {dateLabel && <> &middot; {dateLabel}</>}
        </span>
        {/* ROUND 3: a day that has not started yet. "0 takes" is arithmetic
            about nothing; the day has not begun, and the app already knows
            that the first take is what begins it. Say that instead. */}
        {props.dayTakeCount === 0 ? (
          <span className="section__note">not started</span>
        ) : (
          <span className="tnum">
            {props.dayTakeCount} {takeWord}
          </span>
        )}
      </div>
      {props.dayTakeCount === 0 && (
        <p className="camnote" style={{ marginTop: -6 }}>
          {day ? `Day ${day.index}` : 'Day 1'} opens itself with your first take.
        </p>
      )}
      {/* ICON TILES, TWO ACROSS. Four identical full-width bars (Wrap day,
          Every clip rolled, Export, Backup) used to run one below the other -
          same width, same height, same weight - which is the "endless" the
          owner flagged twice. He was shown three shapes and picked this one:
          a 2x2 grid, an icon over a short label, sized to use the room a
          two-up grid actually has. See skin/detail.css `.shoottiles` for the
          grid and `.tile` for the shared face - still the SAME secondary
          material `.btn` draws everywhere else (unfilled, a hairline, full
          ink), only the shape changed.

          All rolled / Export / Backup arrive as `props.tiles`, already built
          by their own owners (ProjectScreen and ExportBar). Wrap day's tile
          is built here because its confirm/undo state lives in this
          component. Grid position is pinned by CSS `order`, not by this DOM
          position, so Export's and Backup's own error banners (DOM siblings
          of their tiles) never knock Wrap day out of the bottom-right cell -
          see the `.shoottiles__extra` comment in detail.css. */}
      <div className="shoottiles">
        {props.tiles}
        <button
          type="button"
          className="tile tile--wrap tile--rec"
          onClick={() => setConfirming(true)}
        >
          <span className="tile__icon" aria-hidden="true">
            <StopMark />
          </span>
          <span className="tile__label">{wrapped ? 'Wrapped' : 'Wrap day'}</span>
        </button>
        {canUndo && (
          <button
            type="button"
            className="shoottiles__extra btn btn--full btn--ghost"
            onClick={() => void doUndo()}
          >
            Undo wrap
          </button>
        )}
        {undoError && <span className="shoottiles__extra tnum tnum--bad">{undoError}</span>}
      </div>
      {confirming && (
        <Confirm
          title={`Wrap ${dayLabel}?`}
          message={`Every counter resets back to ${wrapPreview(project)}. Day ${(day?.index ?? 1) + 1} opens right away, so the crew sees it waiting next time they roll. You can undo this until the first take is logged on the new day.`}
          confirmLabel="Wrap day"
          onCancel={() => setConfirming(false)}
          onConfirm={() => void doWrap()}
        />
      )}
    </section>
  );
}

// Frame rate. Used to live nowhere but project creation - written once in
// NewProjectSheet.tsx or ShotlistSheet.tsx and never again - which was fine
// until PODCAST mode started skipping the question entirely and inheriting a
// guess (see newRoll.ts). A guess that can't be corrected is a bug; this is
// the correction.
//
// Reuses FPS_OPTIONS from fps.ts rather than a second list, and the same
// "pick a chip, then tap Set" two-step ClipCounterSection already uses below:
// selecting a rate touches nothing by itself, same as a clip prefix draft.
//
// What a change actually costs, checked directly against types.ts before any
// of this copy was written: Take.durationMs is milliseconds - real elapsed
// time off the clock, not a frame count - and Take.startedAt is an epoch
// timestamp. NEITHER is stored in frames. So changing project.fps rewrites
// no take: every take that already exists keeps the exact real-world
// duration and start time it was logged with. What DOES change is every
// place that turns that real time INTO frames from here on: the timecode
// calculator below, and project.fps is read fresh at export time by
// export/fcpxml.ts, export/resolve.ts, export/pdf.ts and export/csv.ts to
// build the editor's frame-accurate timeline. A file already exported at the
// old rate is unaffected (it is a finished blob, not a live query); only a
// future export, or a live calculation, picks up the new rate.
//
// That is a real, if narrow, blast radius, so this is not "select and it's
// done" once a take exists: past that point, `Set` opens a named Confirm
// instead of committing. Before the first take, there is nothing for a
// change to touch, so it commits straight off the Set tap - the third option
// this was scoped against (free before the first take) rather than the
// "always ask" or "always free" ends of it.
//
// Both decisions below are pulled out as plain functions - same convention
// `exportFailureMessage` set for this file - so the gate and the exact wording
// are each a unit test, not just prose a future edit could quietly drift out
// of true.

/** Whether picking a new rate and tapping Set should open a named Confirm
 *  instead of committing straight away. `false` whenever the pick did not
 *  actually change anything (Set is disabled then anyway) or the project has
 *  no takes yet to reinterpret. */
export function fpsChangeNeedsConfirm(currentFps: Fps, draftFps: Fps, takeCount: number): boolean {
  return draftFps !== currentFps && takeCount > 0;
}

/** The named Confirm's copy once a change needs one. States exactly what
 *  checking Take.durationMs and the four export/*.ts modules (above) found:
 *  no take is rewritten, only future frame conversions of the same real
 *  time are - never a bare "are you sure". */
export function fpsChangeWarning(
  takeCount: number,
  fromFps: Fps,
  toFps: Fps,
): { title: string; message: string; confirmLabel: string } {
  return {
    title: `Change frame rate to ${toFps} fps?`,
    message: `${takeCount} take${takeCount === 1 ? '' : 's'} already logged. This won't touch any of them: durations are stored as real time, not frame counts. But it changes how that time counts as frames from here on, in the calculator above and in every Premiere, Resolve, PDF and CSV export. Anything already exported at ${fromFps} fps stays exactly as it was; re-export it if you need it to match.`,
    confirmLabel: `Change to ${toFps} fps`,
  };
}

function FpsSection(props: {
  project: Project;
  /** All-time takes in the project, from ProjectScreen's `slates` sum - 0
   *  means the rate can still commit straight off `Set`, no Confirm needed. */
  takeCount: number;
  onCommit: (patch: Partial<Project>) => Promise<void>;
}) {
  const { project } = props;
  const [draft, setDraft] = useState<Fps>(project.fps);
  const [confirming, setConfirming] = useState(false);
  const [saved, setSaved] = useState(false);

  useEffect(() => {
    setDraft(project.fps);
  }, [project.id, project.fps]);

  async function commit(fps: Fps) {
    await props.onCommit({ fps });
    setConfirming(false);
    setSaved(true);
    window.setTimeout(() => setSaved(false), 1400);
  }

  function trySet() {
    if (draft === project.fps) return;
    if (fpsChangeNeedsConfirm(project.fps, draft, props.takeCount)) {
      setConfirming(true);
      return;
    }
    void commit(draft);
  }

  const changed = draft !== project.fps;

  return (
    <section className="section">
      <div className="section__head">
        <span className="label">Frame rate</span>
        <span className="section__note">{project.fps} fps now</span>
      </div>
      <p className="camnote">{FPS_WARNING}</p>
      <div className="sl-grid" role="group" aria-label="Frame rate" style={{ marginTop: 10 }}>
        {FPS_OPTIONS.map(({ fps, note }) => (
          <button
            key={fps}
            type="button"
            className="sl-opt"
            data-on={draft === fps ? '' : undefined}
            aria-pressed={draft === fps}
            onClick={() => {
              haptics.tap();
              setDraft(fps);
            }}
          >
            <b className="tnum">{fps}</b>
            <span>{note}</span>
          </button>
        ))}
      </div>
      <button
        type="button"
        className="btn btn--full"
        style={{ marginTop: 12 }}
        disabled={!changed}
        onClick={trySet}
      >
        {saved ? 'Saved' : changed ? `Set to ${draft} fps` : 'Frame rate set'}
      </button>

      {confirming && (
        <Confirm
          {...fpsChangeWarning(props.takeCount, project.fps, draft)}
          onConfirm={() => void commit(draft)}
          onCancel={() => {
            setConfirming(false);
            setDraft(project.fps);
          }}
        />
      )}
    </section>
  );
}

// Shared with the New project flow's starting-clip-number field. See
// clampClipNumber in cameras.ts: a "1" typed there and a "1" typed here
// validate identically rather than carrying two rules for the same shape.
const clampNum = clampClipNumber;
const clampPad = (s: string) => Math.min(8, Math.max(1, parseInt(s, 10) || 1));

// Camera clip counter. Single-cam keeps the original one-counter widget; a
// Cameras 1-4 control lets a shoot go multi-cam, revealing an independent
// counter card per unit (A-D). Editing the count and each unit's numbers is all
// here, in the same handmade clip-counter register.
function ClipCounterSection(props: {
  project: Project;
  onCommit: (patch: Partial<Project>) => Promise<void>;
}) {
  const { project } = props;
  const [camCount, setCamCount] = useState(project.cameras?.length ?? 1);
  const [units, setUnits] = useState<UnitDraft[]>(() => draftsFromProject(project));
  const [saved, setSaved] = useState(false);

  useEffect(() => {
    setCamCount(project.cameras?.length ?? 1);
    setUnits(draftsFromProject(project));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [project.id, project.cameras, project.clipPrefix, project.nextClipNumber, project.clipPadding, project.clipExt]);

  function setUnit(i: number, patch: Partial<UnitDraft>) {
    setUnits((prev) => prev.map((u, idx) => (idx === i ? { ...u, ...patch } : u)));
  }

  function previewOf(u: UnitDraft): string {
    return u.prefix + String(clampNum(u.num)).padStart(clampPad(u.pad), '0') + u.suffix + u.ext.trim();
  }

  async function save() {
    if (camCount === 1) {
      const u = units[0];
      await props.onCommit({
        camera: u.camera,
        clipPrefix: u.prefix,
        clipSuffix: u.suffix,
        nextClipNumber: clampNum(u.num),
        clipPadding: clampPad(u.pad),
        clipExt: u.ext.trim(),
        cameras: undefined, // drop back to single-cam if we came from multi
      });
    } else {
      const cameras: CameraUnit[] = units.slice(0, camCount).map((u, i) => ({
        letter: UNIT_LETTERS[i],
        ...(u.camera ? { camera: u.camera } : {}),
        clipPrefix: u.prefix,
        nextClipNumber: clampNum(u.num),
        clipPadding: clampPad(u.pad),
        clipSuffix: u.suffix,
        clipExt: u.ext.trim(),
        ...(u.operator.trim() ? { operator: u.operator.trim() } : {}),
      }));
      const a = cameras[0];
      await props.onCommit({
        cameras,
        camera: a.camera,
        clipPrefix: a.clipPrefix,
        clipSuffix: a.clipSuffix,
        nextClipNumber: a.nextClipNumber,
        clipPadding: a.clipPadding,
        clipExt: a.clipExt ?? '',
      });
    }
    setSaved(true);
    window.setTimeout(() => setSaved(false), 1400);
  }

  const cameraLabel = findPreset(project.camera)?.label;
  // The caveat is about the SHOOT, not one camera: one approximate unit makes
  // the whole rig's file names approximate to whoever is relinking them.
  const multiApprox = units
    .slice(0, camCount)
    .some((u) => {
      const preset = findPreset(u.camera);
      return !!preset && !preset.exact;
    });

  const numFields = (u: UnitDraft, i: number, idBase: string) => (
    <>
      <div className="clipgrid">
        <div className="formrow" style={{ margin: 0 }}>
          <label className="label" htmlFor={`${idBase}-prefix`}>
            Prefix
          </label>
          <input
            id={`${idBase}-prefix`}
            className="field field--mono"
            value={u.prefix}
            onChange={(e) => setUnit(i, { prefix: e.target.value })}
          />
        </div>
        <div className="formrow" style={{ margin: 0 }}>
          <label className="label" htmlFor={`${idBase}-num`}>
            Number
          </label>
          <input
            id={`${idBase}-num`}
            className="field field--mono"
            inputMode="numeric"
            value={u.num}
            onChange={(e) => setUnit(i, { num: e.target.value.replace(/[^0-9]/g, '') })}
          />
        </div>
        <div className="formrow" style={{ margin: 0 }}>
          <label className="label" htmlFor={`${idBase}-pad`}>
            Digits
          </label>
          <input
            id={`${idBase}-pad`}
            className="field field--mono"
            inputMode="numeric"
            value={u.pad}
            onChange={(e) => setUnit(i, { pad: e.target.value.replace(/[^0-9]/g, '') })}
          />
        </div>
      </div>
      <div className="formrow" style={{ marginTop: 12, marginBottom: 0 }}>
        <label className="label" htmlFor={`${idBase}-ext`}>
          File extension <span className="section__note">links footage in Premiere</span>
        </label>
        <input
          id={`${idBase}-ext`}
          className="field field--mono"
          value={u.ext}
          placeholder=".MOV"
          autoCapitalize="characters"
          spellCheck={false}
          onChange={(e) => setUnit(i, { ext: e.target.value })}
        />
      </div>
    </>
  );

  return (
    <section className="section">
      {/* VIDEO and AUDIO are the two recording DEPARTMENTS, and they are named
          that here for the same reason they are named that in the new-project
          sheet: they are separate streams with separate file counters that land
          on one shared shot, and a crew already thinks of them as two desks.
          "Camera clip counter" described a control; this describes the desk. */}
      <div className="formsection">
        <span className="label">Video</span>
        <span className="section__note">picture · camera clips</span>
        <span className="formsection__rule" />
      </div>
      <div className="section__head">
        <span className="label">Clip counter</span>
        {camCount > 1 ? (
          <span className="section__note">{camCount} cameras</span>
        ) : (
          cameraLabel && <span className="section__note">{cameraLabel}</span>
        )}
      </div>

      <div className="formrow" style={{ marginBottom: 14 }}>
        <span className="label">Cameras</span>
        <div className="camcount" role="group" aria-label="Number of cameras">
          {[1, 2, 3, 4].map((n) => (
            <button
              key={n}
              type="button"
              className={`camcount__opt${camCount === n ? ' camcount__opt--on' : ''}`}
              aria-pressed={camCount === n}
              onClick={() => setCamCount(n)}
            >
              {n}
            </button>
          ))}
        </div>
      </div>

      {camCount === 1 ? (
        <div className="clipwidget">
          <div className="clipwidget__preview">
            <span className="label">Next clip</span>
            <span className="tnum">{previewOf(units[0])}</span>
          </div>
          {numFields(units[0], 0, 'cc')}
          <button
            type="button"
            className="btn btn--full"
            style={{ marginTop: 12 }}
            onClick={() => void save()}
          >
            {saved ? 'Saved' : 'Set clip counter'}
          </button>
        </div>
      ) : (
        <>
          {/* Two cameras used to be drawn as ONE dark mass with a slot milled
              between them, on the reasoning that a rig shares a frame rate and
              rolls on the same CUT. True, and it still cost more than it paid:
              it made the clip counter a different material at 2 cameras than
              at 1, and the slot rendered as a black tab protruding from under
              camera A. Cards with a gap, same surface as the single-cam card.
              See skin/projects.css `.pj-units`. */}
          <div className="pj-units">
            {units.slice(0, camCount).map((u, i) => (
              <Fragment key={UNIT_LETTERS[i]}>
                <div className="camunit">
                  <div className="camunit__head">
                    <span className="camunit__badge">{UNIT_LETTERS[i]}</span>
                    <span className="camunit__eg tnum">{previewOf(u)}</span>
                  </div>
                  <div style={{ marginTop: 12 }}>{numFields(u, i, `cc-${i}`)}</div>
                  <div className="formrow" style={{ marginTop: 12, marginBottom: 0 }}>
                    <label className="label" htmlFor={`cc-${i}-operator`}>
                      Operator <span className="section__note">optional</span>
                    </label>
                    <input
                      id={`cc-${i}-operator`}
                      className="field"
                      placeholder="e.g. Rohan"
                      value={u.operator}
                      onChange={(e) => setUnit(i, { operator: e.target.value })}
                    />
                  </div>
                </div>
              </Fragment>
            ))}
          </div>
          {/* The honest badge, from cameras.ts. An approximate name is not an
              error — it is a camera stamping a record time nobody can know in
              advance — so it is brass, and it is said once. */}
          <div className="pj-approx">
            <span>Links in Premiere as</span>
            <span className="pj-approx__eg">{previewOf(units[0])}</span>
            <span className={multiApprox ? 'pj-approx__flag' : undefined}>
              {multiApprox ? 'approx' : 'exact'}
            </span>
          </div>
          <button
            type="button"
            className="btn btn--full"
            style={{ marginTop: 12 }}
            onClick={() => void save()}
          >
            {saved ? 'Saved' : 'Set clip counters'}
          </button>
        </>
      )}
    </section>
  );
}

// Production sound: a single recorder unit, orthogonal to the camera setup
// above - on or off, independent of camera count. Mirrors ClipCounterSection's
// card shape (on/off toggle, then a clip-format-style widget) so the two
// registers read as one family of controls.
function SoundSection(props: {
  project: Project;
  onCommit: (patch: Partial<Project>) => Promise<void>;
}) {
  const { project } = props;
  const [on, setOn] = useState(!!project.sound);
  const [operator, setOperator] = useState(project.sound?.operator ?? '');
  const [recorder, setRecorder] = useState(project.sound?.recorder ?? '');
  const [prefix, setPrefix] = useState(project.sound?.filePrefix ?? 'SND_');
  const [num, setNum] = useState(String(project.sound?.nextFileNumber ?? 1));
  const [pad, setPad] = useState(String(project.sound?.filePadding ?? 4));
  const [ext, setExt] = useState(project.sound?.fileExt ?? '.WAV');
  const [saved, setSaved] = useState(false);

  useEffect(() => {
    setOn(!!project.sound);
    setOperator(project.sound?.operator ?? '');
    setRecorder(project.sound?.recorder ?? '');
    setPrefix(project.sound?.filePrefix ?? 'SND_');
    setNum(String(project.sound?.nextFileNumber ?? 1));
    setPad(String(project.sound?.filePadding ?? 4));
    setExt(project.sound?.fileExt ?? '.WAV');
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [project.id, project.sound]);

  const preview = prefix + String(clampNum(num)).padStart(clampPad(pad), '0') + ext.trim();

  async function save() {
    if (on) {
      await props.onCommit({
        sound: {
          filePrefix: prefix,
          nextFileNumber: clampNum(num),
          filePadding: clampPad(pad),
          fileExt: ext.trim(),
          ...(recorder.trim() ? { recorder: recorder.trim() } : {}),
          ...(operator.trim() ? { operator: operator.trim() } : {}),
        },
      });
    } else {
      // Drop back to no sound at all - the same "undefined clears it" pattern
      // ClipCounterSection uses to fall back out of multi-cam.
      await props.onCommit({ sound: undefined });
    }
    setSaved(true);
    window.setTimeout(() => setSaved(false), 1400);
  }

  return (
    <section className="section">
      {/* The second department, co-equal with VIDEO above and never a member of
          it: sound is orthogonal to camera count in the data model, and the
          header has to say so — a single-cam doc shoot still has its own mixer.
          Coloured on --sound-text for the same reason the new-project sheet
          does: it is the one place a second signal colour earns its keep. */}
      <div className="formsection">
        <span className="label" style={{ color: 'var(--sound-text)' }}>
          Audio
        </span>
        <span className="section__note">sound · recorder files</span>
        <span className="formsection__rule" />
      </div>
      <div className="section__head">
        <span className="label">Production sound</span>
        {on && project.sound?.operator && <span className="section__note">{project.sound.operator}</span>}
      </div>

      <div className="formrow" style={{ marginBottom: on ? 14 : 0 }}>
        <span className="label">Recording sound</span>
        <div className="camcount" role="group" aria-label="Production sound" style={{ gridTemplateColumns: '1fr 1fr' }}>
          <button
            type="button"
            className={`camcount__opt${!on ? ' camcount__opt--on' : ''}`}
            aria-pressed={!on}
            onClick={() => setOn(false)}
          >
            Off
          </button>
          <button
            type="button"
            className={`camcount__opt${on ? ' camcount__opt--on' : ''}`}
            aria-pressed={on}
            onClick={() => setOn(true)}
          >
            On
          </button>
        </div>
      </div>

      {on && (
        <div className="clipwidget">
          <div className="clipwidget__preview">
            <span className="label">Next file</span>
            <span className="tnum">{preview}</span>
          </div>
          <div className="formrow" style={{ marginBottom: 12 }}>
            <label className="label" htmlFor="snd-operator">
              Mixer <span className="section__note">optional</span>
            </label>
            <input
              id="snd-operator"
              className="field"
              placeholder="e.g. Priya"
              value={operator}
              onChange={(e) => setOperator(e.target.value)}
            />
          </div>
          <div className="formrow" style={{ marginBottom: 12 }}>
            <label className="label" htmlFor="snd-recorder">
              Recorder <span className="section__note">optional</span>
            </label>
            <input
              id="snd-recorder"
              className="field"
              placeholder="e.g. MixPre-6"
              value={recorder}
              onChange={(e) => setRecorder(e.target.value)}
            />
          </div>
          <div className="clipgrid">
            <div className="formrow" style={{ margin: 0 }}>
              <label className="label" htmlFor="snd-prefix">
                Prefix
              </label>
              <input
                id="snd-prefix"
                className="field field--mono"
                value={prefix}
                onChange={(e) => setPrefix(e.target.value)}
              />
            </div>
            <div className="formrow" style={{ margin: 0 }}>
              <label className="label" htmlFor="snd-num">
                Number
              </label>
              <input
                id="snd-num"
                className="field field--mono"
                inputMode="numeric"
                value={num}
                onChange={(e) => setNum(e.target.value.replace(/[^0-9]/g, ''))}
              />
            </div>
            <div className="formrow" style={{ margin: 0 }}>
              <label className="label" htmlFor="snd-pad">
                Digits
              </label>
              <input
                id="snd-pad"
                className="field field--mono"
                inputMode="numeric"
                value={pad}
                onChange={(e) => setPad(e.target.value.replace(/[^0-9]/g, ''))}
              />
            </div>
          </div>
          <div className="formrow" style={{ marginTop: 12, marginBottom: 0 }}>
            <label className="label" htmlFor="snd-ext">
              File extension
            </label>
            <input
              id="snd-ext"
              className="field field--mono"
              value={ext}
              placeholder=".WAV"
              autoCapitalize="characters"
              spellCheck={false}
              onChange={(e) => setExt(e.target.value)}
            />
          </div>
        </div>
      )}

      <button type="button" className="btn btn--full" style={{ marginTop: 12 }} onClick={() => void save()}>
        {saved ? 'Saved' : 'Set sound'}
      </button>
    </section>
  );
}

// The editor's footage folder: the fix for the bug that started all of this.
//
// A real 232-clip Premiere import landed EVERY clip offline and had to be
// located by hand. The cause is in the format, not the app: <pathurl> is an
// absolute URL, so a bare "clip_0054.MP4" resolves to the root of the boot
// volume, where nothing ever is. The phone cannot know the edit machine's disk
// layout, so somebody has to type it once, and this is where.
//
// Optional on purpose. Left empty the exporters keep writing bare file names,
// which is what Premiere's "relink others automatically" is actually good at,
// and multi-cam still nests each unit in its own folder so day 1's A/C0001 can
// never claim day 5's. Filled in, the same export imports online with no
// relinking at all.
//
// Stored verbatim. The exporters own the encoding, because xmeml and FCPXML
// disagree about the scheme, and a path mangled here would be wrong in both.
/**
 * The quick-tag chips THIS shoot offers, editable after the fact.
 *
 * Kirtan's request (2026-08-15): "in the podcast mode we give them optoins to
 * add other tags for thri shoot." It is not podcast-only in the end, because
 * the gap was never mode-specific — until now the only moment you could choose
 * a vocabulary was the New project sheet, and Podcast mode never shows one
 * (startPodcastRoll goes straight to a slate, which is the point of it). A
 * director who realises on day two that they want STUNT is in exactly the same
 * bind. One section, both modes.
 *
 * NOT on the rolling screen, deliberately. Editing your own instrument panel
 * while a camera runs is how you mis-tap the take you were trying to log; this
 * is setup, and setup lives with the other setup, below the fold.
 *
 * Writes THROUGH on every change, no Save button — the sibling sections here
 * have one because they hold a text field mid-edit, where a keystroke is not
 * yet a decision. Adding or removing a chip is already the whole decision.
 * Removing a tag never touches takes already logged with it: `Take.tag` is a
 * plain string on the take, so the history keeps its word and only the keypad
 * stops offering it.
 */
function QuickTagsSection(props: {
  project: Project;
  onCommit: (patch: Partial<Project>) => Promise<void>;
}) {
  const { project } = props;
  const mode: ProjectMode = project.mode === 'podcast' ? 'podcast' : 'video';

  return (
    <section className="section">
      <div className="section__head">
        <span className="label">Quick tags</span>
        <span className="section__note tnum">{project.tags.length}</span>
      </div>

      <div className="clipwidget">
        <TagEditor
          tags={project.tags}
          onChange={(next) => {
            void props.onCommit({ tags: next });
          }}
          note="What the roll screen offers under the take counter. Takes already logged keep the tags they were given."
        />

        {project.tags.length === 0 && (
          <button
            type="button"
            className="btn btn--ghost btn--full"
            onClick={() => {
              haptics.tap();
              void props.onCommit({ tags: getDefaultTags(mode) });
            }}
          >
            Put the standard set back
          </button>
        )}
      </div>
    </section>
  );
}

/** Every clip name this project has logged, one per camera file — the list the
 *  picked folder gets checked against. Multi-cam takes carry one name per
 *  unit; single-cam takes carry theirs in `clipName`. */
async function loggedClipNames(projectId: string): Promise<string[]> {
  const bundle = await store.getBundle(projectId);
  return bundle.takes.flatMap((t) =>
    t.clips && t.clips.length ? t.clips.map((c) => c.clipName) : [t.clipName],
  );
}

function FootageFolderSection(props: {
  project: Project;
  onCommit: (patch: Partial<Project>) => Promise<void>;
}) {
  const { project } = props;
  const [root, setRoot] = useState(project.mediaRoot ?? '');
  const [saved, setSaved] = useState(false);
  // The walk of the folder picked ON THIS DEVICE, plus how much of the shoot
  // it accounts for. `takeCount` is read alongside so the count reads "9 of
  // 12", not a bare 9 — a number with no denominator cannot tell you whether
  // you pointed at the right disk, which is the entire question being asked.
  const [walk, setWalk] = useState<MediaIndex | undefined>(undefined);
  const [matched, setMatched] = useState<{ hit: number; total: number } | null>(null);
  const [scanning, setScanning] = useState(false);
  const [pickError, setPickError] = useState<string | null>(null);
  const dirInput = useRef<HTMLInputElement | null>(null);
  const kind = pickerKind();

  useEffect(() => {
    setRoot(project.mediaRoot ?? '');
  }, [project.id, project.mediaRoot]);

  // Reload the remembered walk when the project changes, and re-count against
  // it: takes logged since the pick are new rows the folder has never been
  // measured against.
  useEffect(() => {
    let live = true;
    void (async () => {
      const saved = await loadMediaIndex(project.id);
      if (!live) return;
      setWalk(saved);
      if (!saved) {
        setMatched(null);
        return;
      }
      const names = await loggedClipNames(project.id);
      if (!live) return;
      setMatched({ hit: countMatched(saved, names), total: names.length });
    })();
    return () => {
      live = false;
    };
  }, [project.id]);

  /** Index a pick, count it against the shoot, and remember it. */
  async function absorb(picked: PickedFolder): Promise<void> {
    const index = buildMediaIndex(picked.relativePaths, picked.rootName);
    if (index.fileCount === 0) {
      // Distinguish the two ways this ends up empty, because the fixes are
      // opposite: an empty folder is the user's problem, a browser that
      // ignored `webkitdirectory` and ran a plain file picker is ours.
      setPickError(
        picked.relativePaths.length === 0
          ? 'That folder handed over nothing. Either it is empty, or this browser will not give a whole folder up.'
          : 'Nothing in there looks like footage. Pick the folder the cards were copied into, not the project folder.',
      );
      return;
    }
    setPickError(null);
    setWalk(index);
    const names = await loggedClipNames(project.id);
    setMatched({ hit: countMatched(index, names), total: names.length });
    await saveMediaIndex(project.id, index);
  }

  async function pick(): Promise<void> {
    haptics.tap();
    setPickError(null);
    if (kind === 'handle') {
      setScanning(true);
      try {
        const picked = await pickFolderViaHandle();
        if (picked) await absorb(picked);
      } catch {
        setPickError('Could not read that folder.');
      } finally {
        setScanning(false);
      }
      return;
    }
    dirInput.current?.click();
  }

  async function onFiles(e: ChangeEvent<HTMLInputElement>): Promise<void> {
    const files = Array.from(e.target.files ?? []);
    // Let the same folder be picked twice in a row (a card finished copying
    // between attempts) — without this the input holds the old value and
    // fires nothing.
    e.target.value = '';
    if (files.length === 0) return;
    setScanning(true);
    try {
      await absorb(pickedFromFiles(files, 'Footage'));
    } finally {
      setScanning(false);
    }
  }

  async function forget(): Promise<void> {
    haptics.tap();
    await clearMediaIndex(project.id);
    setWalk(undefined);
    setMatched(null);
    setPickError(null);
  }

  const trimmed = root.trim().replace(/\/+$/, '');
  const example =
    clipName(project.clipPrefix, project.nextClipNumber, project.clipPadding, project.clipSuffix) +
    (project.clipExt ?? '');
  // Multi-cam always nests by unit, with or without a root: two cameras of the
  // same model natively write the identical file name on the same day. Mirrors
  // the rule in export/fcpxml.ts rather than restating it, so the preview
  // cannot quietly promise a layout the exporter does not write.
  const unitFolder = isMultiCam(project) ? 'A/' : '';
  const preview = trimmed ? `${trimmed}/${unitFolder}${example}` : `${unitFolder}${example}`;

  async function save() {
    // Empty clears it back to undefined rather than storing "", the same way
    // the other sections fall back out of a mode they are no longer in.
    await props.onCommit({ mediaRoot: trimmed || undefined });
    setSaved(true);
    window.setTimeout(() => setSaved(false), 1400);
  }

  return (
    <section className="section">
      <div className="section__head">
        <span className="label">Footage folder</span>
        <span className="section__note">{project.mediaRoot ? 'set' : 'optional'}</span>
      </div>

      <div className="clipwidget">
        {/* NOT `.clipwidget__preview`, which the sibling sections use: that
            renders its value at display size, and a 68-character volume path
            set in bold 32px pushed the whole page sideways (measured: 464px of
            content in a 390px viewport). A path is checked once, carefully, so
            it wraps at secondary size instead of shouting off the edge. */}
        <div className="formrow" style={{ marginBottom: 12 }}>
          <span className="label">Links as</span>
          <span
            className="tnum"
            style={{ fontSize: 'var(--t-secondary)', lineHeight: 1.45, overflowWrap: 'anywhere' }}
          >
            {preview}
          </span>
        </div>
        <div className="formrow" style={{ margin: 0 }}>
          <label className="label" htmlFor="media-root">
            Path on the edit machine
          </label>
          <input
            id="media-root"
            className="field field--mono"
            value={root}
            placeholder="/Volumes/My Book/day 1/M4ROOT/CLIP"
            autoCapitalize="none"
            autoCorrect="off"
            spellCheck={false}
            onChange={(e) => setRoot(e.target.value)}
          />
        </div>
      </div>

      {/* `.section__note` is built for the short right-aligned tag beside a
          section title: one line, nowrap, ellipsis. This is a sentence, so it
          borrows the colour and size and gives back the truncation. */}
      <p
        className="section__note"
        style={{
          marginTop: 12,
          marginBottom: 0,
          textAlign: 'left',
          whiteSpace: 'normal',
          overflow: 'visible',
          lineHeight: 1.45,
        }}
      >
        Where the cards are copied to, on the machine that will cut this. Fill it in and Premiere
        imports the whole timeline online. Leave it empty and the clips import offline, ready to
        relink by hand.
      </p>

      <button type="button" className="btn btn--full" style={{ marginTop: 12 }} onClick={() => void save()}>
        {saved ? 'Saved' : 'Set folder'}
      </button>

      {/* -------------------------------------------------------------- pick --
          Typing the root above says where the footage lives. This says what is
          IN there — Clapper walks the folder for real and checks every logged
          clip against it, so a wrong disk, a card that never finished copying
          or a mis-typed prefix shows up here at wrap instead of in the edit
          suite on Monday. The walk feeds the CSV's file_path column.

          A browser hands over a path RELATIVE to whatever gets picked and
          nothing above it, on purpose — so the two halves stay separate: the
          field above is the half only a person can supply, this is the half
          only the disk can. */}
      <div className="formrow" style={{ marginTop: 18, marginBottom: 0 }}>
        <span className="label">What is actually on the disk</span>
      </div>

      {/* Hidden, and driven by the button below: a bare file input renders as
          an OS control that cannot be styled and reads as a web form in the
          middle of an app. `webkitdirectory` is not in React's DOM typings —
          it is a real attribute on every browser that supports folder picking,
          React just has no declaration for it. */}
      <input
        ref={dirInput}
        type="file"
        multiple
        hidden
        {...({ webkitdirectory: '', directory: '' } as Record<string, string>)}
        onChange={(e) => void onFiles(e)}
      />

      {kind === 'none' ? (
        <p
          className="section__note"
          style={{
            marginTop: 10,
            marginBottom: 0,
            textAlign: 'left',
            whiteSpace: 'normal',
            overflow: 'visible',
            lineHeight: 1.45,
          }}
        >
          This browser will not hand over a whole folder, so there is nothing to walk. Set the path
          above and the exports still link by name. Folder picking works in Chrome and Edge, and on
          iPhone from iOS 18.4.
        </p>
      ) : (
        <>
          <button
            type="button"
            className="btn btn--full"
            style={{ marginTop: 10 }}
            disabled={scanning}
            onClick={() => void pick()}
          >
            {scanning ? 'Reading...' : walk ? 'Pick a different folder' : 'Link data from file browser'}
          </button>

          {walk && (
            <div className="clipwidget" style={{ marginTop: 12 }}>
              <div className="formrow" style={{ marginBottom: matched ? 12 : 0 }}>
                <span className="label">Walked</span>
                <span
                  className="tnum"
                  style={{ fontSize: 'var(--t-secondary)', lineHeight: 1.45, overflowWrap: 'anywhere' }}
                >
                  {walk.rootName} · {walk.fileCount} media {walk.fileCount === 1 ? 'file' : 'files'}
                </span>
              </div>
              {matched && (
                <div className="formrow" style={{ margin: 0 }}>
                  <span className="label">Takes located</span>
                  {/* `tnum--bad` when nothing matched at all: that is almost
                      always the wrong folder (the project folder rather than
                      the card dump), and it is worth looking like a problem. */}
                  <span className={matched.hit === 0 && matched.total > 0 ? 'tnum tnum--bad' : 'tnum'}>
                    {matched.hit} of {matched.total}
                  </span>
                </div>
              )}
            </div>
          )}

          {walk && (
            <button
              type="button"
              className="btn btn--ghost btn--full"
              style={{ marginTop: 10 }}
              onClick={() => void forget()}
            >
              Forget this folder
            </button>
          )}
        </>
      )}

      {pickError && (
        <span className="tnum tnum--bad" style={{ display: 'block', marginTop: 10 }}>
          {pickError}
        </span>
      )}
    </section>
  );
}

function TcCalculator(props: { project: Project }) {
  const [open, setOpen] = useState(false);
  const [a, setA] = useState('00:00:00:00');
  const [b, setB] = useState('00:00:00:00');
  const [result, setResult] = useState<{ ok: true; value: string } | { ok: false } | null>(null);

  function calc(sign: 1 | -1) {
    try {
      const fa = tc.timecodeToFrames(a, props.project.fps);
      const fb = tc.timecodeToFrames(b, props.project.fps);
      setResult({ ok: true, value: tc.framesToTimecode(Math.max(0, fa + sign * fb), props.project.fps) });
    } catch {
      setResult({ ok: false });
    }
  }

  return (
    <section className="section">
      <button type="button" className="collapse__toggle" onClick={() => setOpen(!open)} aria-expanded={open}>
        <span className="label">Timecode calculator</span>
        <span aria-hidden="true">{open ? '−' : '+'}</span>
      </button>
      {open && (
        <div className="collapse__body">
          <div className="tccalc__io">
            <input
              className="field field--mono"
              aria-label="First timecode"
              value={a}
              onChange={(e) => setA(e.target.value)}
            />
          </div>
          <div className="tccalc__io" style={{ marginTop: 10 }}>
            <input
              className="field field--mono"
              aria-label="Second timecode"
              value={b}
              onChange={(e) => setB(e.target.value)}
            />
          </div>
          <div className="tccalc__ops">
            <button type="button" className="btn btn--full" onClick={() => calc(1)}>
              Add
            </button>
            <button type="button" className="btn btn--full" onClick={() => calc(-1)}>
              Subtract
            </button>
          </div>
          {result && (
            <div className="tccalc__result">
              <span className="label">Result at {props.project.fps} fps</span>
              {result.ok ? (
                <span className="tnum">{result.value}</span>
              ) : (
                <span className="tnum tnum--bad">Check format HH:MM:SS:FF</span>
              )}
            </div>
          )}
        </div>
      )}
    </section>
  );
}

// Only Backup is free, offline, and never gated. PDF, Premiere (FCP7 XML),
// Resolve (FCPXML) and CSV are all editor/print handoffs now and all go
// through `export-gate`, which is the ONLY thing that enforces any limit - the
// client just builds the blob after it says allow. PDF joined the other three
// on 2026-08-20: it used to skip the gate entirely, which meant the one export
// a producer actually prints and hands round a unit was the only one nobody
// paid for. Resolve shares Premiere's server-side counter (same "editor
// timeline handoff" allowance, no separate counter to add); CSV and PDF each
// have their own.
//
// The app requires an account for every one of these now — the anonymous XML
// allowance that used to live server-side is gone (see net/quota.ts), so a
// signed-out caller gets a flat 401 for any format. `exportGated` short-
// circuits to the sign-in sheet locally rather than spend a round trip
// discovering that.
const EXPORT_OFFLINE_MSG =
  "You're offline. PDF, Premiere, Resolve and CSV export need a connection. Logging takes and Backup work offline.";

// Display name per gated format, for error/note copy. Keyed by GatedFormat so
// a format added to net/quota.ts without a matching entry here is a compile
// error, not a silent "undefined" in the UI.
const FORMAT_LABEL: Record<GatedFormat, string> = {
  script: 'Script Mode',
  premiere: 'Premiere/Resolve',
  pdf: 'PDF',
  csv: 'CSV',
};

/**
 * Copy for when `gateExport` says no for a reason other than quota or auth
 * (those two get their own handling at the call site). The word "offline" is
 * reserved for when the browser itself reports no connection - everything
 * else is a real answer from somewhere in the path and deserves a sentence
 * that says so.
 *
 * Takes `isOnline` as an argument instead of reading `navigator.onLine`
 * itself, purely so this stays a plain function a test can call without a
 * DOM.
 */
export function exportFailureMessage(gate: Pick<GateResult, 'reason' | 'status'>, isOnline: boolean): string {
  /* SUSPENDED IS CHECKED BEFORE THE OFFLINE GUARD, and it is the only reason
     that jumps that queue. Everything below this line describes a request that
     failed to get an answer, so "are you actually online" is the right first
     question for all of them. `suspended` is the opposite: the server answered,
     clearly, and told us the account is blocked. Telling somebody to check
     their wifi when the truth is that their account is suspended sends them
     round the houses and eventually to a support email about a bug that is not
     one. That confusion is exactly what this whole function exists to stop. */
  if (gate.reason === 'suspended') {
    return "This account has been suspended, so exports are blocked. If you think that's a mistake, reply to any Clapper email and we'll take a look.";
  }
  if (!isOnline) return EXPORT_OFFLINE_MSG;
  if (gate.reason === 'http_error') {
    return gate.status
      ? `The export server returned an error (${gate.status}). Try again in a moment.`
      : 'The export server returned an error. Try again in a moment.';
  }
  // 'unreachable' (or anything unrecognized): the request never reached the
  // function, and the browser says it has a connection, so name what
  // actually blocks that combination.
  return 'Could not reach the export server. A VPN, ad blocker or firewall can cause this. Turn it off and try again.';
}

// Display name per export kind, for the build-failure message below. A
// separate map from FORMAT_LABEL because Premiere and Resolve share one
// gated format ('premiere') but are two different files to build.
const BUILD_LABEL: Record<'pdf' | 'xml' | 'resolve' | 'csv', string> = {
  pdf: 'PDF',
  xml: 'Premiere',
  resolve: 'Resolve',
  csv: 'CSV',
};

/**
 * Copy for when the gate allowed the export but building or sharing the file
 * itself threw - a bad IndexedDB read, an exporter bug, a share sheet that
 * bailed. This is never a connection problem: the gate round trip already
 * succeeded by the time this runs.
 */
export function exportBuildFailureMessage(kind: 'pdf' | 'xml' | 'resolve' | 'csv'): string {
  return `Could not build the ${BUILD_LABEL[kind]} file.`;
}

function ExportBar(props: { project: Project }) {
  const { session } = useSession();
  const [busy, setBusy] = useState<string | null>(null);
  // PDF/Premiere/Resolve/CSV now live inside the Export sheet, so their error
  // and note read there. Backup stays a visible button on the main screen (see
  // the comment above its button below), so its own failure gets its own line
  // next to its own button rather than one hidden behind a sheet it isn't in.
  const [error, setError] = useState<string | null>(null);
  const [note, setNote] = useState<string | null>(null);
  const [backupError, setBackupError] = useState<string | null>(null);
  const [showSignIn, setShowSignIn] = useState(false);
  const [exportOpen, setExportOpen] = useState(false);
  // Which export got refused for being out of free uses — drives the "go Pro"
  // CTA. Widened to include 'pdf' now that PDF is gated too; ProCta.tsx's
  // `ProGate` union (outside this lane) doesn't have a 'pdf' case yet, so the
  // render below maps it onto 'csv' — same upsell, an analytics label one
  // bucket off until ProCta picks up 'pdf'.
  const [capped, setCapped] = useState<GatedFormat | null>(null);

  // The one export that MUST work signed out, offline, free — never gateExport,
  // never getUsage, never Supabase. It is the whole point of this button: the
  // escape hatch for the shoot that has no cloud copy at all (see backup.ts).
  async function backupProject() {
    setBusy('backup');
    setBackupError(null);
    try {
      const bundle = await store.getBundle(props.project.id);
      const base = slug(props.project.name);
      const blob = buildBackupBlob(bundle);
      await shareBlob(blob, `${base}-backup-${exportDateStamp(bundle.project)}.json`, 'application/json');
    } catch {
      setBackupError('Could not build the backup file.');
    } finally {
      setBusy(null);
    }
  }

  async function exportGated(kind: 'pdf' | 'xml' | 'resolve' | 'csv') {
    setError(null);
    setNote(null);
    setCapped(null);
    // Resolve rides the SAME gate call as Premiere ('premiere' format) — one
    // shared "editor timeline" quota bucket, not a new rule. `format` is what
    // is sent to the gate and used to look up limits; `kind` is only what we
    // show/log, so a Resolve export doesn't get logged as a Premiere one.
    const format: GatedFormat = kind === 'csv' ? 'csv' : kind === 'pdf' ? 'pdf' : 'premiere';
    // Every gated format now requires an account server-side (see comment
    // above EXPORT_OFFLINE_MSG) — there is no anonymous allowance left to let
    // the gate answer for.
    if (!session) {
      setShowSignIn(true);
      return;
    }
    const label = kind === 'xml' ? 'premiere' : kind === 'resolve' ? 'resolve' : kind;
    setBusy(kind);
    try {
      // gateExport never throws. @supabase/supabase-js's `invoke` resolves
      // with an `error` field rather than rejecting, and gateExport turns
      // every shape of that into a GateResult. So this is the only branch
      // point for "the gate said no," and it is a real answer per reason:
      // quota and auth are unchanged; everything else gets a sentence keyed
      // to what actually happened, with "offline" reserved for when the
      // browser itself says there's no connection.
      const gate = await gateExport(format);
      if (!gate.allow) {
        if (gate.reason === 'quota_exceeded') {
          track('cap_hit', { which: label });
          setError(`That's your ${FREE_LIMITS[format]} free ${FORMAT_LABEL[format]} exports for this plan.`);
          setCapped(format);
        } else if (gate.reason === 'auth') {
          // Session missing/expired. Same handling as signed-out.
          setShowSignIn(true);
        } else {
          setError(exportFailureMessage(gate, navigator.onLine));
        }
        return;
      }
      // The gate said yes, so anything that throws from here on is not a
      // connection problem. It's the build or the share sheet, and gets its
      // own message rather than being folded back into "offline."
      try {
        const bundle = await store.getBundle(props.project.id);
        const base = slug(props.project.name);
        const dateStamp = exportDateStamp(bundle.project);
        if (kind === 'pdf') {
          const blob = await exporter.toPdf(bundle);
          await shareBlob(blob, `${base}-log-${dateStamp}.pdf`, 'application/pdf');
        } else if (kind === 'xml') {
          const blob = exporter.toFcpXml(bundle);
          await shareBlob(blob, `${base}-log-${dateStamp}.xml`, 'text/xml');
        } else if (kind === 'resolve') {
          const blob = exporter.toResolveXml(bundle);
          await shareBlob(blob, `${base}-log-${dateStamp}.fcpxml`, 'text/xml');
        } else {
          // The folder walk is device-local (see store/medialink.ts), so it is
          // read here rather than carried on the bundle. Absent — nobody picked
          // a folder on this device — and the CSV is exactly what it always was,
          // with three empty trailing columns.
          const mediaIndex = await loadMediaIndex(props.project.id);
          const blob = exporter.toCsv(bundle, mediaIndex);
          await shareBlob(blob, `${base}-log-${dateStamp}.csv`, 'text/csv');
        }
        track('export', { format: label });
        // Every account is on SOME tier's counter now (free or Pro), but Pro's
        // "limit" is 1,000,000 - telling it "999997 left" would be noise
        // pretending to be information. Only show the countdown when the
        // remaining count is within the free-tier ceiling for this format, which
        // a Pro account's remaining value never is.
        if (typeof gate.remaining === 'number' && gate.remaining <= FREE_LIMITS[format]) {
          setNote(`${gate.remaining} of ${FREE_LIMITS[format]} ${FORMAT_LABEL[format]} exports left.`);
        }
      } catch (err) {
        console.error(`export (${kind}): gate allowed it but building/sharing the file failed`, err);
        setError(exportBuildFailureMessage(kind));
      }
    } finally {
      setBusy(null);
    }
  }

  return (
    <>
      {/* FOUR EQUAL BUTTONS COLLAPSE TO ONE TILE. PDF, Premiere, Resolve and
          CSV used to stand at the same weight as Backup and Wrap day, on a
          screen that already had twelve other things standing at that
          weight: a format picked maybe once a week competing for eye space
          with the button pressed six times a day. One "Export" tile opens a
          sheet naming what each of the four is actually for, which the
          four-button grid never had room to say. */}
      <button
        type="button"
        className="tile tile--export"
        disabled={busy !== null}
        onClick={() => {
          haptics.tap();
          setExportOpen(true);
        }}
      >
        <span className="tile__icon" aria-hidden="true">
          <ExportMark />
        </span>
        <span className="tile__label">Export</span>
      </button>
      {/* BACKUP DOES NOT MOVE OFF THE MAIN GRID. It is the only one of the
          five that works signed out, offline and with no limit: the escape
          hatch for a shoot with no cloud copy at all (see the comment on
          backupProject above). Burying the one thing that always works
          behind the same sheet as the four things that need a connection and
          an account would hide the escape hatch exactly when it's needed
          most. */}
      <button
        type="button"
        className="tile tile--backup"
        disabled={busy !== null}
        onClick={() => void backupProject()}
      >
        <span className="tile__icon" aria-hidden="true">
          <CloudMark />
        </span>
        <span className="tile__label">{busy === 'backup' ? '...' : 'Backup'}</span>
      </button>
      {backupError && <span className="shoottiles__extra tnum tnum--bad">{backupError}</span>}

      {exportOpen && (
        <Sheet title="Export" onClose={() => setExportOpen(false)}>
          <div className="stack">
            <button
              type="button"
              className="btn sp-example btn--full"
              disabled={busy !== null}
              onClick={() => void exportGated('pdf')}
            >
              <b>{busy === 'pdf' ? '...' : 'PDF'}</b>
              <span>Print and hand round on set.</span>
            </button>
            <button
              type="button"
              className="btn sp-example btn--full"
              disabled={busy !== null}
              onClick={() => void exportGated('xml')}
            >
              <b>{busy === 'xml' ? '...' : 'Premiere'}</b>
              <span>Timeline, XML.</span>
            </button>
            <button
              type="button"
              className="btn sp-example btn--full"
              disabled={busy !== null}
              onClick={() => void exportGated('resolve')}
            >
              <b>{busy === 'resolve' ? '...' : 'Resolve'}</b>
              <span>Timeline, FCPXML.</span>
            </button>
            <button
              type="button"
              className="btn sp-example btn--full"
              disabled={busy !== null}
              onClick={() => void exportGated('csv')}
            >
              <b>{busy === 'csv' ? '...' : 'CSV'}</b>
              <span>Spreadsheet.</span>
            </button>
          </div>
          {error && (
            <span className="tnum tnum--bad" style={{ display: 'block', marginTop: 12 }}>
              {error}
            </span>
          )}
          {/* ProCta's ProGate union has no 'pdf' case (ProCta.tsx is outside this
              lane), so map it onto 'csv' so the upsell still renders. Only the
              `pro_interest` analytics label is affected; the plans/checkout it
              opens are format-agnostic. */}
          {capped && <ProCta gate={capped === 'pdf' ? 'csv' : capped} />}
          {note && !error && (
            <span className="section__note" style={{ display: 'block', marginTop: 12 }}>
              {note}
            </span>
          )}
        </Sheet>
      )}
      {showSignIn && <SignInSheet onClose={() => setShowSignIn(false)} />}
    </>
  );
}

/**
 * Edit one scene. It was "Rename scene" and did only that; it now also carries
 * DELETE, which used to render inside every card in the list at rest. The
 * confirmation is unchanged - the caller still opens the same Confirm - so the
 * destructive path is one tap further away and no less careful.
 */
function RenameSheet(props: {
  slate: Slate;
  onClose: () => void;
  onSave: (name: string) => void;
  onDelete: () => void;
}) {
  const [name, setName] = useState(props.slate.name);
  return (
    <Sheet title="Edit scene" onClose={props.onClose}>
      <div className="formrow">
        <label className="label" htmlFor="rn-name">
          Scene name
        </label>
        <input
          id="rn-name"
          className="field"
          autoFocus
          value={name}
          onChange={(e) => setName(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter' && name.trim()) props.onSave(name.trim());
          }}
        />
      </div>
      <button
        type="button"
        className="btn btn--danger btn--full sp-danger"
        onClick={props.onDelete}
      >
        Delete scene
      </button>

      <div className="sheet__actions">
        <SheetClose className="btn btn--ghost" onClose={props.onClose}>
          Cancel
        </SheetClose>
        <button
          type="button"
          className="btn btn--go"
          disabled={!name.trim()}
          onClick={() => props.onSave(name.trim())}
        >
          Save
        </button>
      </div>
    </Sheet>
  );
}
