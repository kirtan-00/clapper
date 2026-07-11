import { useEffect, useRef, useState } from 'react';
import type { MomentKind, Project, Slate, Take } from '../types';
import { store } from '../store';
import { tc } from '../export/timecode';
import { useRollTimer, useWakeLock, createSpeechListener } from '../engine';
import { Sheet, Rail, Toast } from './common';
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

export function RollingScreen(props: { project: Project; slate: Slate; onExit: () => void }) {
  const { slate } = props;
  const timer = useRollTimer();
  useWakeLock(true);

  const [project, setProject] = useState<Project>(props.project);
  const [nextTakeNumber, setNextTakeNumber] = useState(1);
  const [recentTakes, setRecentTakes] = useState<Take[]>([]);

  const [buffered, setBuffered] = useState<Buffered[]>([]);
  const [markInMs, setMarkInMs] = useState<number | null>(null);
  const [rangeLabelTarget, setRangeLabelTarget] = useState<number | null>(null);
  const [postCut, setPostCut] = useState<{ take: Take } | null>(null);
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
    setBuffered([]);
    setMarkInMs(null);
    setRangeLabelTarget(null);
    bumpClap();
    timer.start();
  }

  async function doCut() {
    if (!timer.rolling) return;
    haptics.doubleThump();
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
            <span>
              clip <span className="tnum">{clipName(project)}</span>
            </span>
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
              <span className="recdot" aria-hidden="true" /> ROLLING
            </span>
          ) : postCut ? (
            'Shot saved'
          ) : (
            'Tap ROLL' + (listener.supported ? ' or say "roll camera"' : '')
          )}
        </div>

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
                  <span className="tnum">S{t.number}</span>
                  <span className="clip">{t.clipName}</span>
                  <span className="dur tnum">{tc.msToClock(t.durationMs)}</span>
                </div>
              ))
            )}
          </div>
        )}
      </div>

      <div className="roll__deck">
        {rolling && (
          <>
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

      {toast && <Toast message={toast} onDone={() => setToast(null)} />}
    </div>
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

  return (
    <Sheet title={`Shot ${props.take.number} saved`}>
      <div className="takesummary">
        <div className="takesummary__cell">
          <div className="label">Clip</div>
          <div className="val val--clip">{props.take.clipName}</div>
        </div>
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
