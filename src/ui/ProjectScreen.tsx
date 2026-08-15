import { useEffect, useRef, useState } from 'react';
import type { ChangeEvent } from 'react';
import type { CameraUnit, Project, Slate } from '../types';
import { isMultiCam } from '../types';
import { store } from '../store';
import { formatClip, moveItem, sortForDisplay, undoWrapShootDay, wrapShootDay } from '../store/util';
import { tc } from '../export/timecode';
import { exporter, shareBlob, buildBackupBlob } from '../export';
import { exportDateStamp, shortDateLabel } from '../export/order';
import { findPreset, renderUnitClip, UNIT_LETTERS } from './cameras';
import { slug } from './share';
import { Sheet, SheetClose, Confirm, Rail } from './common';
import { useScrolled } from './glist';
import { SignInSheet } from './SignInSheet';
import { ProCta } from './ProCta';
import { useSession } from '../net/auth';
import { gateExport, ANON_LIMIT_XML } from '../net/quota';
import { track } from '../net/analytics';
import * as haptics from './haptics';
import { extractPdfText } from './pdftext';
import { breakdownCallSheet, SignInRequiredError } from './breakdown';

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

export function ProjectScreen(props: {
  project: Project;
  onBack: () => void;
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
  const { session: csSession, loading: csSessionLoading } = useSession();
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

  // The nav bar is sticky material; the hairline under it arrives only once
  // there is a list behind it to separate from.
  const scrolled = useScrolled();

  return (
    <div className="app">
      <div className="topbar" data-scrolled={scrolled ? '' : undefined}>
        <button type="button" className="iconbtn" aria-label="Back to projects" onClick={props.onBack}>
          &lsaquo;
        </button>
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
      </div>

      <Rail thin />

      {/* Sync only runs signed in (see net/sync.ts's flush()), so a signed-out
          shoot has no copy anywhere but this phone. Persistent, not a toast —
          this is true for the entire time it's true, not for 1400ms after a
          tap. The action is the Backup button down by the export bar. */}
      {!csSessionLoading && !csSession && (
        <p className="camnote" style={{ textAlign: 'center', margin: '14px 0 0' }}>
          Signed out — this project exists only on this phone. If you lose the phone, you lose the
          shoot. Back it up below.
        </p>
      )}

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
          <div className="empty">
            <b>No scenes yet</b>
            Add a scene for your first setup, then tap it to start rolling.
          </div>
        ) : (
          <>
            {!hintSeen && (
              <div className="rollhint">
                Tap a scene to start rolling
                <span className="rollhint__arrow" aria-hidden="true">
                  ↓
                </span>
              </div>
            )}
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
                  <div className="scenehandle">
                    <button
                      type="button"
                      className="scenehandle__step"
                      aria-label={`Move ${slate.name} up`}
                      disabled={i === 0}
                      onClick={() => void commitReorder(i, i - 1)}
                    >
                      ▲
                    </button>
                    <button
                      type="button"
                      className="scenehandle__grip"
                      aria-label={`Reorder ${slate.name}. Position ${displayPos} of ${slates.length} in shooting order. Drag, or use the up and down buttons, to move it.`}
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
                    <button
                      type="button"
                      className="scenehandle__step"
                      aria-label={`Move ${slate.name} down`}
                      disabled={i === slates.length - 1}
                      onClick={() => void commitReorder(i, i + 1)}
                    >
                      ▼
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
                        ›
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
                      <span
                        className="iconbtn"
                        role="button"
                        tabIndex={0}
                        aria-label={`Rename scene ${slate.name}`}
                        style={{ marginLeft: 'auto', minHeight: 32, minWidth: 32 }}
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
                        edit
                      </span>
                      <span
                        className="rowdel"
                        role="button"
                        tabIndex={0}
                        aria-label={`Delete scene ${slate.name}`}
                        onClick={(e) => {
                          e.stopPropagation();
                          setDeleting(slate);
                        }}
                        onKeyDown={(e) => {
                          if (e.key === 'Enter' || e.key === ' ') {
                            e.preventDefault();
                            e.stopPropagation();
                            setDeleting(slate);
                          }
                        }}
                      >
                        Delete
                      </span>
                    </div>
                  </button>
                </div>
              );
            })}
            </div>
          </>
        )}

        {slates && slates.length >= 2 && (
          <div style={{ marginTop: 12 }}>
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

        <div className="addline">
          <input
            className="field"
            value={addName}
            placeholder="New scene e.g. 14A"
            onChange={(e) => setAddName(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter') void addSlate();
            }}
          />
          <button type="button" className="btn btn--go" onClick={() => void addSlate()}>
            Add
          </button>
        </div>
      </section>

      {csShowSignIn && <SignInSheet onClose={() => setCsShowSignIn(false)} />}

      <ShootDaySection
        project={project}
        dayTakeCount={dayTakeCount}
        onCommit={commitProject}
        onWrapped={() => setDayTakeCount(0)}
        onUndone={(openDay) => void refreshDayCount(openDay)}
      />

      {/* WRAP DAY, then check the clips, then hand off: the three things you do
          at the end of a shoot day now sit together, in that order, one short
          scroll from the top. They used to be split by four setup sections
          with the handoff dead last, which was survivable while it was the
          bottom of the page and stopped being so once the tab tray moved in
          permanently underneath it. Clip log keeps its old place directly
          above the handoff, because that is when it gets used: the last thing
          you do before sending the day to the editor is check that every clip
          is filed under the setup it was actually shot on. */}
      <section className="section">
        <div className="section__head">
          <span className="label">Clip log</span>
        </div>
        <button type="button" className="btn btn--full" onClick={props.onOpenClipLog}>
          Every clip rolled
        </button>
      </section>

      <ExportBar project={project} />

      {/* Setup and correction below the fold: touched once at the top of the
          day, or when a number goes wrong, not at wrap. */}
      <ClipCounterSection project={project} onCommit={commitProject} />

      <SoundSection project={project} onCommit={commitProject} />

      <TcCalculator project={project} />

      <div style={{ marginTop: 22 }}>
        <Rail thin />
      </div>

      {renaming && (
        <RenameSheet
          slate={renaming}
          onClose={() => setRenaming(null)}
          onSave={async (name) => {
            await store.updateSlate(renaming.id, { name });
            setRenaming(null);
            void refresh();
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
}) {
  const { project } = props;
  const day = project.openShootDay;
  const [confirming, setConfirming] = useState(false);
  const [wrapped, setWrapped] = useState(false);
  const [undoError, setUndoError] = useState<string | null>(null);

  async function doWrap() {
    const { project: next } = wrapShootDay(project, Date.now());
    await props.onCommit(next);
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
        <span className="tnum">
          {props.dayTakeCount} {takeWord}
        </span>
      </div>
      <button type="button" className="btn btn--full" onClick={() => setConfirming(true)}>
        {wrapped ? 'Wrapped' : 'Wrap day'}
      </button>
      {canUndo && (
        <button
          type="button"
          className="btn btn--full btn--ghost"
          style={{ marginTop: 8 }}
          onClick={() => void doUndo()}
        >
          Undo wrap
        </button>
      )}
      {undoError && (
        <span className="tnum tnum--bad" style={{ display: 'block', marginTop: 8 }}>
          {undoError}
        </span>
      )}
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

const clampNum = (s: string) => Math.max(0, parseInt(s, 10) || 0);
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
      <div className="section__head">
        <span className="label">Camera clip counter</span>
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
        <div className="stack">
          {units.slice(0, camCount).map((u, i) => (
            <div key={UNIT_LETTERS[i]} className="camunit">
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
          ))}
          <button type="button" className="btn btn--full" onClick={() => void save()}>
            {saved ? 'Saved' : 'Set clip counters'}
          </button>
        </div>
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

// PDF and Backup are free, offline, and never gated. Premiere (FCP7 XML),
// Resolve (FCPXML) and CSV are the editor handoff and go through `export-gate`,
// which is the ONLY thing that enforces any limit - the client just builds the
// blob after it says allow. Resolve shares Premiere's server-side counter (same
// "editor timeline handoff" allowance, no separate counter to add); CSV has its
// own. Signed IN is currently uncapped. Signed OUT still gets the XML handoff,
// on a small allowance the server counts against the caller's IP - so a
// signed-out tap must reach the gate rather than being short-circuited into the
// sign-in sheet here. CSV alone still requires an account.
const EXPORT_OFFLINE_MSG =
  "You're offline. Premiere, Resolve and CSV export need a connection. Logging takes, PDF and Backup work offline.";

function ExportBar(props: { project: Project }) {
  const { session } = useSession();
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [note, setNote] = useState<string | null>(null);
  const [showSignIn, setShowSignIn] = useState(false);
  // Which export got refused for being out of free uses — drives the "go Pro" CTA.
  const [capped, setCapped] = useState<'premiere' | 'csv' | null>(null);

  async function exportPdf() {
    setBusy('pdf');
    try {
      const bundle = await store.getBundle(props.project.id);
      const base = slug(props.project.name);
      const blob = await exporter.toPdf(bundle);
      await shareBlob(blob, `${base}-log-${exportDateStamp(bundle.project)}.pdf`, 'application/pdf');
    } finally {
      setBusy(null);
    }
  }

  // The one export that MUST work signed out, offline, free — never gateExport,
  // never getUsage, never Supabase. It is the whole point of this button: the
  // escape hatch for the shoot that has no cloud copy at all (see backup.ts).
  async function backupProject() {
    setBusy('backup');
    setError(null);
    setNote(null);
    try {
      const bundle = await store.getBundle(props.project.id);
      const base = slug(props.project.name);
      const blob = buildBackupBlob(bundle);
      await shareBlob(blob, `${base}-backup-${exportDateStamp(bundle.project)}.json`, 'application/json');
    } catch {
      setError('Could not build the backup file.');
    } finally {
      setBusy(null);
    }
  }

  async function exportGated(kind: 'xml' | 'resolve' | 'csv') {
    setError(null);
    setNote(null);
    setCapped(null);
    // Resolve rides the SAME gate call as Premiere ('premiere' format) — one
    // shared "editor timeline" quota bucket, not a new rule. `label` is only
    // for what we show/log, so a Resolve export doesn't get logged as one.
    const format = kind === 'csv' ? 'csv' : 'premiere';
    // Signed out, the XML handoff is offered anyway on a small allowance the
    // server counts against the caller's IP — so DON'T shortcut to the sign-in
    // sheet here; let the gate answer, exactly as it does for an account. CSV
    // still needs one, and asking for it signed-out is refused server-side, so
    // there is no reason to spend a round trip discovering that.
    if (!session && format === 'csv') {
      setShowSignIn(true);
      return;
    }
    const label = kind === 'xml' ? 'premiere' : kind === 'resolve' ? 'resolve' : 'csv';
    setBusy(kind);
    try {
      const gate = await gateExport(format);
      if (!gate.allow) {
        if (gate.reason === 'quota_exceeded') {
          track('cap_hit', { which: label, anon: !session });
          if (!session) {
            // The wall a signed-out user hits has a door in it, so say where it
            // is. Offering the pro CTA here instead would be selling something
            // to someone who has not yet done the free thing.
            setError(`That's ${ANON_LIMIT_XML} XML exports on this connection. Sign in and they're unlimited.`);
            setShowSignIn(true);
          } else {
            setError('Free limit reached. More coming soon.');
            setCapped(format);
          }
        } else if (gate.reason === 'auth') {
          // Session missing/expired — same handling as signed-out.
          setShowSignIn(true);
        } else {
          setError(EXPORT_OFFLINE_MSG);
        }
        return;
      }
      const bundle = await store.getBundle(props.project.id);
      const base = slug(props.project.name);
      const dateStamp = exportDateStamp(bundle.project);
      if (kind === 'xml') {
        const blob = exporter.toFcpXml(bundle);
        await shareBlob(blob, `${base}-log-${dateStamp}.xml`, 'text/xml');
      } else if (kind === 'resolve') {
        const blob = exporter.toResolveXml(bundle);
        await shareBlob(blob, `${base}-log-${dateStamp}.fcpxml`, 'text/xml');
      } else {
        const blob = exporter.toCsv(bundle);
        await shareBlob(blob, `${base}-log-${dateStamp}.csv`, 'text/csv');
      }
      track('export', { format: label });
      // Only a signed-OUT caller has a ceiling to count down to; an account is
      // uncapped, and telling it "999997 left" would be noise pretending to be
      // information.
      if (!session && typeof gate.remaining === 'number') {
        // Premiere and Resolve share ONE counter with its own smaller allowance,
        // so the ceiling shown has to follow the counter that was actually
        // consumed, not a single global number - quoting "of 5" against a
        // budget of 3 would count down to a wall the user was never shown.
        setNote(`${gate.remaining} of ${ANON_LIMIT_XML} XML exports left. Sign in for unlimited.`);
      }
    } catch {
      setError(EXPORT_OFFLINE_MSG);
    } finally {
      setBusy(null);
    }
  }

  return (
    <section className="section">
      <div className="section__head">
        <span className="label">Hand off to editor</span>
      </div>
      {/* TWO columns, and `minmax(0, 1fr)` not `1fr`. Four across overflowed the
          phone: a bare `1fr` track floors at the button's MIN-CONTENT width, so
          "Premiere" and "Resolve" refused to shrink and pushed CSV clean off the
          right edge (measured: 396px of content in a 390px viewport, and the
          whole page scrolled sideways to reach a button that should have been
          under your thumb). Two columns also buys every target real width,
          which is what this row wants on a set anyway. */}
      <div className="formgrid" style={{ gridTemplateColumns: 'repeat(2, minmax(0, 1fr))' }}>
        <button type="button" className="btn" disabled={busy !== null} onClick={() => void exportPdf()}>
          {busy === 'pdf' ? '...' : 'PDF'}
        </button>
        <button type="button" className="btn" disabled={busy !== null} onClick={() => void exportGated('xml')}>
          {busy === 'xml' ? '...' : 'Premiere'}
        </button>
        <button type="button" className="btn" disabled={busy !== null} onClick={() => void exportGated('resolve')}>
          {busy === 'resolve' ? '...' : 'Resolve'}
        </button>
        <button type="button" className="btn" disabled={busy !== null} onClick={() => void exportGated('csv')}>
          {busy === 'csv' ? '...' : 'CSV'}
        </button>
      </div>
      <button
        type="button"
        className="btn btn--full"
        style={{ marginTop: 10 }}
        disabled={busy !== null}
        onClick={() => void backupProject()}
      >
        {busy === 'backup' ? '...' : 'Backup'}
      </button>
      {error && (
        <span className="tnum tnum--bad" style={{ display: 'block', marginTop: 10 }}>
          {error}
        </span>
      )}
      {capped && <ProCta gate={capped} />}
      {note && !error && (
        <span className="section__note" style={{ display: 'block', marginTop: 10 }}>
          {note}
        </span>
      )}
      {showSignIn && <SignInSheet onClose={() => setShowSignIn(false)} />}
    </section>
  );
}

function RenameSheet(props: { slate: Slate; onClose: () => void; onSave: (name: string) => void }) {
  const [name, setName] = useState(props.slate.name);
  return (
    <Sheet title="Rename scene" onClose={props.onClose}>
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
