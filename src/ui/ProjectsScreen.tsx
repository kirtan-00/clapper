import { useEffect, useState, type ChangeEvent } from 'react';
import type { Fps, Project } from '../types';
import { store } from '../store';
import { CAMERA_PRESETS, findPreset, renderClip } from './cameras';
import { Sheet, Confirm, Rail } from './common';
import { importScriptPack, EXAMPLE_PACKS, type ScriptPack } from './scriptpack';
import { extractPdfText } from './pdftext';
import { breakdownScript, EMAIL_RE } from './breakdown';
import * as haptics from './haptics';

const FPS_OPTIONS: Fps[] = [23.976, 24, 25, 29.97, 30, 50, 59.94, 60];
// Normal-mode quick tags: the standard coverage a crew notes (WIDE/MID/CU/OTS/
// INSERT) plus the usual take-quality flags. Script Mode overrides these per
// scene with its own chips.
const DEFAULT_TAGS = ['WIDE', 'MID', 'CU', 'OTS', 'INSERT', 'GOLD', 'PICKUP', 'NOISE'];

interface Row {
  project: Project;
  takeCount: number;
}

function fmtDate(ms: number): string {
  return new Date(ms).toLocaleDateString(undefined, {
    day: 'numeric',
    month: 'short',
    year: 'numeric',
  });
}

export function ProjectsScreen(props: { onOpen: (project: Project) => void }) {
  const [rows, setRows] = useState<Row[] | null>(null);
  const [creating, setCreating] = useState(false);
  const [loadingScript, setLoadingScript] = useState(false);
  const [pendingPack, setPendingPack] = useState<ScriptPack | null>(null);
  const [showHelp, setShowHelp] = useState(false);
  const [deleting, setDeleting] = useState<Project | null>(null);

  async function refresh() {
    const projects = await store.listProjects();
    projects.sort((a, b) => b.createdAt - a.createdAt);
    const withCounts = await Promise.all(
      projects.map(async (project) => {
        const bundle = await store.getBundle(project.id);
        return { project, takeCount: bundle.takes.length };
      }),
    );
    setRows(withCounts);
  }

  useEffect(() => {
    void refresh();
  }, []);

  return (
    <div className="app">
      <header className="masthead">
        <div className="masthead__mark" aria-hidden="true">
          <span />
          <span />
        </div>
        <div>
          <h1>Clapper</h1>
          <p>On-set shot log</p>
        </div>
      </header>

      {rows === null ? (
        <div className="empty">Loading projects</div>
      ) : rows.length === 0 ? (
        <div className="empty">
          <b>No projects yet</b>
          Start one for your shoot day. Set the frame rate and clip numbering once, then just
          roll.
        </div>
      ) : (
        <div className="stack">
          {rows.map(({ project, takeCount }) => (
            <button
              key={project.id}
              type="button"
              className="card"
              onClick={() => props.onOpen(project)}
            >
              <div className="card__row">
                <span className="card__name">{project.name}</span>
                <span className="card__count">{takeCount}</span>
              </div>
              <div className="card__meta">
                <span>{fmtDate(project.createdAt)}</span>
                <span>
                  <b>{project.fps}</b> fps
                </span>
                <span>
                  {takeCount === 1 ? '1 shot' : `${takeCount} shots`}
                </span>
                <span
                  className="iconbtn"
                  role="button"
                  tabIndex={0}
                  aria-label={`Delete ${project.name}`}
                  style={{ marginLeft: 'auto', minHeight: 32, minWidth: 32 }}
                  onClick={(e) => {
                    e.stopPropagation();
                    setDeleting(project);
                  }}
                  onKeyDown={(e) => {
                    if (e.key === 'Enter' || e.key === ' ') {
                      e.preventDefault();
                      e.stopPropagation();
                      setDeleting(project);
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

      <button
        type="button"
        className="newproject"
        onClick={() => {
          haptics.tap();
          setCreating(true);
        }}
      >
        <span aria-hidden="true">+</span> New project
      </button>

      <button
        type="button"
        className="newproject newproject--ghost"
        onClick={() => {
          haptics.tap();
          setLoadingScript(true);
        }}
      >
        <span aria-hidden="true">≡</span> Script Mode · from a PDF
      </button>

      <button
        type="button"
        className="newproject newproject--ghost newproject--help"
        onClick={() => {
          haptics.tap();
          setShowHelp(true);
        }}
      >
        <span aria-hidden="true">?</span> How to use
      </button>

      <div style={{ marginTop: 22 }}>
        <Rail thin />
      </div>

      {creating && (
        <CreateProjectSheet
          onClose={() => setCreating(false)}
          onCreated={(project) => {
            setCreating(false);
            props.onOpen(project);
          }}
        />
      )}

      {loadingScript && (
        <ScriptPackSheet
          onClose={() => setLoadingScript(false)}
          onPack={(pack) => {
            setLoadingScript(false);
            setPendingPack(pack);
          }}
        />
      )}

      {pendingPack && (
        <CreateProjectSheet
          pack={pendingPack}
          initialName={pendingPack.project.name}
          onClose={() => setPendingPack(null)}
          onCreated={(project) => {
            setPendingPack(null);
            props.onOpen(project);
          }}
        />
      )}

      {showHelp && <HowToSheet onClose={() => setShowHelp(false)} />}

      {deleting && (
        <Confirm
          title={`Delete ${deleting.name}?`}
          message="This removes the project and every scene, shot, and moment in it. This cannot be undone."
          confirmLabel="Delete project"
          onCancel={() => setDeleting(null)}
          onConfirm={async () => {
            await store.deleteProject(deleting.id);
            setDeleting(null);
            void refresh();
          }}
        />
      )}
    </div>
  );
}

function CreateProjectSheet(props: {
  onClose: () => void;
  onCreated: (project: Project) => void;
  pack?: ScriptPack; // when set, create + import this script pack instead of a blank project
  initialName?: string;
}) {
  const [name, setName] = useState(props.initialName ?? '');
  const [fps, setFps] = useState<Fps>(24);
  const [camera, setCamera] = useState('custom');
  const [prefix, setPrefix] = useState('C');
  const [suffix, setSuffix] = useState('');
  const [startNumber, setStartNumber] = useState('1');
  const [padding, setPadding] = useState('4');
  const [ext, setExt] = useState('.MP4');
  const [tags, setTags] = useState<string[]>(DEFAULT_TAGS);
  const [tagDraft, setTagDraft] = useState('');
  const [busy, setBusy] = useState(false);

  const canCreate = name.trim().length > 0 && !busy;
  const preset = findPreset(camera);
  const exampleNumber = Math.max(0, parseInt(startNumber, 10) || 0);
  const exampleDigits = Math.min(8, Math.max(1, parseInt(padding, 10) || 4));
  const example = renderClip(prefix, exampleNumber, exampleDigits, suffix);

  function pickCamera(id: string) {
    setCamera(id);
    const p = findPreset(id);
    if (!p) return;
    setPrefix(p.prefix);
    setSuffix(p.suffix);
    setPadding(String(p.digits));
    setExt(p.ext);
  }

  function addTag() {
    const t = tagDraft.trim().toUpperCase();
    if (t && !tags.includes(t)) setTags([...tags, t]);
    setTagDraft('');
  }

  async function create() {
    if (!canCreate) return;
    setBusy(true);
    const config = {
      name: name.trim(),
      fps,
      camera,
      clipPrefix: prefix,
      clipSuffix: suffix,
      clipExt: ext.trim(),
      nextClipNumber: Math.max(0, parseInt(startNumber, 10) || 0),
      clipPadding: Math.min(8, Math.max(1, parseInt(padding, 10) || 4)),
      tags,
    };
    const project = props.pack
      ? await importScriptPack(props.pack, config)
      : await store.createProject(config);
    props.onCreated(project);
  }

  return (
    <Sheet title={props.pack ? 'Set up the shoot' : 'New project'} onClose={props.onClose}>
      {props.pack && (
        <p className="camnote" style={{ marginTop: 0 }}>
          {props.pack.scenes.length} scenes ready from your script. Set your camera and clip
          numbering, then start — the scenes load with their tap chips.
        </p>
      )}
      <div className="formrow">
        <label className="label" htmlFor="np-name">
          Project name
        </label>
        <input
          id="np-name"
          className="field"
          value={name}
          autoFocus
          placeholder="Day 3 - Interior Cafe"
          onChange={(e) => setName(e.target.value)}
        />
      </div>

      <div className="formrow">
        <label className="label" htmlFor="np-camera">
          Camera
        </label>
        <select
          id="np-camera"
          className="field"
          value={camera}
          onChange={(e) => pickCamera(e.target.value)}
        >
          {CAMERA_PRESETS.map((p) => (
            <option key={p.id} value={p.id}>
              {p.label}
            </option>
          ))}
        </select>
        <div className="campreview">
          <span className="campreview__eg">
            <span className="label">Links in Premiere as</span>
            <span className="tnum">{example}{ext}</span>
          </span>
          <span className={`cambadge${preset && !preset.exact ? ' cambadge--approx' : ''}`}>
            {preset && !preset.exact ? 'approximate' : 'exact'}
          </span>
        </div>
        {preset?.note && <p className="camnote">{preset.note}</p>}
      </div>

      <div className="formgrid">
        <div className="formrow">
          <label className="label" htmlFor="np-fps">
            Frame rate
          </label>
          <select
            id="np-fps"
            className="field"
            value={fps}
            onChange={(e) => setFps(parseFloat(e.target.value) as Fps)}
          >
            {FPS_OPTIONS.map((f) => (
              <option key={f} value={f}>
                {f} fps
              </option>
            ))}
          </select>
        </div>
        <div className="formrow">
          <label className="label" htmlFor="np-prefix">
            Clip prefix
          </label>
          <input
            id="np-prefix"
            className="field field--mono"
            value={prefix}
            placeholder="C"
            onChange={(e) => setPrefix(e.target.value)}
          />
        </div>
      </div>

      <div className="formgrid">
        <div className="formrow">
          <label className="label" htmlFor="np-start">
            Starting clip no.
          </label>
          <input
            id="np-start"
            className="field field--mono"
            inputMode="numeric"
            value={startNumber}
            onChange={(e) => setStartNumber(e.target.value.replace(/[^0-9]/g, ''))}
          />
        </div>
        <div className="formrow">
          <label className="label" htmlFor="np-pad">
            Number digits
          </label>
          <input
            id="np-pad"
            className="field field--mono"
            inputMode="numeric"
            value={padding}
            onChange={(e) => setPadding(e.target.value.replace(/[^0-9]/g, ''))}
          />
        </div>
        <div className="formrow">
          <label className="label" htmlFor="np-ext">
            File extension
          </label>
          <input
            id="np-ext"
            className="field field--mono"
            placeholder=".MP4"
            value={ext}
            onChange={(e) => setExt(e.target.value)}
          />
        </div>
      </div>

      <div className="formrow">
        <span className="label">Quick tags</span>
        <div className="chips">
          {tags.map((t) => (
            <span key={t} className={`chip chip--removable${t === 'GOLD' ? ' chip--gold' : ''}`}>
              {t}
              <button
                type="button"
                className="chip__x"
                aria-label={`Remove tag ${t}`}
                onClick={() => setTags(tags.filter((x) => x !== t))}
              >
                &times;
              </button>
            </span>
          ))}
        </div>
        <div className="addline">
          <input
            className="field field--mono"
            value={tagDraft}
            placeholder="Add tag"
            onChange={(e) => setTagDraft(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter') {
                e.preventDefault();
                addTag();
              }
            }}
          />
          <button type="button" className="btn" onClick={addTag}>
            Add
          </button>
        </div>
      </div>

      <div className="sheet__actions">
        <button type="button" className="btn btn--ghost" onClick={props.onClose}>
          Cancel
        </button>
        <button type="button" className="btn btn--go" disabled={!canCreate} onClick={create}>
          {props.pack ? 'Start shoot' : 'Create project'}
        </button>
      </div>
    </Sheet>
  );
}

// Script Mode. The live path: a user gives a valid email and uploads their
// script PDF; we extract the text on-device, send it to the breakdown edge
// function (Groq, key server-side) and import the returned scene pack. Two
// example breakdowns let anyone feel the on-set flow without a script.
function ScriptPackSheet(props: { onClose: () => void; onPack: (pack: ScriptPack) => void }) {
  const [email, setEmail] = useState('');
  const [phase, setPhase] = useState<'idle' | 'reading' | 'thinking'>('idle');
  const [error, setError] = useState<string | null>(null);

  const busy = phase !== 'idle';
  const emailOk = EMAIL_RE.test(email.trim());

  async function onPickPdf(e: ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0];
    e.target.value = ''; // let the same file be picked again after an error
    if (!file) return;
    if (!emailOk) {
      setError('Enter a valid email first.');
      return;
    }
    setError(null);
    try {
      setPhase('reading');
      const text = await extractPdfText(file);
      if (text.trim().length < 40) {
        throw new Error('That PDF had no readable text — a scan/photo will not work. Use a text PDF.');
      }
      setPhase('thinking');
      const pack = await breakdownScript(email.trim().toLowerCase(), text, file.name);
      if (!pack.scenes?.length) throw new Error('No scenes came back — try a clearer script PDF.');
      haptics.tap();
      props.onPack(pack); // hand to the camera-setup step
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not process that PDF.');
      setPhase('idle');
    }
  }

  function loadExample(pack: ScriptPack) {
    haptics.tap();
    props.onPack(pack);
  }

  return (
    <Sheet title="Script Mode" onClose={props.onClose}>
      <p className="camnote" style={{ marginTop: 0 }}>
        Upload your script as a PDF. We break it into scenes shot by shot — each with tappable
        coverage and key-moment chips — and load it as a project, so on set you just tap.
      </p>

      <div className="formrow">
        <label className="label" htmlFor="sp-email">
          Your email
        </label>
        <input
          id="sp-email"
          className="field"
          type="email"
          inputMode="email"
          autoCapitalize="off"
          autoComplete="email"
          placeholder="you@studio.com"
          value={email}
          disabled={busy}
          onChange={(e) => setEmail(e.target.value)}
        />
      </div>

      <label className={`btn btn--go btn--full sp-upload${!emailOk || busy ? ' btn--disabled' : ''}`}>
        {phase === 'reading' ? 'Reading PDF…' : phase === 'thinking' ? 'Breaking down…' : 'Upload script PDF'}
        <input
          type="file"
          accept="application/pdf,.pdf"
          hidden
          disabled={!emailOk || busy}
          onChange={onPickPdf}
        />
      </label>

      {error && (
        <span className="tnum tnum--bad sp-error">
          {error}
        </span>
      )}

      <div className="sp-or">
        <span>or try an example</span>
      </div>

      <div className="formgrid" style={{ gridTemplateColumns: '1fr 1fr' }}>
        {EXAMPLE_PACKS.map((ex) => (
          <button
            key={ex.key}
            type="button"
            className="btn sp-example"
            disabled={busy}
            onClick={() => void loadExample(ex.pack)}
          >
            <b>{ex.label}</b>
            <span>{ex.blurb}</span>
          </button>
        ))}
      </div>

      <div className="sheet__actions">
        <button type="button" className="btn btn--ghost" onClick={props.onClose} disabled={busy}>
          Close
        </button>
      </div>
    </Sheet>
  );
}

function HowToSheet(props: { onClose: () => void }) {
  return (
    <Sheet title="How Clapper works" onClose={props.onClose}>
      <div className="howto">
        <section>
          <h4>Log every shot with one tap</h4>
          <p>
            Hit the big ROLL when the camera rolls, CUT when it stops (or just say “roll” / “cut”).
            The timer is your shot length. Tap a chip the instant something happens — it becomes a
            marker the editor jumps straight to.
          </p>
        </section>
        <section>
          <h4>Normal mode — you build the scenes</h4>
          <p>
            Add a scene, then on set tap the coverage as you get it: <b>WIDE · MID · CU · OTS ·
            INSERT</b>, plus <b>GOLD</b> for the keeper. MARK IN / OUT flags a range. Nothing to type.
          </p>
        </section>
        <section>
          <h4>Script Mode — the script builds them for you</h4>
          <p>
            Upload your script PDF. We break it into scenes shot by shot, each with its own tappable
            beats (“door slams”, “she turns”). You just tap the beat as it happens.
          </p>
        </section>
        <section>
          <h4>Shoot in any order, see what’s done</h4>
          <p>
            Shot 1 first, then 3, then 2? A <span className="howto-dot howto-dot--done" /> green dot
            marks scenes in the can, a <span className="howto-dot" /> dim dot marks what’s left. The
            header keeps a running “X / Y in the can”.
          </p>
        </section>
        <section>
          <h4>Timecode on set</h4>
          <p>
            The big number is elapsed shot length — Clapper can’t read the camera’s clock. After CUT
            you can type the camera timecode and a note, so the editor matches by TC later.
          </p>
        </section>
        <section>
          <h4>Hand off to the editor</h4>
          <p>
            <b>Premiere (FCP XML):</b> good takes laid in order, every tap as a timeline marker,
            footage relinks by filename + extension. Plus a <b>PDF</b> shot log (GOLD highlighted)
            and <b>CSV</b>.
          </p>
        </section>
      </div>
      <div className="sheet__actions">
        <button type="button" className="btn btn--go btn--full" onClick={props.onClose}>
          Got it
        </button>
      </div>
    </Sheet>
  );
}
