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

import { useEffect, useMemo, useState } from 'react';
import type { Project, Shot, Slate, Take } from '../types';
import { store } from '../store';
import { nextTakeNumber } from '../store/util';
import { tc } from '../export/timecode';
import { Sheet, Rail, Toast, Confirm } from './common';
import { useScrolled } from './glist';
import { BackButton } from './marks';
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
  const [query, setQuery] = useState('');
  const [moving, setMoving] = useState<ClipRow | null>(null);
  const [editing, setEditing] = useState<ClipRow | null>(null);
  const [deleting, setDeleting] = useState<ClipRow | null>(null);
  const [toast, setToast] = useState<string | null>(null);

  async function refresh() {
    // The project comes back too, not just the rows: a delete hands a clip
    // number back and moves that camera's live counter (reclaimClipNumbers),
    // and the next sheet opened from this screen is handed this copy. Same
    // reason RollingScreen re-reads it in refreshMeta.
    const [fresh, list] = await Promise.all([store.getProject(project.id), store.listSlates(project.id)]);
    const perSlate = await Promise.all(list.map((s) => store.listTakes(s.id)));
    if (fresh) setProject(fresh);
    setSlates(list);
    // Newest first. `startedAt` is when the camera rolled, which is the order
    // the day actually happened in; id breaks the tie so two takes stamped in
    // the same millisecond never swap places between renders.
    setTakes(
      perSlate.flat().sort((a, b) => b.startedAt - a.startedAt || (a.id < b.id ? 1 : a.id > b.id ? -1 : 0)),
    );
  }

  useEffect(() => {
    void refresh();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [project.id]);

  const slateById = useMemo(() => new Map((slates ?? []).map((s) => [s.id, s])), [slates]);

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
      built.push({ take, slate, ...(shot ? { shot } : {}) });
    }
    return built;
  }, [takes, slates, slateById]);

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

  async function move(row: ClipRow, destination: { slateId: string; shotId?: string }) {
    haptics.tap();
    try {
      const moved = await store.reassignTake(row.take.id, destination);
      const destSlate = slateById.get(destination.slateId);
      const destShot =
        destSlate && destination.shotId !== undefined ? findShot(destSlate, destination.shotId) : undefined;
      setMoving(null);
      await refresh();
      setToast(`Moved to ${destShot?.code ?? destSlate?.name ?? 'scene'} take ${moved.number}`);
    } catch (err) {
      // A rejected reassignTake must not leave the sheet open on a dead Move
      // button, so close it and say so, same as every other failed write here.
      console.error('Clapper: failed to move take', err);
      setMoving(null);
      setToast('Could not move that clip, try again');
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
      await refresh();
      setToast('Take deleted');
    } catch (err) {
      console.error('Clapper: failed to delete take', err);
      setDeleting(null);
      setToast('Could not delete that take, try again');
    }
  }

  // The nav bar is sticky material; the hairline under it arrives only once
  // there is a list behind it to separate from.
  const scrolled = useScrolled();

  return (
    <div className="app">
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
        <div className="section__head">
          <span className="label">Every clip rolled</span>
          {filtered && query.trim() !== '' && (
            <span className="section__note">{filtered.length} matching</span>
          )}
        </div>

        <input
          className="field field--mono"
          type="search"
          aria-label="Find a clip"
          placeholder="Find a clip e.g. C0184"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
        />

        {filtered === null ? (
          <div className="empty">Loading clips</div>
        ) : filtered.length === 0 ? (
          <div className="empty">
            <b>{query.trim() ? 'No clip matches that' : 'No clips yet'}</b>
            {query.trim()
              ? 'Try the number on its own, or the scene name.'
              : 'Roll a take and its clip name shows up here, with the scene and shot it belongs to.'}
          </div>
        ) : (
          <div className="cliplog">
            {filtered.map((row) => {
              const { take, slate, shot } = row;
              return (
                <div key={take.id} className={`cliprow${take.status === 'discarded' ? ' cliprow--discarded' : ''}`}>
                  {/* Primary tap target: the correction sheet, reachable here
                      exactly like it is from the rolling screen's recent takes,
                      just not limited to the last few. */}
                  <button
                    type="button"
                    className="cliprow__main"
                    aria-label={`${takeClipLabel(take)}, ${slate.name}${
                      shot ? `, shot ${shot.code}` : ''
                    }, take ${take.number}. Tap to fix a clip number, status, tags or note.`}
                    onClick={() => setEditing(row)}
                  >
                    <span className="cliprow__names">
                      <span className="cliprow__clip">{takeClipLabel(take)}</span>
                      {take.sound && <span className="cliprow__snd">🔊 {take.sound.fileName}</span>}
                    </span>
                    <span className="cliprow__where">
                      <span className="cliprow__scene">{slate.name}</span>
                      {/* No shot line for a take that has none. A scene-level
                          take is a real thing, not missing data. */}
                      {shot && <span className="cliprow__shot">{shot.code}</span>}
                      <span className="cliprow__take tnum">take {take.number}</span>
                      {take.status === 'discarded' && <span className="cliprow__flag">discarded</span>}
                    </span>
                    <span className="cliprow__times">
                      <span className="tnum">{wallClock(take.startedAt)}</span>
                      <span className="tnum">{tc.msToClock(take.durationMs)}</span>
                    </span>
                  </button>
                  <div className="cliprow__toolbar">
                    <button
                      type="button"
                      className="cliprow__tool"
                      aria-label={`Move ${takeClipLabel(take)} to another scene or shot`}
                      onClick={() => setMoving(row)}
                    >
                      Move
                    </button>
                    <button
                      type="button"
                      className="cliprow__tool cliprow__tool--danger"
                      aria-label={`Delete take ${take.number} (${takeClipLabel(take)})`}
                      onClick={() => setDeleting(row)}
                    >
                      Delete
                    </button>
                  </div>
                </div>
              );
            })}
          </div>
        )}
      </section>

      <div style={{ marginTop: 22 }}>
        <Rail thin />
      </div>

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
        {row.take.sound && <span className="movepreview__snd">🔊 {row.take.sound.fileName}</span>}
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
        <button type="button" className="btn btn--ghost" onClick={props.onClose}>
          Cancel
        </button>
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
