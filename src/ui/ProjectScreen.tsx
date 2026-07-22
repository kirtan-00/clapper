import { useEffect, useState } from 'react';
import type { CameraUnit, Project, Slate } from '../types';
import { isMultiCam } from '../types';
import { store } from '../store';
import { tc } from '../export/timecode';
import { exporter, shareBlob } from '../export';
import { findPreset, renderUnitClip, UNIT_LETTERS } from './cameras';
import { slug } from './share';
import { Sheet, Confirm, Rail } from './common';
import { SignInSheet } from './SignInSheet';
import { ProCta } from './ProCta';
import { useSession } from '../net/auth';
import { gateExport, FREE_LIMIT } from '../net/quota';
import { track } from '../net/analytics';
import * as haptics from './haptics';

interface SlateStat {
  slate: Slate;
  takeCount: number;
  goodCount: number; // kept shots — a scene with >=1 is "in the can"
  totalMs: number;
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
}) {
  const [project, setProject] = useState<Project>(props.project);
  const [slates, setSlates] = useState<SlateStat[] | null>(null);
  const [addName, setAddName] = useState('');
  const [renaming, setRenaming] = useState<Slate | null>(null);
  const [deleting, setDeleting] = useState<Slate | null>(null);
  const [hintSeen, setHintSeen] = useState<boolean>(() => rollHintSeen());

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
    const list = await store.listSlates(project.id);
    const stats = await Promise.all(
      list.map(async (slate) => {
        const takes = await store.listTakes(slate.id);
        const good = takes.filter((t) => t.status === 'good');
        const totalMs = good.reduce((sum, t) => sum + t.durationMs, 0);
        return { slate, takeCount: takes.length, goodCount: good.length, totalMs };
      }),
    );
    setSlates(stats);
  }

  useEffect(() => {
    void refresh();
    // reload the freshest project (clip counter may have moved while rolling)
    void store.getProject(project.id).then((p) => {
      if (p) {
        setProject(p);
        props.onProjectChanged(p);
      }
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [project.id]);

  async function commitProject(patch: Partial<Project>) {
    const updated = await store.updateProject(project.id, patch);
    setProject(updated);
    props.onProjectChanged(updated);
  }

  return (
    <div className="app">
      <div className="topbar">
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

      <section className="section">
        <div className="section__head">
          <span className="label">Scenes</span>
          {slates && slates.length > 0 && (
            <span className="section__note">
              {slates.filter((s) => s.goodCount > 0).length}/{slates.length} in the can
            </span>
          )}
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
            {slates.map(({ slate, takeCount, goodCount, totalMs }) => (
              <button
                key={slate.id}
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
                  </span>
                  <span className="card__count">{takeCount}</span>
                  <span className="card__chevron" aria-hidden="true">
                    ›
                  </span>
                </div>
                {slate.summary && <div className="card__summary">{slate.summary}</div>}
                <div className="card__meta">
                  <span>{takeCount === 1 ? '1 shot' : `${takeCount} shots`}</span>
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
                    className="iconbtn"
                    role="button"
                    tabIndex={0}
                    aria-label={`Delete scene ${slate.name}`}
                    style={{ minHeight: 32, minWidth: 32 }}
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
                    del
                  </span>
                </div>
              </button>
            ))}
            </div>
          </>
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

      <ClipCounterSection project={project} onCommit={commitProject} />

      <TcCalculator project={project} />

      <ExportBar project={project} />

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
          message="This removes the scene and all of its shots and moments. This cannot be undone."
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
}

interface UnitDraft {
  camera?: string;
  prefix: string;
  num: string;
  pad: string;
  ext: string;
  suffix: string;
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
      };
    }
    return { camera: 'sony', prefix: 'C', num: '1', pad: '4', ext: '.MP4', suffix: '' };
  });
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

// PDF is free, offline, and never gated. Premiere (FCP7 XML), Resolve (FCPXML)
// and CSV are the pro editor-handoff: each needs a signed-in account. Resolve
// shares Premiere's server-side quota counter (same "editor timeline handoff"
// allowance, no separate counter to add) — CSV has its own. The client only
// builds the blob after `export-gate` says allow.
const EXPORT_OFFLINE_MSG =
  "You're offline. Premiere, Resolve and CSV export need a connection. Logging takes and PDF export work offline.";

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
      await shareBlob(blob, `${base}-log.pdf`, 'application/pdf');
    } finally {
      setBusy(null);
    }
  }

  async function exportGated(kind: 'xml' | 'resolve' | 'csv') {
    setError(null);
    setNote(null);
    setCapped(null);
    if (!session) {
      setShowSignIn(true);
      return;
    }
    // Resolve rides the SAME gate call as Premiere ('premiere' format) — one
    // shared "editor timeline" quota bucket, not a new rule. `label` is only
    // for what we show/log, so a Resolve export doesn't get logged as one.
    const format = kind === 'csv' ? 'csv' : 'premiere';
    const label = kind === 'xml' ? 'premiere' : kind === 'resolve' ? 'resolve' : 'csv';
    setBusy(kind);
    try {
      const gate = await gateExport(format);
      if (!gate.allow) {
        if (gate.reason === 'quota_exceeded') {
          track('cap_hit', { which: label });
          setError('Free limit reached. More coming soon.');
          setCapped(format);
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
      if (kind === 'xml') {
        const blob = exporter.toFcpXml(bundle);
        await shareBlob(blob, `${base}-log.xml`, 'text/xml');
      } else if (kind === 'resolve') {
        const blob = exporter.toResolveXml(bundle);
        await shareBlob(blob, `${base}-log.fcpxml`, 'text/xml');
      } else {
        const blob = exporter.toCsv(bundle);
        await shareBlob(blob, `${base}-log.csv`, 'text/csv');
      }
      track('export', { format: label });
      if (typeof gate.remaining === 'number') {
        setNote(`${gate.remaining} of ${FREE_LIMIT} ${label} exports left`);
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
      <div className="formgrid" style={{ gridTemplateColumns: '1fr 1fr 1fr 1fr' }}>
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
        <button type="button" className="btn btn--ghost" onClick={props.onClose}>
          Cancel
        </button>
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
