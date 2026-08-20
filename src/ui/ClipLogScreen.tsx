// The clip log — every clip this project has rolled, newest first, and the one
// place to repair a take that was filed against the wrong setup or carries a
// wrong clip number, whether it was logged a minute ago or three scenes back.
//
// This exists because of a specific on-set failure: the operator forgets to
// advance the shot, rolls three takes against 5.30 while the camera is actually
// on 5.31, and the editor gets clips sitting under a setup that was never shot.
// Nobody notices until the assembly. So the log is deliberately flat and
// chronological — the same order the cards were written in — rather than
// grouped by scene like every other screen: you find the clip by the name on
// the card, not by remembering which setup it was supposed to be.
//
// It reads, re-files, corrects a clip/sound number or status/tags/note (via
// TakeEditSheet, the same sheet the rolling screen opens, just reachable here
// against any take, not only the last few of the setup currently open),
// discards a no-good take, and deletes one that was logged when nobody
// actually rolled. The rolling screen only ever reaches the last few takes of
// the setup it has open; this screen is what lets a take from this morning, or
// two setups ago, get the same correction without hunting for it first.
//
// ---------------------------------------------------------------------------
// THE REPAINT (round 1, screen 3) — THIS IS THE RECOVERY SCREEN, so it is
// designed as one. Three things changed, and each fixes something real:
//
//   ONE ROW OPENS, AND ONLY THEN CAN IT BE DESTROYED. Move and Delete used to
//   sit permanently beside the row's own tap target — the same mis-tap
//   architecture the rolling screen's `minitakes` still has, where the delete
//   glyph is adjacent to the edit target in the thumb zone. The row is now a
//   disclosure: tap it and it becomes a card carrying its three actions, with
//   the destructive one on its own line, in its own colour, behind two taps
//   and a confirmation instead of one twitch. (The `minitakes` row itself
//   lives in RollingScreen, which is another lane's file this round.)
//
//   A GOLD TAKE GETS ITS NUMBER CIRCLED. That is the literal slate practice: a
//   loader circles the take number on the sheet for the one the director
//   wants, and an editor reading the sheet finds it without reading anything
//   else. Clapper has no "circled take" field and one is not being invented —
//   this is the app's OWN existing GOLD tag, drawn the way a slate draws it.
//   GOLD is stored as a tagged MOMENT on the take (see TakeEditSheet), not as
//   a field, so the bundle's moments are what this screen reads.
//
//   SCENE RUN-HEADERS, WITHOUT REORDERING ANYTHING. A header appears wherever
//   the scene CHANGES going down the list. The order is still strictly
//   chronological — the same reason as ever — so a scene you came back to
//   after lunch legitimately gets a second header, because that is what
//   actually happened.

import { useEffect, useMemo, useState } from 'react';
import type { Moment, Project, Shot, Slate, Take } from '../types';
import { store } from '../store';
import { nextTakeNumber } from '../store/util';
import { tc } from '../export/timecode';
import {
  Sheet,
  SheetClose,
  Rail,
  Toast,
  Confirm,
  SyncPill,
  HeldWriteRow,
  useHeldWrites,
  reportHeldWrite,
  clearHeldWrite,
} from './common';
import { useScrolled } from './glist';
import { BackButton, SpeakerMark, EditMark } from './marks';
import { TakeEditSheet } from './TakeEditSheet';
import * as haptics from './haptics';

/** Every clip name on a take: "A C0184 · B B0091" multi-cam, "C0184" single. */
function takeClipLabel(t: Take): string {
  return t.clips && t.clips.length ? t.clips.map((c) => `${c.unit} ${c.clipName}`).join(' · ') : t.clipName;
}

function pad2(n: number): string {
  return String(n).padStart(2, '0');
}

/** Local wall clock the take started at, "14:32:07" — what the log sheet says. */
function wallClock(epochMs: number): string {
  const d = new Date(epochMs);
  return `${pad2(d.getHours())}:${pad2(d.getMinutes())}:${pad2(d.getSeconds())}`;
}

/** The scene's shot with this id, if the breakdown still carries it. */
function findShot(slate: Slate, shotId: string): Shot | undefined {
  return (slate.shots ?? []).find((s) => s.id === shotId);
}

/**
 * One row: the take plus where it currently sits. `shot` is ABSENT when the
 * take carries no `shotId` (a legacy take, or one rolled against a bare scene)
 * AND when its `shotId` no longer resolves to a shot in the breakdown. Neither
 * case invents a setup — the row simply shows the scene, which is the only
 * thing we actually know.
 */
interface ClipRow {
  take: Take;
  slate: Slate;
  shot?: Shot;
  /** The take carries a GOLD tag, so its number is circled. */
  gold: boolean;
}

export function ClipLogScreen(props: {
  project: Project;
  /** The name of the screen BACK lands on. The router knows it; this does not. */
  backLabel: string;
  onBack: () => void;
}) {
  // Local copy, not `props.project` read fresh each render: a clip-number
  // correction (TakeEditSheet's rebase) writes a new project row with shifted
  // counters, and the NEXT sheet opened from this screen must see it, same as
  // RollingScreen keeping its own `project` state for the same reason.
  const [project, setProject] = useState<Project>(props.project);
  const [slates, setSlates] = useState<Slate[] | null>(null);
  const [takes, setTakes] = useState<Take[] | null>(null);
  const [moments, setMoments] = useState<Moment[]>([]);
  const [query, setQuery] = useState('');
  const [openId, setOpenId] = useState<string | null>(null);
  const [moving, setMoving] = useState<ClipRow | null>(null);
  const [editing, setEditing] = useState<ClipRow | null>(null);
  const [deleting, setDeleting] = useState<ClipRow | null>(null);
  const [toast, setToast] = useState<string | null>(null);
  const held = useHeldWrites();

  async function refresh() {
    // ONE READ, not four. `getBundle` is the exporters' own path: it returns
    // the project, its scenes in order, every take, AND every moment - and the
    // moments are the only place a GOLD tag lives, so the alternative was this
    // read plus one listMoments per take. The project comes back with it,
    // which matters for the same reason it always did: a delete hands a clip
    // number back and moves that camera's live counter (reclaimClipNumbers),
    // and the next sheet opened from this screen is handed this copy.
    try {
      const bundle = await store.getBundle(project.id);
      setProject(bundle.project);
      setSlates(bundle.slates);
      // Newest first. `startedAt` is when the camera rolled, which is the order
      // the day actually happened in; id breaks the tie so two takes stamped in
      // the same millisecond never swap places between renders.
      setTakes(
        [...bundle.takes].sort(
          (a, b) => b.startedAt - a.startedAt || (a.id < b.id ? 1 : a.id > b.id ? -1 : 0),
        ),
      );
      setMoments(bundle.moments);
    } catch (err) {
      // The project was deleted out from under this screen, or storage is
      // unavailable. An empty log is the honest render of both.
      console.error('Clapper: could not read the clip log', err);
      setSlates([]);
      setTakes([]);
      setMoments([]);
    }
  }

  useEffect(() => {
    void refresh();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [project.id]);

  const slateById = useMemo(() => new Map((slates ?? []).map((s) => [s.id, s])), [slates]);

  /** Take ids carrying a GOLD moment. Built once per read, not per row. */
  const goldTakeIds = useMemo(() => {
    const set = new Set<string>();
    for (const m of moments) if (m.tag === 'GOLD') set.add(m.takeId);
    return set;
  }, [moments]);

  const rows: ClipRow[] | null = useMemo(() => {
    if (!takes || !slates) return null;
    const built: ClipRow[] = [];
    for (const take of takes) {
      const slate = slateById.get(take.slateId);
      if (!slate) continue; // orphan row: the scene is gone, so is the take's place in this log
      // Resolved against the take's OWN scene, never a project-wide shot index:
      // a shot only exists inside its slate, so a `shotId` that doesn't match
      // anything there means the breakdown changed under this take. Then we
      // show the scene alone rather than borrowing a code from another scene.
      const shot = take.shotId !== undefined ? findShot(slate, take.shotId) : undefined;
      built.push({ take, slate, gold: goldTakeIds.has(take.id), ...(shot ? { shot } : {}) });
    }
    return built;
  }, [takes, slates, slateById, goldTakeIds]);

  // Search is one field over everything on the row you might remember: the clip
  // name(s) first (that is the point of the screen), then the sound file, the
  // scene and the shot code — a phone keyboard is expensive, so one box.
  const filtered = useMemo(() => {
    if (!rows) return null;
    const q = query.trim().toLowerCase();
    if (!q) return rows;
    return rows.filter((r) =>
      [takeClipLabel(r.take), r.take.sound?.fileName ?? '', r.slate.name, r.shot?.code ?? '']
        .join(' ')
        .toLowerCase()
        .includes(q),
    );
  }, [rows, query]);

  /** What the two cards at the top say. Every number here is counted off the
   *  rows on screen - nothing is a field this app does not have. */
  const tally = useMemo(() => {
    if (!rows) return null;
    const kept = rows.filter((r) => r.take.status !== 'discarded');
    return {
      clips: rows.length,
      discarded: rows.length - kept.length,
      inTheCan: kept.reduce((ms, r) => ms + r.take.durationMs, 0),
      scenes: new Set(kept.map((r) => r.slate.id)).size,
      gold: rows.filter((r) => r.gold).length,
    };
  }, [rows]);

  async function move(row: ClipRow, destination: { slateId: string; shotId?: string }) {
    haptics.tap();
    try {
      const moved = await store.reassignTake(row.take.id, destination);
      const destSlate = slateById.get(destination.slateId);
      const destShot =
        destSlate && destination.shotId !== undefined ? findShot(destSlate, destination.shotId) : undefined;
      setMoving(null);
      clearHeldWrite(`move:${row.take.id}`);
      await refresh();
      setToast(`Moved to ${destShot?.code ?? destSlate?.name ?? 'scene'} take ${moved.number}`);
    } catch (err) {
      // A rejected reassignTake must not leave the sheet open on a dead Move
      // button, so close it and say so. It gets a HELD WRITE rather than a
      // toast because a toast is gone in 1.4 seconds and this is a write that
      // did not land - it has to stay on screen until someone deals with it.
      // The copy is this call site's own: nothing moved, so nothing is at
      // risk, and saying "nothing lost yet" here would be borrowed drama.
      console.error('Clapper: failed to move take', err);
      setMoving(null);
      reportHeldWrite({
        id: `move:${row.take.id}`,
        title: `Take ${row.take.number} did not move`,
        detail: `${takeClipLabel(row.take)} is still filed under ${row.shot?.code ?? row.slate.name}`,
        onRetry: () => {
          clearHeldWrite(`move:${row.take.id}`);
          setMoving(row);
        },
      });
    }
  }

  /** DELETE means the camera never wrote this file, so it hands the clip
   * number back and slides every later take on that camera (and sound, if it
   * recorded) down one, see reclaimClipNumbers in store/util.ts. A take that
   * WAS actually shot belongs on "No good" in the edit sheet instead, which
   * keeps its number. */
  async function removeTake(row: ClipRow) {
    haptics.tap();
    try {
      await store.deleteTake(row.take.id);
      setDeleting(null);
      setOpenId(null);
      clearHeldWrite(`delete:${row.take.id}`);
      await refresh();
      setToast('Take deleted');
    } catch (err) {
      console.error('Clapper: failed to delete take', err);
      setDeleting(null);
      reportHeldWrite({
        id: `delete:${row.take.id}`,
        title: `Take ${row.take.number} did not delete`,
        detail: `${takeClipLabel(row.take)} is exactly where it was, and so is every number after it`,
        onRetry: () => {
          clearHeldWrite(`delete:${row.take.id}`);
          setDeleting(row);
        },
      });
    }
  }

  // The nav bar is sticky material; the hairline under it arrives only once
  // there is a list behind it to separate from.
  const scrolled = useScrolled();

  return (
    <div className="app mscreen mclip">
      <div className="topbar" data-scrolled={scrolled ? '' : undefined}>
        <BackButton label={props.backLabel} onClick={props.onBack} />
        <div style={{ flex: 1, minWidth: 0 }}>
          <h1 className="topbar__title">Clip log</h1>
          <div className="topbar__sub">
            {project.name}
            {rows && (
              <>
                {' '}
                <span aria-hidden="true">&middot;</span> {rows.length}{' '}
                {rows.length === 1 ? 'take' : 'takes'}
              </>
            )}
          </div>
        </div>
      </div>

      <Rail thin />

      <section className="section">
        {/* The write's status belongs on the screen you come to when you think
            something has gone wrong. Its own line, right-aligned, at hairline
            volume - never inside the nav bar, where at 390px it competes with
            the project name for the same twelve characters. */}
        <div className="mstatusline">
          <SyncPill />
        </div>

        <input
          className="field field--mono mclip__find"
          type="search"
          aria-label="Find a clip"
          placeholder="Find a clip · number or scene"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
        />

        {/* A held write sits ABOVE the log, not inside it: the writes that fail
            here are a move and a delete, and in both cases the take still has
            its own row further down. It stays until it is dealt with. */}
        {held.map((w) => (
          <HeldWriteRow key={w.id} write={w} />
        ))}

        {tally && rows && rows.length > 0 && query.trim() === '' && (
          <div className="mtally">
            <div className="mtally__card">
              <span className="mtally__cap">In the log</span>
              <span className="mtally__n tnum">{tally.clips}</span>
              <span className="mtally__sub">
                {tally.discarded > 0 ? `${tally.discarded} discarded` : 'none discarded'}
                {tally.gold > 0 ? ` · ${tally.gold} circled` : ''}
              </span>
            </div>
            <div className="mtally__card">
              <span className="mtally__cap">In the can</span>
              <span className="mtally__n tnum">{tc.msToClock(tally.inTheCan)}</span>
              <span className="mtally__sub">
                across {tally.scenes} {tally.scenes === 1 ? 'scene' : 'scenes'}
              </span>
            </div>
          </div>
        )}

        {filtered && query.trim() !== '' && (
          <div className="section__head">
            <span className="label">Every clip rolled</span>
            <span className="section__note">{filtered.length} matching</span>
          </div>
        )}

        {filtered === null ? (
          <div className="empty">Loading clips</div>
        ) : filtered.length === 0 ? (
          <div className="empty">
            <b>{query.trim() ? 'No clip matches that' : 'No clips yet'}</b>
            {query.trim()
              ? 'Try the number on its own, or the scene name.'
              : 'Every clip you roll lands here.'}
          </div>
        ) : (
          <div className="mclip__list">
            {filtered.map((row, i) => {
              const { take, slate, shot, gold } = row;
              const open = openId === take.id;
              // The run header breaks wherever the scene changes going DOWN
              // the list. Chronological order is untouched, so the same scene
              // can head two runs, which is what actually happened.
              const heads = i === 0 || filtered[i - 1].slate.id !== slate.id;
              const clip = takeClipLabel(take);
              return (
                <div key={take.id}>
                  {heads && <h2 className="mclip__head">{slate.name}</h2>}
                  <div
                    className={`mclip__row${take.status === 'discarded' ? ' mclip__row--discarded' : ''}`}
                    data-open={open ? '' : undefined}
                  >
                    <button
                      type="button"
                      className="mclip__face"
                      aria-expanded={open}
                      aria-label={`${clip}${take.sound ? `, sound ${take.sound.fileName}` : ''}, ${
                        slate.name
                      }${shot ? `, shot ${shot.code}` : ''}, take ${take.number}${
                        gold ? ', gold' : ''
                      }${take.status === 'discarded' ? ', discarded' : ''}. ${
                        open ? 'Hide' : 'Show'
                      } fix, move and delete.`}
                      onClick={() => {
                        haptics.tap();
                        setOpenId(open ? null : take.id);
                      }}
                    >
                      {/* The circled take. Brass, and only ever brass - the
                          signal list is rolling / GOLD / discarded / sound,
                          and this is the GOLD one. */}
                      <span className={`mclip__num tnum${gold ? ' mclip__num--gold' : ''}`}>
                        {take.number}
                        {gold && <span className="visually-hidden"> gold</span>}
                      </span>
                      <span className="mclip__body">
                        <span className="mclip__clip">{clip}</span>
                        <span className="mclip__meta">
                          {take.sound && (
                            <span className="mclip__snd">
                              <SpeakerMark /> {take.sound.fileName}
                            </span>
                          )}
                          {shot && <span className="mclip__shot">{shot.code}</span>}
                          <span className="mclip__take">take {take.number}</span>
                          {take.status === 'discarded' && (
                            <span className="mclip__flag">discarded</span>
                          )}
                        </span>
                      </span>
                      <span className="mclip__times">
                        <span className="tnum">{tc.msToClock(take.durationMs)}</span>
                        <span className="tnum mclip__clock">{wallClock(take.startedAt)}</span>
                      </span>
                    </button>

                    {/* DISCLOSED, NEVER ADJACENT. Nothing here can be reached
                        without opening the row first, which is the whole fix:
                        the destructive action is no longer one twitch away
                        from the thing you were aiming at. */}
                    {open && (
                      <div className="mclip__tools">
                        <button
                          type="button"
                          className="mclip__tool mclip__tool--fix"
                          onClick={() => {
                            haptics.tap();
                            setEditing(row);
                          }}
                        >
                          <EditMark />
                          Fix clip, status or tags
                        </button>
                        <div className="mclip__tools2">
                          <button
                            type="button"
                            className="mclip__tool"
                            aria-label={`Move ${clip} to another scene or shot`}
                            onClick={() => {
                              haptics.tap();
                              setMoving(row);
                            }}
                          >
                            Move to shot
                          </button>
                          <button
                            type="button"
                            className="mclip__tool mclip__tool--danger"
                            aria-label={`Delete take ${take.number} (${clip}), which renumbers later clips`}
                            onClick={() => {
                              haptics.tap();
                              setDeleting(row);
                            }}
                          >
                            Delete · renumbers
                          </button>
                        </div>
                      </div>
                    )}
                  </div>
                </div>
              );
            })}
          </div>
        )}
      </section>

      {/* The second stripe that used to close this screen is gone. Used on
          every surface and twice on some, the clapper stripe is texture; spent
          once, under the nav bar, it is the signature. */}

      {moving && (
        <MoveSheet
          row={moving}
          slates={slates ?? []}
          allTakes={takes ?? []}
          onClose={() => setMoving(null)}
          onMove={(destination) => void move(moving, destination)}
        />
      )}

      {editing && (
        <TakeEditSheet
          project={project}
          slate={editing.slate}
          take={editing.take}
          onClose={() => setEditing(null)}
          onSaved={async (updatedProject, shifted) => {
            setEditing(null);
            // The rebase may have shifted a camera's live counter, so take the
            // project back from the store rather than keeping the stale copy -
            // exactly what RollingScreen does with the same callback.
            setProject(updatedProject);
            if (shifted > 0) {
              setToast(`Clip fixed - ${shifted} later take${shifted === 1 ? '' : 's'} moved too`);
            }
            await refresh();
          }}
        />
      )}

      {deleting && (
        <Confirm
          title={`Delete take ${deleting.take.number}?`}
          message={`Only if the camera never rolled. This removes ${takeClipLabel(deleting.take)}${
            deleting.take.sound ? ` and sound ${deleting.take.sound.fileName}` : ''
          } and every moment tagged in it, hands the clip number back, and slides every later take on that camera${
            deleting.take.sound ? ' (and every later sound file)' : ''
          } down one. If the camera DID roll and the take was simply no good, discard it instead so it keeps its number. Cannot be undone.`}
          confirmLabel="Delete take"
          onCancel={() => setDeleting(null)}
          onConfirm={() => void removeTake(deleting)}
        />
      )}

      {toast && <Toast message={toast} onDone={() => setToast(null)} />}
    </div>
  );
}

/**
 * Re-file one take. Scene first, then shot if the chosen scene has a breakdown.
 *
 * The sheet states the consequence in full before you commit — "C0184 moves
 * from 5.30 take 2 to 5.31 take 1" — because the take NUMBER changes and the
 * clip name does not, and those two facts are exactly what someone reading a
 * camera report later needs to have been told.
 */
function MoveSheet(props: {
  row: ClipRow;
  slates: Slate[];
  allTakes: Take[];
  onClose: () => void;
  onMove: (destination: { slateId: string; shotId?: string }) => void;
}) {
  const { row, slates, allTakes } = props;
  const [slateId, setSlateId] = useState(row.slate.id);
  // '' is the real "file against the scene itself" choice, not a placeholder —
  // it is what a scene with no breakdown gets, and what a take can legitimately
  // be moved back to.
  const [shotId, setShotId] = useState(row.take.shotId ?? '');

  const destSlate = slates.find((s) => s.id === slateId) ?? row.slate;
  const destShots = [...(destSlate.shots ?? [])].sort((a, b) => a.order - b.order);
  const destShot = destShots.find((s) => s.id === shotId);
  const destination = { slateId, ...(destShot ? { shotId: destShot.id } : {}) };

  const unchanged = destination.slateId === row.take.slateId && destination.shotId === row.take.shotId;

  // The number the take will land on, computed the same way the store will
  // compute it inside its transaction (nextTakeNumber over the destination's
  // siblings, the take itself excluded). Shown, not stored — the store recomputes.
  const destSiblings = allTakes.filter((t) =>
    destination.shotId !== undefined
      ? t.shotId === destination.shotId
      : t.slateId === destination.slateId && t.shotId === undefined,
  );
  const destNumber = unchanged ? row.take.number : nextTakeNumber(destSiblings.filter((t) => t.id !== row.take.id));

  const fromLabel = row.shot?.code ?? row.slate.name;
  const toLabel = destShot?.code ?? destSlate.name;

  function onPickSlate(id: string) {
    setSlateId(id);
    // Landing on a scene with a breakdown, default to its first setup rather
    // than dropping the take out of the shot layer by accident; a scene with no
    // shots has nothing to pick, so it falls back to scene level on its own.
    const next = slates.find((s) => s.id === id);
    const first = [...(next?.shots ?? [])].sort((a, b) => a.order - b.order)[0];
    setShotId(first?.id ?? '');
  }

  return (
    <Sheet
      title="Move this clip"
      lede="The clip name never changes. Only which scene and shot it is filed under."
      onClose={props.onClose}
    >
      <div className="movepreview">
        <span className="movepreview__clip">{takeClipLabel(row.take)}</span>
        {row.take.sound && (
          <span className="movepreview__snd">
            <SpeakerMark /> {row.take.sound.fileName}
          </span>
        )}
      </div>

      <div className="formrow">
        <label className="label" htmlFor="mv-scene">
          Scene
        </label>
        <select
          id="mv-scene"
          className="field"
          value={slateId}
          onChange={(e) => onPickSlate(e.target.value)}
        >
          {slates.map((s) => (
            <option key={s.id} value={s.id}>
              {s.name}
            </option>
          ))}
        </select>
      </div>

      {/* Only a scene with a breakdown gets a shot picker. A hand-made scene
          has nothing to choose, and showing an empty select would imply the
          take is missing something it is not. */}
      {destShots.length > 0 && (
        <div className="formrow">
          <label className="label" htmlFor="mv-shot">
            Shot
          </label>
          <select
            id="mv-shot"
            className="field"
            value={shotId}
            onChange={(e) => setShotId(e.target.value)}
          >
            <option value="">Scene only, no shot</option>
            {destShots.map((s) => (
              <option key={s.id} value={s.id}>
                {s.code}
                {s.size ? ` · ${s.size}` : ''}
                {s.move ? ` · ${s.move}` : ''}
              </option>
            ))}
          </select>
        </div>
      )}

      <p className="movesay">
        {unchanged ? (
          <>
            <b>{takeClipLabel(row.take)}</b> is already on {fromLabel} take {row.take.number}.
          </>
        ) : (
          <>
            <b>{takeClipLabel(row.take)}</b> moves from {fromLabel} take {row.take.number} to {toLabel}{' '}
            take {destNumber}.
          </>
        )}
      </p>
      {!unchanged && (
        <p className="movesay movesay--note">
          {fromLabel} keeps its other take numbers as they are, so take {row.take.number} becomes a gap
          there. Numbers already called on set are never reused.
        </p>
      )}

      <div className="sheet__actions">
        <SheetClose className="btn btn--ghost" onClose={props.onClose}>
          Cancel
        </SheetClose>
        <button
          type="button"
          className="btn btn--go"
          disabled={unchanged}
          onClick={() => props.onMove(destination)}
        >
          Move take
        </button>
      </div>
    </Sheet>
  );
}
