import { useEffect, useRef, useState } from 'react';
import type {
  CameraUnit,
  CameraUnitLetter,
  MomentKind,
  Project,
  Slate,
  Take,
  TakeClip,
  TakeStatus,
} from '../types';
import { isMultiCam } from '../types';
import { store } from '../store';
import { parseClipNumber, rebaseClipNumbers } from '../store/util';
import { tc } from '../export/timecode';
import { renderUnitClip } from './cameras';
import { useRollTimer, useWakeLock, createSpeechListener } from '../engine';
import { Sheet, Rail, Toast, Confirm } from './common';
import { track } from '../net/analytics';
import * as haptics from './haptics';

interface Buffered {
  kind: MomentKind;
  atMs: number;
  endMs?: number;
  label: string;
  tag?: string;
}

function clipName(p: Project): string {
  return (
    p.clipPrefix +
    String(Math.max(0, p.nextClipNumber)).padStart(p.clipPadding, '0') +
    (p.clipSuffix ?? '')
  );
}

/** A saved take's clip(s) for a compact row: single name, or all units joined. */
function takeClipLabel(t: Take): string {
  return t.clips && t.clips.length ? t.clips.map((c) => `${c.unit} ${c.clipName}`).join(' · ') : t.clipName;
}

export function RollingScreen(props: {
  project: Project;
  slate: Slate;
  onExit: () => void;
  onNavigate?: (slate: Slate) => void;
}) {
  const { slate } = props;
  const timer = useRollTimer();
  useWakeLock(true);

  const [project, setProject] = useState<Project>(props.project);
  const [nextTakeNumber, setNextTakeNumber] = useState(1);
  const [recentTakes, setRecentTakes] = useState<Take[]>([]);
  const [siblings, setSiblings] = useState<Slate[]>([]);

  // Script Mode: two-tier tap chips baked onto the scene. A hand-made scene has
  // no tags and falls back to the project's quick tags (FLUB/GOLD/…).
  const coverageChips = (slate.tags ?? [])
    .filter((t) => t.tier === 'coverage')
    .sort((a, b) => a.order - b.order)
    .map((t) => t.label);
  const keyChips = (slate.tags ?? [])
    .filter((t) => t.tier === 'keyMoment')
    .sort((a, b) => a.order - b.order)
    .map((t) => t.label);
  const scriptMode = coverageChips.length > 0 || keyChips.length > 0;

  // Scene pager (flip, don't scroll). Only enabled while stopped.
  const sceneIndex = siblings.findIndex((s) => s.id === slate.id);
  const prevScene = sceneIndex > 0 ? siblings[sceneIndex - 1] : null;
  const nextScene =
    sceneIndex >= 0 && sceneIndex < siblings.length - 1 ? siblings[sceneIndex + 1] : null;

  const [buffered, setBuffered] = useState<Buffered[]>([]);
  const [markInMs, setMarkInMs] = useState<number | null>(null);
  const [rangeLabelTarget, setRangeLabelTarget] = useState<number | null>(null);
  const [postCut, setPostCut] = useState<{ take: Take } | null>(null);
  const [deletingTake, setDeletingTake] = useState<Take | null>(null);
  const [editingTake, setEditingTake] = useState<Take | null>(null);
  const [editingClip, setEditingClip] = useState(false);
  // A single camera unit whose NEXT clip number is being fixed inline (idle only).
  const [editingUnit, setEditingUnit] = useState<CameraUnit | null>(null);
  const [flashes, setFlashes] = useState<Record<string, number>>({});
  const [clapKey, setClapKey] = useState(0);
  const [toast, setToast] = useState<string | null>(null);

  // voice
  const [listener] = useState(() => createSpeechListener());
  const [micOn, setMicOn] = useState(false);
  const [listening, setListening] = useState(false);

  const doRollRef = useRef<() => void>(() => {});
  const doCutRef = useRef<() => void>(() => {});

  async function refreshMeta() {
    const [p, takes] = await Promise.all([
      store.getProject(project.id),
      store.listTakes(slate.id),
    ]);
    if (p) setProject(p);
    setNextTakeNumber(takes.reduce((m, t) => Math.max(m, t.number), 0) + 1);
    setRecentTakes(takes.slice(-4).reverse());
  }

  useEffect(() => {
    void refreshMeta();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [slate.id]);

  useEffect(() => {
    void store.listSlates(project.id).then(setSiblings);
  }, [project.id]);

  // voice wiring (once per listener)
  useEffect(() => {
    const offCmd = listener.onCommand((cmd) => {
      if (cmd === 'roll') doRollRef.current();
      else doCutRef.current();
    });
    const offState = listener.onStateChange(setListening);
    return () => {
      offCmd();
      offState();
      listener.stop();
    };
  }, [listener]);

  function bumpClap() {
    setClapKey((k) => k + 1);
  }

  function doRoll() {
    if (timer.rolling || postCut) return;
    haptics.thump();
    track('roll'); // fire-and-forget; never blocks or throws
    setBuffered([]);
    setMarkInMs(null);
    setRangeLabelTarget(null);
    bumpClap();
    timer.start();
  }

  async function doCut() {
    if (!timer.rolling) return;
    haptics.doubleThump();
    track('cut'); // fire-and-forget; never blocks or throws
    bumpClap();
    const { startedAt, durationMs } = timer.stop();
    const finalBuffer: Buffered[] =
      markInMs !== null
        ? [...buffered, { kind: 'range', atMs: markInMs, endMs: durationMs, label: '' }]
        : buffered;
    setMarkInMs(null);
    setRangeLabelTarget(null);

    const take = await store.createTake({
      slateId: slate.id,
      projectId: project.id,
      startedAt,
      durationMs,
    });
    for (const m of finalBuffer) {
      await store.createMoment({
        takeId: take.id,
        kind: m.kind,
        atMs: m.atMs,
        ...(m.endMs !== undefined ? { endMs: m.endMs } : {}),
        label: m.label,
        ...(m.tag !== undefined ? { tag: m.tag } : {}),
      });
    }
    setBuffered([]);
    setPostCut({ take });
    await refreshMeta();
  }

  // keep refs pointing at the freshest closures for voice commands
  doRollRef.current = doRoll;
  doCutRef.current = doCut;

  function tapTag(tag: string) {
    if (!timer.rolling) return;
    haptics.tap();
    setBuffered((prev) => [...prev, { kind: 'point', atMs: timer.elapsedMs, label: '', tag }]);
    setFlashes((prev) => ({ ...prev, [tag]: (prev[tag] ?? 0) + 1 }));
    setToast(tag === 'GOLD' ? 'GOLD marked' : `${tag} marked`);
  }

  function markInOut() {
    if (!timer.rolling) return;
    haptics.tap();
    if (markInMs === null) {
      setMarkInMs(timer.elapsedMs);
    } else {
      const start = markInMs;
      const end = timer.elapsedMs;
      setMarkInMs(null);
      setBuffered((prev) => {
        const next: Buffered[] = [...prev, { kind: 'range', atMs: start, endMs: end, label: '' }];
        setRangeLabelTarget(next.length - 1);
        return next;
      });
    }
  }

  function toggleMic() {
    if (micOn) {
      listener.stop();
      setMicOn(false);
    } else {
      listener.start();
      setMicOn(true);
    }
  }

  function tcValid(s: string): boolean {
    if (!tc.isValidTimecode(s)) return false;
    try {
      tc.timecodeToFrames(s, project.fps);
      return true;
    } catch {
      return false;
    }
  }

  const rolling = timer.rolling;
  const rangeArmedMs = markInMs !== null ? Math.max(0, timer.elapsedMs - markInMs) : 0;
  const multi = isMultiCam(project);
  const cameras = project.cameras ?? [];

  return (
    <div className={`roll${rolling ? ' roll--live' : ''}`}>
      <div className="roll__head">
        <button type="button" className="iconbtn" aria-label="Back to scenes" onClick={props.onExit}>
          &lsaquo;
        </button>
        <div className="roll__slate">
          <div className="name">{slate.name}</div>
          <div className="roll__nextline">
            <span>
              shot <span className="tnum">{nextTakeNumber}</span>
            </span>
            <span aria-hidden="true">&middot;</span>
            {multi ? (
              <button
                type="button"
                className="clipedit"
                aria-label="Fix the camera clip numbers"
                onClick={() => setEditingClip(true)}
              >
                {cameras.length} cams
                <span className="clipedit__pen" aria-hidden="true">✎</span>
              </button>
            ) : (
              <button
                type="button"
                className="clipedit"
                aria-label={`Clip ${clipName(project)}, tap to fix the number`}
                onClick={() => setEditingClip(true)}
              >
                clip <span className="tnum">{clipName(project)}</span>
                <span className="clipedit__pen" aria-hidden="true">✎</span>
              </button>
            )}
          </div>
        </div>
        {listener.supported && (
          <button
            type="button"
            className={`mictoggle${micOn ? ' mictoggle--on' : ''}`}
            aria-label={micOn ? 'Turn voice commands off' : 'Turn voice commands on'}
            aria-pressed={micOn}
            onClick={toggleMic}
          >
            <span className="miclamp" aria-hidden="true" />
            {micOn ? (listening ? 'listening' : 'mic on') : 'voice'}
          </button>
        )}
      </div>

      {slate.summary && <div className="roll__summary">{slate.summary}</div>}

      {props.onNavigate && siblings.length > 1 && (
        <div className="scenepager">
          <button
            type="button"
            className="scenepager__btn"
            aria-label="Previous scene"
            disabled={!prevScene || rolling || postCut !== null}
            onClick={() => prevScene && props.onNavigate?.(prevScene)}
          >
            &lsaquo; Prev
          </button>
          <span className="scenepager__pos tnum">
            {sceneIndex >= 0 ? sceneIndex + 1 : '-'}/{siblings.length}
          </span>
          <button
            type="button"
            className="scenepager__btn"
            aria-label="Next scene"
            disabled={!nextScene || rolling || postCut !== null}
            onClick={() => nextScene && props.onNavigate?.(nextScene)}
          >
            Next &rsaquo;
          </button>
        </div>
      )}

      <div className="roll__rail">
        <Rail key={clapKey} thin clap={clapKey > 0} />
      </div>

      <div className="roll__stage">
        <div className={`readout${rolling ? ' readout--live' : ' readout--idle'}`}>
          {tc.msToClock(timer.elapsedMs)}
        </div>
        <div className="stage__hint">
          {rolling ? (
            <span className="stage__reclabel">
              <span className="recdot" aria-hidden="true" /> ROLLING{multi ? ' · ALL CAMERAS' : ''}
            </span>
          ) : postCut ? (
            'Shot saved'
          ) : (
            'Tap ROLL' + (listener.supported ? ' or say "roll camera"' : '')
          )}
        </div>

        {multi && (
          <div
            className={`camstack${rolling ? ' camstack--live' : ''}`}
            aria-label="Current clip on each camera"
          >
            {cameras.map((u) =>
              rolling ? (
                <div key={u.letter} className="camslot">
                  <span className="camslot__badge">{u.letter}</span>
                  <span className="camslot__clip tnum">{renderUnitClip(u)}</span>
                </div>
              ) : (
                // Idle only: tap a readout to fix that camera's NEXT clip number
                // before rolling. Locked out while rolling to avoid mis-taps.
                <button
                  key={u.letter}
                  type="button"
                  className="camslot camslot--edit"
                  aria-label={`Camera ${u.letter} next clip ${renderUnitClip(u)}, tap to set`}
                  onClick={() => setEditingUnit(u)}
                >
                  <span className="camslot__badge">{u.letter}</span>
                  <span className="camslot__clip tnum">{renderUnitClip(u)}</span>
                  <span className="camslot__pen" aria-hidden="true">✎</span>
                </button>
              ),
            )}
          </div>
        )}

        {rolling ? (
          buffered.length > 0 && (
            <div className="momentlog" aria-label="Moments this shot">
              {[...buffered].reverse().map((m, i) => (
                <div
                  key={buffered.length - 1 - i}
                  className={`momentrow${m.kind === 'range' ? ' momentrow--range' : ''}${
                    m.tag === 'GOLD' ? ' momentrow--gold' : ''
                  }`}
                >
                  <span className="at">
                    {tc.msToClock(m.atMs)}
                    {m.kind === 'range' && m.endMs !== undefined ? ` - ${tc.msToClock(m.endMs)}` : ''}
                  </span>
                  {m.tag && <span className="tag">{m.tag}</span>}
                  {m.kind === 'range' && !m.tag && <span className="tag">RANGE</span>}
                  {m.label && <span className="lbl">{m.label}</span>}
                </div>
              ))}
            </div>
          )
        ) : (
          <div className="minitakes" aria-label="Recent shots">
            {recentTakes.length === 0 ? (
              <div className="minitake minitakes__empty">First shot of this scene</div>
            ) : (
              recentTakes.map((t) => (
                <div
                  key={t.id}
                  className={`minitake${t.status === 'discarded' ? ' minitake--discarded' : ''}`}
                >
                  <button
                    type="button"
                    className="minitake__open"
                    aria-label={`Edit shot ${t.number} (${takeClipLabel(t)})`}
                    onClick={() => setEditingTake(t)}
                  >
                    <span className="tnum">S{t.number}</span>
                    <span className="clip">{takeClipLabel(t)}</span>
                    <span className="dur tnum">{tc.msToClock(t.durationMs)}</span>
                    <span className="minitake__pen" aria-hidden="true">✎</span>
                  </button>
                  <button
                    type="button"
                    className="minitake__del"
                    aria-label={`Delete shot ${t.number} (${t.clipName})`}
                    onClick={() => setDeletingTake(t)}
                  >
                    &times;
                  </button>
                </div>
              ))
            )}
          </div>
        )}
      </div>

      <div className="roll__deck">
        {rolling && (
          <>
            {scriptMode ? (
              <>
                <div className="tagbar tagbar--coverage" aria-label="Coverage">
                  {coverageChips.map((tag) => {
                    const n = flashes[tag] ?? 0;
                    return (
                      <button
                        key={`${tag}:${n}`}
                        type="button"
                        className={`chip chip--coverage${n > 0 ? ' chip--flash' : ''}`}
                        onClick={() => tapTag(tag)}
                      >
                        {tag}
                      </button>
                    );
                  })}
                  {(() => {
                    const n = flashes.GOLD ?? 0;
                    return (
                      <button
                        key={`GOLD:${n}`}
                        type="button"
                        className={`chip chip--gold${n > 0 ? ' chip--flash' : ''}`}
                        onClick={() => tapTag('GOLD')}
                      >
                        GOLD
                      </button>
                    );
                  })()}
                </div>
                {keyChips.length > 0 && (
                  <div className="tagbar tagbar--key" aria-label="Key moments">
                    {keyChips.map((tag) => {
                      const n = flashes[tag] ?? 0;
                      return (
                        <button
                          key={`${tag}:${n}`}
                          type="button"
                          className={`chip chip--key${n > 0 ? ' chip--flash' : ''}`}
                          onClick={() => tapTag(tag)}
                        >
                          {tag}
                        </button>
                      );
                    })}
                  </div>
                )}
              </>
            ) : (
              <div className="tagbar">
                {project.tags.map((tag) => {
                  const n = flashes[tag] ?? 0;
                  return (
                    <button
                      key={`${tag}:${n}`}
                      type="button"
                      className={`chip${tag === 'GOLD' ? ' chip--gold' : ''}${n > 0 ? ' chip--flash' : ''}`}
                      onClick={() => tapTag(tag)}
                    >
                      {tag}
                    </button>
                  );
                })}
              </div>
            )}

            <button
              type="button"
              className={`markbtn${markInMs !== null ? ' markbtn--armed' : ''}`}
              onClick={markInOut}
            >
              {markInMs !== null ? (
                <>
                  MARK OUT
                  <span className="markbtn__badge tnum">{tc.msToClock(rangeArmedMs)}</span>
                </>
              ) : (
                'MARK IN'
              )}
            </button>

            {rangeLabelTarget !== null && (
              <div className="addline" style={{ marginTop: 0 }}>
                <input
                  className="field"
                  autoFocus
                  placeholder="Label this range (optional)"
                  value={buffered[rangeLabelTarget]?.label ?? ''}
                  onChange={(e) => {
                    const value = e.target.value;
                    setBuffered((prev) =>
                      prev.map((m, i) => (i === rangeLabelTarget ? { ...m, label: value } : m)),
                    );
                  }}
                  onKeyDown={(e) => {
                    if (e.key === 'Enter') setRangeLabelTarget(null);
                  }}
                />
                <button type="button" className="btn" onClick={() => setRangeLabelTarget(null)}>
                  Done
                </button>
              </div>
            )}
          </>
        )}

        <button
          type="button"
          className={`bigbtn${rolling ? ' bigbtn--cut' : ' bigbtn--go'}`}
          aria-label={rolling ? 'Cut and save shot' : 'Roll, start rolling'}
          onClick={rolling ? () => void doCut() : doRoll}
        >
          {rolling ? 'CUT' : 'ROLL'}
        </button>
      </div>

      {postCut && (
        <PostCutSheet
          take={postCut.take}
          tcValid={tcValid}
          onKeep={async (cameraTC, note) => {
            const patch: Partial<Take> = {};
            if (cameraTC) patch.cameraTC = cameraTC;
            if (note) patch.note = note;
            if (Object.keys(patch).length > 0) await store.updateTake(postCut.take.id, patch);
            setPostCut(null);
            await refreshMeta();
          }}
          onDiscard={async (cameraTC, note) => {
            const patch: Partial<Take> = { status: 'discarded' };
            if (cameraTC) patch.cameraTC = cameraTC;
            if (note) patch.note = note;
            await store.updateTake(postCut.take.id, patch);
            setPostCut(null);
            await refreshMeta();
          }}
        />
      )}

      {editingUnit && (
        <MultiClipSheet
          cameras={[editingUnit]}
          onClose={() => setEditingUnit(null)}
          onSet={async (edited) => {
            const one = edited[0];
            // Merge just this unit back; other cameras' counters are untouched.
            const merged = cameras.map((u) => (u.letter === one.letter ? one : u));
            const updated = await store.updateProject(project.id, { cameras: merged });
            setProject(updated);
            setEditingUnit(null);
            haptics.tap();
          }}
        />
      )}

      {editingTake && (
        <TakeEditSheet
          project={project}
          slate={slate}
          take={editingTake}
          onClose={() => setEditingTake(null)}
          onSaved={async (updatedProject, shifted) => {
            setEditingTake(null);
            // The rebase may have moved this camera's live counter, so take the
            // project back from the store rather than keeping the stale copy.
            setProject(updatedProject);
            if (shifted > 0) {
              setToast(`Clip fixed - ${shifted} later shot${shifted === 1 ? '' : 's'} moved too`);
            }
            await refreshMeta();
          }}
        />
      )}

      {deletingTake && (
        <Confirm
          title={`Delete shot ${deletingTake.number}?`}
          message={`Only if the camera never rolled. This removes ${takeClipLabel(deletingTake)} and every moment tagged in it, hands the clip number back, and slides every later shot on that camera down one. If the camera DID roll and the take was simply no good, discard it instead so it keeps its number. Cannot be undone.`}
          confirmLabel="Delete shot"
          onCancel={() => setDeletingTake(null)}
          onConfirm={async () => {
            await store.deleteTake(deletingTake.id);
            setDeletingTake(null);
            await refreshMeta();
          }}
        />
      )}

      {editingClip &&
        (multi ? (
          <MultiClipSheet
            cameras={cameras}
            onClose={() => setEditingClip(false)}
            onSet={async (units) => {
              const updated = await store.updateProject(project.id, { cameras: units });
              setProject(updated);
              setEditingClip(false);
              haptics.tap();
            }}
          />
        ) : (
          <ClipNumberSheet
            project={project}
            onClose={() => setEditingClip(false)}
            onSet={async (n) => {
              const updated = await store.updateProject(project.id, { nextClipNumber: n });
              setProject(updated);
              setEditingClip(false);
              haptics.tap();
            }}
          />
        ))}

      {toast && <Toast message={toast} onDone={() => setToast(null)} />}
    </div>
  );
}

// Fix the clip number on the fly — camera skipped one, a card change, a re-roll.
// The current shot takes the new number and the counter continues from it. Works
// mid-roll (the number is only baked onto the take at CUT).
function ClipNumberSheet(props: {
  project: Project;
  onClose: () => void;
  onSet: (n: number) => void;
}) {
  const [num, setNum] = useState(String(props.project.nextClipNumber));
  const n = Math.max(0, parseInt(num, 10) || 0);
  const preview =
    props.project.clipPrefix +
    String(n).padStart(props.project.clipPadding, '0') +
    (props.project.clipSuffix ?? '') +
    (props.project.clipExt ?? '');

  return (
    <Sheet title="Clip number" onClose={props.onClose}>
      <p className="camnote" style={{ marginTop: 0 }}>
        Camera skipped or repeated a number? Set it right. This shot takes the new number and the
        count carries on from here.
      </p>
      <div className="clipset">
        <button
          type="button"
          className="clipset__step"
          aria-label="Lower"
          onClick={() => setNum(String(Math.max(0, n - 1)))}
        >
          &minus;
        </button>
        <input
          className="field field--mono clipset__input"
          inputMode="numeric"
          value={num}
          autoFocus
          onChange={(e) => setNum(e.target.value.replace(/[^0-9]/g, ''))}
        />
        <button
          type="button"
          className="clipset__step"
          aria-label="Raise"
          onClick={() => setNum(String(n + 1))}
        >
          +
        </button>
      </div>
      <div className="clipset__preview">
        <span className="label">This shot becomes</span>
        <span className="tnum">{preview}</span>
      </div>
      <div className="sheet__actions">
        <button type="button" className="btn btn--ghost" onClick={props.onClose}>
          Cancel
        </button>
        <button type="button" className="btn btn--go" onClick={() => props.onSet(n)}>
          Set clip
        </button>
      </div>
    </Sheet>
  );
}

// The per-unit clip-number stepper stack, shared by the save-time editor
// (MultiClipSheet) and the take editor (TakeEditSheet). Each row shows the unit
// letter (multi-cam), a live formatted preview, and a - / value / + control.
function ClipNumberRows(props: {
  units: CameraUnit[];
  nums: string[];
  showLetter?: boolean;
  onNum: (i: number, value: string) => void;
}) {
  const showLetter = props.showLetter !== false;
  return (
    <div className="stack">
      {props.units.map((u, i) => {
        const n = Math.max(0, parseInt(props.nums[i], 10) || 0);
        const preview = renderUnitClip({ ...u, nextClipNumber: n }) + (u.clipExt ?? '');
        const who = showLetter ? `camera ${u.letter}` : 'clip';
        return (
          <div key={u.letter} className="camunit">
            <div className="camunit__head">
              {showLetter && <span className="camunit__badge">{u.letter}</span>}
              <span className="camunit__eg tnum">{preview}</span>
            </div>
            <div className="clipset" style={{ marginBottom: 0 }}>
              <button
                type="button"
                className="clipset__step"
                aria-label={`Lower ${who}`}
                onClick={() => props.onNum(i, String(Math.max(0, n - 1)))}
              >
                &minus;
              </button>
              <input
                className="field field--mono clipset__input"
                inputMode="numeric"
                value={props.nums[i]}
                onChange={(e) => props.onNum(i, e.target.value.replace(/[^0-9]/g, ''))}
              />
              <button
                type="button"
                className="clipset__step"
                aria-label={`Raise ${who}`}
                onClick={() => props.onNum(i, String(n + 1))}
              >
                +
              </button>
            </div>
          </div>
        );
      })}
    </div>
  );
}

// Multi-cam counterpart to ClipNumberSheet: fix each camera unit's next clip
// number independently. The next shot takes these and each unit counts on.
function MultiClipSheet(props: {
  cameras: CameraUnit[];
  onClose: () => void;
  onSet: (cameras: CameraUnit[]) => void;
}) {
  const [nums, setNums] = useState(props.cameras.map((u) => String(u.nextClipNumber)));

  function setNum(i: number, value: string) {
    setNums((prev) => prev.map((v, idx) => (idx === i ? value : v)));
  }
  const parsed = props.cameras.map((u, i) => ({
    ...u,
    nextClipNumber: Math.max(0, parseInt(nums[i], 10) || 0),
  }));

  return (
    <Sheet title="Clip numbers" onClose={props.onClose}>
      <p className="camnote" style={{ marginTop: 0 }}>
        A camera skipped or repeated a number? Set each one right. The next shot takes these numbers
        and every camera counts on from there.
      </p>
      <ClipNumberRows units={props.cameras} nums={nums} onNum={setNum} />
      <div className="sheet__actions">
        <button type="button" className="btn btn--ghost" onClick={props.onClose}>
          Cancel
        </button>
        <button type="button" className="btn btn--go" onClick={() => props.onSet(parsed)}>
          Set clips
        </button>
      </div>
    </Sheet>
  );
}

// Correct an already-logged take: the mis-typed clip number(s) first (the main
// ask, driven by the same ClipNumberRows stepper as the save-time editor), then
// the adjacent status / tags / note. This only rewrites THIS take's row - it
// never moves the live per-camera clip counter or renumbers other takes.
function TakeEditSheet(props: {
  project: Project;
  slate: Slate;
  take: Take;
  onClose: () => void;
  onSaved: (project: Project, shifted: number) => void;
}) {
  const { project, slate, take } = props;
  const multi = (take.clips?.length ?? 0) > 0;

  // Editable per-unit clip definitions rebuilt from the take's recorded clips,
  // using each unit's current prefix/padding/suffix so the stepper reformats
  // exactly like the save-time editor.
  const [units] = useState<CameraUnit[]>(() =>
    multi
      ? (take.clips ?? []).map((clip) => {
          const cam = project.cameras?.find((c) => c.letter === clip.unit);
          const clipPrefix = cam?.clipPrefix ?? project.clipPrefix;
          const clipPadding = cam?.clipPadding ?? project.clipPadding;
          const clipSuffix = cam?.clipSuffix ?? project.clipSuffix ?? '';
          const clipExt = cam?.clipExt ?? project.clipExt ?? '';
          return {
            letter: clip.unit,
            ...(cam?.camera ? { camera: cam.camera } : {}),
            clipPrefix,
            clipPadding,
            clipSuffix,
            clipExt,
            nextClipNumber: parseClipNumber(clip.clipName, clipPrefix, clipSuffix),
          };
        })
      : [
          {
            letter: 'A' as const,
            clipPrefix: project.clipPrefix,
            clipPadding: project.clipPadding,
            clipSuffix: project.clipSuffix ?? '',
            clipExt: project.clipExt ?? '',
            nextClipNumber: parseClipNumber(take.clipName, project.clipPrefix, project.clipSuffix ?? ''),
          },
        ],
  );

  const [nums, setNums] = useState(units.map((u) => String(u.nextClipNumber)));
  const [status, setStatus] = useState<TakeStatus>(take.status);
  const [note, setNote] = useState(take.note ?? '');
  // Tags live as tagged moments; we surface presence as toggle chips and
  // reconcile on save (add a point moment when turned on, delete the take's
  // moments of that tag when turned off).
  const [activeTags, setActiveTags] = useState<Set<string>>(new Set());
  const [origTags, setOrigTags] = useState<Set<string>>(new Set());
  const [momentIdsByTag, setMomentIdsByTag] = useState<Map<string, string[]>>(new Map());
  const [saving, setSaving] = useState(false);
  // Set when saving would renumber OTHER shots: holds the pending write and a
  // plain-language list of every shot that moves, pending the user's go-ahead.
  const [pendingShift, setPendingShift] = useState<{
    newNumbers: Partial<Record<CameraUnitLetter, number>>;
    moved: string[];
  } | null>(null);

  useEffect(() => {
    let alive = true;
    void store.listMoments(take.id).then((ms) => {
      if (!alive) return;
      const byTag = new Map<string, string[]>();
      for (const m of ms) {
        if (!m.tag) continue;
        const list = byTag.get(m.tag) ?? [];
        list.push(m.id);
        byTag.set(m.tag, list);
      }
      setMomentIdsByTag(byTag);
      setActiveTags(new Set(byTag.keys()));
      setOrigTags(new Set(byTag.keys()));
    });
    return () => {
      alive = false;
    };
  }, [take.id]);

  // Offered chips mirror the rolling deck: scene coverage + GOLD + key beats in
  // Script Mode, else the project quick tags. Any already-present tag outside
  // that set is appended so it stays visible and removable.
  const coverage = (slate.tags ?? [])
    .filter((t) => t.tier === 'coverage')
    .sort((a, b) => a.order - b.order)
    .map((t) => t.label);
  const keyBeats = (slate.tags ?? [])
    .filter((t) => t.tier === 'keyMoment')
    .sort((a, b) => a.order - b.order)
    .map((t) => t.label);
  const scriptMode = coverage.length > 0 || keyBeats.length > 0;
  const offered = scriptMode ? [...coverage, 'GOLD', ...keyBeats] : project.tags;
  const tagChips = [...offered, ...[...origTags].filter((t) => !offered.includes(t))];

  function setNum(i: number, value: string) {
    setNums((prev) => prev.map((v, idx) => (idx === i ? value : v)));
  }
  function toggleTag(tag: string) {
    setActiveTags((prev) => {
      const next = new Set(prev);
      if (next.has(tag)) next.delete(tag);
      else next.add(tag);
      return next;
    });
  }

  function typedNumbers(): Partial<Record<CameraUnitLetter, number>> {
    const out: Partial<Record<CameraUnitLetter, number>> = {};
    units.forEach((u, i) => {
      out[u.letter] = Math.max(0, parseInt(nums[i], 10) || 0);
    });
    return out;
  }

  /**
   * Renumbering rewrites shots the user is not looking at, so never do it
   * silently. Dry-run the rebase against a copy of the project's takes, and if
   * anything downstream would move, show exactly what and make them agree.
   */
  async function requestSave() {
    if (saving) return;
    haptics.tap();

    const newNumbers = typedNumbers();
    const bundle = await store.getBundle(project.id);
    const preview = rebaseClipNumbers(project, bundle.takes, take.id, newNumbers, Date.now());
    const others = preview.takes.filter((t) => t.id !== take.id);

    if (others.length === 0) {
      void commit(newNumbers);
      return;
    }

    // List ONLY the clips that actually change. Echoing every camera on a
    // 4-cam take buries the one line that matters.
    const was = new Map(bundle.takes.map((t) => [t.id, t]));
    const moved = others
      .slice()
      .sort((a, b) => a.createdAt - b.createdAt)
      .map((t) => {
        const before = was.get(t.id);
        const pairs: string[] = [];
        if (before?.clips?.length && t.clips?.length) {
          for (const clip of t.clips) {
            const old = before.clips.find((c) => c.unit === clip.unit);
            if (old && old.clipName !== clip.clipName) {
              pairs.push(`${clip.unit} ${old.clipName} → ${clip.clipName}`);
            }
          }
        } else if (before && before.clipName !== t.clipName) {
          pairs.push(`${before.clipName} → ${t.clipName}`);
        }
        return `shot ${t.number}:  ${pairs.join(',  ')}`;
      });
    setPendingShift({ newNumbers, moved });
  }

  async function commit(newNumbers: Partial<Record<CameraUnitLetter, number>>) {
    if (saving) return;
    setSaving(true);
    setPendingShift(null);

    // A camera counts its own files monotonically, so correcting THIS clip
    // number means every later file that camera wrote is off by the same delta,
    // and so is the live counter. rebaseClips carries the correction forward
    // (per unit, later shots only) in one atomic write.
    const rebased = await store.rebaseClips(project.id, take.id, newNumbers);

    const trimmedNote = note.trim();
    // Status/tags/note are this row's alone; the clip names were just written
    // by the rebase, so this patch must not carry them.
    await store.updateTake(take.id, {
      status,
      note: trimmedNote ? trimmedNote : undefined,
    });

    for (const tag of activeTags) {
      if (!origTags.has(tag)) {
        await store.createMoment({ takeId: take.id, kind: 'point', atMs: 0, label: '', tag });
      }
    }
    for (const tag of origTags) {
      if (!activeTags.has(tag)) {
        for (const id of momentIdsByTag.get(tag) ?? []) await store.deleteMoment(id);
      }
    }

    props.onSaved(rebased.project, rebased.shifted);
  }

  // Renumbering touches shots the user cannot see from here, so it gets its own
  // screen rather than a nested sheet: state below stays mounted, so STOP puts
  // them back on the edit form with every field exactly as they left it.
  if (pendingShift) {
    const n = pendingShift.moved.length;
    return (
      <Sheet
        title="This renumbers later shots"
        lede={`The camera kept counting, so correcting this clip number corrects every later shot on that camera too, and the live counter with it. ${n} later shot${n === 1 ? '' : 's'} will change. If you did not mean to do this, press STOP.`}
        onClose={() => setPendingShift(null)}
      >
        <ul
          style={{
            listStyle: 'none',
            margin: '0 0 4px',
            padding: 0,
            display: 'grid',
            gap: 8,
            fontFamily: 'var(--font-mono)',
            fontSize: '0.82rem',
            color: 'var(--chalk-dim)',
          }}
        >
          {pendingShift.moved.map((line) => (
            <li key={line}>{line}</li>
          ))}
        </ul>
        <div className="sheet__actions">
          <button type="button" className="btn btn--ghost" onClick={() => setPendingShift(null)}>
            STOP
          </button>
          <button
            type="button"
            className="btn btn--go"
            disabled={saving}
            onClick={() => void commit(pendingShift.newNumbers)}
          >
            Yes, renumber
          </button>
        </div>
      </Sheet>
    );
  }

  return (
    <Sheet title={`Edit shot ${take.number}`} onClose={props.onClose}>
      <p className="camnote" style={{ marginTop: 0 }}>
        Fix a mis-logged clip number, status, tags or note. Correcting a clip number also shifts
        every LATER shot on that camera by the same amount, and the live counter with them - the
        camera kept counting, so they are all off by the same gap. Earlier shots never move.
      </p>

      <ClipNumberRows units={units} nums={nums} showLetter={multi} onNum={setNum} />

      <div className="formrow" style={{ marginTop: 16 }}>
        <span className="label">Status</span>
        <div className="camcount" role="group" aria-label="Take status" style={{ gridTemplateColumns: '1fr 1fr' }}>
          <button
            type="button"
            className={`camcount__opt${status === 'good' ? ' camcount__opt--on' : ''}`}
            style={{ fontFamily: 'var(--font-ui)', fontSize: '0.9rem' }}
            aria-pressed={status === 'good'}
            onClick={() => setStatus('good')}
          >
            Good
          </button>
          <button
            type="button"
            className={`camcount__opt${status === 'discarded' ? ' camcount__opt--on' : ''}`}
            style={{ fontFamily: 'var(--font-ui)', fontSize: '0.9rem' }}
            aria-pressed={status === 'discarded'}
            onClick={() => setStatus('discarded')}
          >
            No good
          </button>
        </div>
      </div>

      <div className="formrow">
        <span className="label">Tags</span>
        <div className="chips">
          {tagChips.map((tag) => {
            const on = activeTags.has(tag);
            const gold = tag === 'GOLD';
            return (
              <button
                key={tag}
                type="button"
                className={`chip${gold ? ' chip--gold' : ''}${on ? ' chip--on' : ' chip--off'}`}
                aria-pressed={on}
                onClick={() => toggleTag(tag)}
              >
                {tag}
              </button>
            );
          })}
        </div>
      </div>

      <div className="formrow">
        <label className="label" htmlFor="te-note">
          Note
        </label>
        <textarea
          id="te-note"
          className="field"
          placeholder="e.g. lens flare on the door"
          value={note}
          onChange={(e) => setNote(e.target.value)}
        />
      </div>

      <div className="sheet__actions">
        <button type="button" className="btn btn--ghost" onClick={props.onClose} disabled={saving}>
          Cancel
        </button>
        <button type="button" className="btn btn--go" disabled={saving} onClick={() => void requestSave()}>
          Save shot
        </button>
      </div>

    </Sheet>
  );
}

function PostCutSheet(props: {
  take: Take;
  tcValid: (s: string) => boolean;
  onKeep: (cameraTC: string | undefined, note: string | undefined) => void;
  onDiscard: (cameraTC: string | undefined, note: string | undefined) => void;
}) {
  const [camTC, setCamTC] = useState('');
  const [note, setNote] = useState('');

  const trimmedTC = camTC.trim();
  const tcOk = trimmedTC === '' || props.tcValid(trimmedTC);
  const savedTC = trimmedTC !== '' && props.tcValid(trimmedTC) ? trimmedTC : undefined;
  const savedNote = note.trim() !== '' ? note.trim() : undefined;

  const clips = props.take.clips ?? [];
  return (
    <Sheet title={`Shot ${props.take.number} saved`}>
      {clips.length > 0 && (
        <div className="camstack camstack--sheet" aria-label="Clip on each camera">
          {clips.map((c) => (
            <div key={c.unit} className="camslot">
              <span className="camslot__badge">{c.unit}</span>
              <span className="camslot__clip tnum">{c.clipName}</span>
            </div>
          ))}
        </div>
      )}
      <div className="takesummary">
        {clips.length === 0 && (
          <div className="takesummary__cell">
            <div className="label">Clip</div>
            <div className="val val--clip">{props.take.clipName}</div>
          </div>
        )}
        <div className="takesummary__cell">
          <div className="label">Shot</div>
          <div className="val">{props.take.number}</div>
        </div>
        <div className="takesummary__cell">
          <div className="label">Length</div>
          <div className="val">{tc.msToClock(props.take.durationMs)}</div>
        </div>
      </div>

      <div className="formrow">
        <label className="label" htmlFor="pc-tc">
          Camera timecode at shot start (optional)
        </label>
        <input
          id="pc-tc"
          className="field field--mono"
          inputMode="numeric"
          placeholder="HH:MM:SS:FF"
          value={camTC}
          onChange={(e) => setCamTC(e.target.value)}
        />
        {!tcOk && (
          <span className="tnum tnum--bad" style={{ fontSize: '0.78rem' }}>
            Not a valid timecode - it will not be saved
          </span>
        )}
      </div>

      <div className="formrow">
        <label className="label" htmlFor="pc-note">
          Note (optional)
        </label>
        <textarea
          id="pc-note"
          className="field"
          placeholder="e.g. lens flare on the door"
          value={note}
          onChange={(e) => setNote(e.target.value)}
        />
      </div>

      <div className="sheet__actions">
        <button
          type="button"
          className="btn btn--danger"
          onClick={() => props.onDiscard(savedTC, savedNote)}
        >
          Discard
        </button>
        <button
          type="button"
          className="btn btn--go"
          onClick={() => props.onKeep(savedTC, savedNote)}
        >
          Keep
        </button>
      </div>
    </Sheet>
  );
}
