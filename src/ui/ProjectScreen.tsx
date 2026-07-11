import { useEffect, useState } from 'react';
import type { Project, Slate } from '../types';
import { store } from '../store';
import { tc } from '../export/timecode';
import { exporter, shareBlob } from '../export';
import { slug } from './share';
import { Sheet, Confirm, Rail } from './common';
import * as haptics from './haptics';

interface SlateStat {
  slate: Slate;
  takeCount: number;
  totalMs: number;
}

function clipName(prefix: string, n: number, pad: number): string {
  return prefix + String(Math.max(0, n)).padStart(pad, '0');
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
        return { slate, takeCount: takes.length, totalMs };
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
            {project.fps} fps <span aria-hidden="true">&middot;</span> next clip{' '}
            <span className="tnum">{clipName(project.clipPrefix, project.nextClipNumber, project.clipPadding)}</span>
          </div>
        </div>
      </div>

      <Rail thin />

      <section className="section">
        <div className="section__head">
          <span className="label">Slates</span>
        </div>

        {slates === null ? (
          <div className="empty">Loading slates</div>
        ) : slates.length === 0 ? (
          <div className="empty">
            <b>No slates yet</b>
            Add a slate for your first setup, then tap it to start rolling.
          </div>
        ) : (
          <div className="stack">
            {slates.map(({ slate, takeCount, totalMs }) => (
              <button
                key={slate.id}
                type="button"
                className="card"
                onClick={() => props.onOpenSlate(project, slate)}
              >
                <div className="card__row">
                  <span className="card__name">{slate.name}</span>
                  <span className="card__count">{takeCount}</span>
                </div>
                <div className="card__meta">
                  <span>{takeCount === 1 ? '1 take' : `${takeCount} takes`}</span>
                  <span>
                    roll <b className="tnum">{tc.msToClock(totalMs)}</b>
                  </span>
                  <span
                    className="iconbtn"
                    role="button"
                    tabIndex={0}
                    aria-label={`Rename slate ${slate.name}`}
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
                    aria-label={`Delete slate ${slate.name}`}
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
        )}

        <div className="addline">
          <input
            className="field"
            value={addName}
            placeholder="New slate e.g. 14A"
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

      <ClipConfig
        project={project}
        onSave={(prefix, n, pad) =>
          commitProject({ clipPrefix: prefix, nextClipNumber: n, clipPadding: pad })
        }
      />

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
          title={`Delete slate ${deleting.name}?`}
          message="This removes the slate and all of its takes and moments. This cannot be undone."
          confirmLabel="Delete slate"
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

function ClipConfig(props: {
  project: Project;
  onSave: (prefix: string, n: number, pad: number) => Promise<void>;
}) {
  const [prefix, setPrefix] = useState(props.project.clipPrefix);
  const [num, setNum] = useState(String(props.project.nextClipNumber));
  const [pad, setPad] = useState(String(props.project.clipPadding));
  const [saved, setSaved] = useState(false);

  useEffect(() => {
    setPrefix(props.project.clipPrefix);
    setNum(String(props.project.nextClipNumber));
    setPad(String(props.project.clipPadding));
  }, [props.project.clipPrefix, props.project.nextClipNumber, props.project.clipPadding]);

  const nNum = Math.max(0, parseInt(num, 10) || 0);
  const nPad = Math.min(8, Math.max(1, parseInt(pad, 10) || 1));
  const dirty =
    prefix !== props.project.clipPrefix ||
    nNum !== props.project.nextClipNumber ||
    nPad !== props.project.clipPadding;

  return (
    <section className="section">
      <div className="section__head">
        <span className="label">Camera clip counter</span>
      </div>
      <div className="clipwidget">
        <div className="clipwidget__preview">
          <span className="label">Next clip</span>
          <span className="tnum">{clipName(prefix, nNum, nPad)}</span>
        </div>
        <div className="clipgrid">
          <div className="formrow" style={{ margin: 0 }}>
            <label className="label" htmlFor="cc-prefix">
              Prefix
            </label>
            <input
              id="cc-prefix"
              className="field field--mono"
              value={prefix}
              onChange={(e) => setPrefix(e.target.value)}
            />
          </div>
          <div className="formrow" style={{ margin: 0 }}>
            <label className="label" htmlFor="cc-num">
              Number
            </label>
            <input
              id="cc-num"
              className="field field--mono"
              inputMode="numeric"
              value={num}
              onChange={(e) => setNum(e.target.value.replace(/[^0-9]/g, ''))}
            />
          </div>
          <div className="formrow" style={{ margin: 0 }}>
            <label className="label" htmlFor="cc-pad">
              Pad
            </label>
            <input
              id="cc-pad"
              className="field field--mono"
              inputMode="numeric"
              value={pad}
              onChange={(e) => setPad(e.target.value.replace(/[^0-9]/g, ''))}
            />
          </div>
        </div>
        <button
          type="button"
          className="btn btn--full"
          style={{ marginTop: 12 }}
          disabled={!dirty}
          onClick={async () => {
            await props.onSave(prefix, nNum, nPad);
            setSaved(true);
            window.setTimeout(() => setSaved(false), 1400);
          }}
        >
          {saved ? 'Saved' : 'Set clip counter'}
        </button>
      </div>
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

function ExportBar(props: { project: Project }) {
  const [busy, setBusy] = useState<string | null>(null);

  async function run(kind: 'pdf' | 'xml' | 'csv') {
    setBusy(kind);
    try {
      const bundle = await store.getBundle(props.project.id);
      const base = slug(props.project.name);
      if (kind === 'pdf') {
        const blob = await exporter.toPdf(bundle);
        await shareBlob(blob, `${base}-log.pdf`, 'application/pdf');
      } else if (kind === 'xml') {
        const blob = exporter.toFcpXml(bundle);
        await shareBlob(blob, `${base}-log.xml`, 'text/xml');
      } else {
        const blob = exporter.toCsv(bundle);
        await shareBlob(blob, `${base}-log.csv`, 'text/csv');
      }
    } finally {
      setBusy(null);
    }
  }

  return (
    <section className="section">
      <div className="section__head">
        <span className="label">Hand off to editor</span>
      </div>
      <div className="formgrid" style={{ gridTemplateColumns: '1fr 1fr 1fr' }}>
        <button type="button" className="btn" disabled={busy !== null} onClick={() => void run('pdf')}>
          {busy === 'pdf' ? '...' : 'PDF'}
        </button>
        <button type="button" className="btn" disabled={busy !== null} onClick={() => void run('xml')}>
          {busy === 'xml' ? '...' : 'Premiere'}
        </button>
        <button type="button" className="btn" disabled={busy !== null} onClick={() => void run('csv')}>
          {busy === 'csv' ? '...' : 'CSV'}
        </button>
      </div>
    </section>
  );
}

function RenameSheet(props: { slate: Slate; onClose: () => void; onSave: (name: string) => void }) {
  const [name, setName] = useState(props.slate.name);
  return (
    <Sheet title="Rename slate" onClose={props.onClose}>
      <div className="formrow">
        <label className="label" htmlFor="rn-name">
          Slate name
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
