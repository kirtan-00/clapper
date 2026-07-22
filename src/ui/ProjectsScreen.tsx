import { useEffect, useRef, useState, type ChangeEvent } from 'react';
import type { Fps, Project } from '../types';
import { store } from '../store';
import { CAMERA_PRESETS, findPreset, renderClip, makeCameraUnit, UNIT_LETTERS } from './cameras';
import { Sheet, Confirm, Rail } from './common';
import { importScriptPack, EXAMPLE_PACKS, type ScriptPack } from './scriptpack';
import { extractPdfText } from './pdftext';
import { breakdownScript, SignInRequiredError } from './breakdown';
import { SignInSheet } from './SignInSheet';
import { ProCta } from './ProCta';
import { useSession, signInWithGoogle, signOut } from '../net/auth';
import { getUsage, FREE_LIMIT, type Usage } from '../net/quota';
import { track } from '../net/analytics';
import * as haptics from './haptics';

const FPS_OPTIONS: Fps[] = [23.976, 24, 25, 29.97, 30, 50, 59.94, 60];
// Normal-mode quick tags: the standard coverage a crew notes (WIDE/MID/CU/OTS/
// INSERT) plus the usual take-quality flags. Script Mode overrides these per
// scene with its own chips.
const DEFAULT_TAGS = ['WIDE', 'MID', 'CU', 'OTS', 'INSERT', 'GOLD', 'PICKUP', 'NOISE'];

// Feedback goes straight to the maker's inbox — Clapper is an early beta, so a
// prefilled mailto is enough. The body seeds the prompt; the trailing newlines
// drop the cursor onto a blank line ready to type.
const FEEDBACK_MAILTO =
  'mailto:purohit.krick@gmail.com?subject=' +
  encodeURIComponent('Clapper feedback') +
  '&body=' +
  encodeURIComponent(
    "Clapper is an early beta version for testing. Please share your feedback, and tell us: would you use a tool like this? What's missing?\n\n\n",
  );

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

      <div className="newproject-row">
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

        <button
          type="button"
          className="newproject newproject--ghost newproject--help"
          onClick={() => {
            haptics.tap();
            window.location.href = FEEDBACK_MAILTO;
          }}
        >
          <span aria-hidden="true">✉</span> Feedback
        </button>
      </div>

      <AccountRow />

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

      {showHelp && <HowToScreen onClose={() => setShowHelp(false)} />}

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

// Always-reachable account affordance on the home screen. Signing in is never
// forced: take logging + PDF export stay free and offline with no account. This
// just makes the door visible, explains what it unlocks, and captures the email
// (via the handle_new_user trigger) for the users who want the gated features.
function AccountRow() {
  const { session, loading } = useSession();
  const [busy, setBusy] = useState(false);

  async function onSignIn() {
    setBusy(true);
    try {
      await signInWithGoogle(); // redirects to Google; nothing after this runs on success
    } catch {
      setBusy(false); // only reached if the redirect never started
    }
  }

  if (loading) return null;

  if (session) {
    const email = session.user.email ?? 'your account';
    return (
      <>
        <p className="camnote" style={{ textAlign: 'center', marginTop: 18, marginBottom: 0 }}>
          Signed in as {email}
        </p>
        <button
          type="button"
          className="newproject newproject--ghost newproject--help"
          onClick={() => {
            haptics.tap();
            void signOut();
          }}
        >
          <span aria-hidden="true">←</span> Sign out
        </button>
      </>
    );
  }

  return (
    <>
      <button
        type="button"
        className="newproject newproject--ghost newproject--help"
        disabled={busy}
        onClick={() => {
          haptics.tap();
          void onSignIn();
        }}
      >
        <span aria-hidden="true">→</span> {busy ? 'Opening Google…' : 'Sign in with Google'}
      </button>
      <p className="camnote" style={{ textAlign: 'center', marginTop: 8, marginBottom: 0 }}>
        Sign in to unlock Script Mode and Premiere/CSV export. Logging takes and PDF export are
        always free. No account needed.
      </p>
    </>
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

  // Multi-cam. Default 1 keeps the single-cam flow above completely unchanged.
  // Units B/C/D derive their clip pattern from the chosen type; the operator
  // sets each one's starting number.
  const [camCount, setCamCount] = useState(1);
  const [units, setUnits] = useState<{ camera: string; start: string }[]>(() =>
    UNIT_LETTERS.map(() => ({ camera: 'sony', start: '1' })),
  );
  function setUnit(i: number, patch: Partial<{ camera: string; start: string }>) {
    setUnits((prev) => prev.map((u, idx) => (idx === i ? { ...u, ...patch } : u)));
  }

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
    const multi = camCount > 1;
    const cameras = multi
      ? units
          .slice(0, camCount)
          .map((u, i) => makeCameraUnit(UNIT_LETTERS[i], u.camera, Math.max(0, parseInt(u.start, 10) || 0)))
      : undefined;
    const unitA = cameras?.[0];
    // The top-level clip fields stay populated (from unit A in multi-cam) so
    // every legacy fallback and the Project contract keep working.
    const config = {
      name: name.trim(),
      fps,
      camera: unitA ? unitA.camera ?? camera : camera,
      clipPrefix: unitA ? unitA.clipPrefix : prefix,
      clipSuffix: unitA ? unitA.clipSuffix ?? '' : suffix,
      clipExt: unitA ? unitA.clipExt ?? '' : ext.trim(),
      nextClipNumber: unitA ? unitA.nextClipNumber : Math.max(0, parseInt(startNumber, 10) || 0),
      clipPadding: unitA ? unitA.clipPadding : Math.min(8, Math.max(1, parseInt(padding, 10) || 4)),
      ...(cameras ? { cameras } : {}),
      tags,
    };
    const project = props.pack
      ? await importScriptPack(props.pack, config)
      : await store.createProject(config);
    track('project_created', { mode: props.pack ? 'script' : 'normal', cameras: camCount });
    props.onCreated(project);
  }

  return (
    <Sheet title={props.pack ? 'Set up the shoot' : 'New project'} onClose={props.onClose}>
      {props.pack && (
        <p className="camnote" style={{ marginTop: 0 }}>
          {props.pack.scenes.length} scenes ready from your script. Set your camera and clip
          numbering, then start. The scenes load with their tap chips.
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

      {/* Cameras: 1 keeps the simple single-cam flow; 2-4 reveals per-unit setup. */}
      <div className="formrow">
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
        <>
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
        </>
      ) : (
        <>
          <div className="formrow">
            <label className="label" htmlFor="np-fps-multi">
              Frame rate
            </label>
            <select
              id="np-fps-multi"
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
          <div className="stack">
            {units.slice(0, camCount).map((u, i) => {
              const p = findPreset(u.camera);
              const n = Math.max(0, parseInt(u.start, 10) || 0);
              const eg = p ? renderClip(p.prefix, n, p.digits, p.suffix) + p.ext : '';
              return (
                <div key={UNIT_LETTERS[i]} className="camunit">
                  <div className="camunit__head">
                    <span className="camunit__badge">{UNIT_LETTERS[i]}</span>
                    <span className="camunit__eg tnum">
                      {UNIT_LETTERS[i]} · {eg}
                    </span>
                  </div>
                  <div className="formrow" style={{ margin: '12px 0 0' }}>
                    <label className="label" htmlFor={`np-cam-${i}`}>
                      Camera
                    </label>
                    <select
                      id={`np-cam-${i}`}
                      className="field"
                      value={u.camera}
                      onChange={(e) => setUnit(i, { camera: e.target.value })}
                    >
                      {CAMERA_PRESETS.map((cp) => (
                        <option key={cp.id} value={cp.id}>
                          {cp.label}
                        </option>
                      ))}
                    </select>
                  </div>
                  <div className="formrow" style={{ margin: '10px 0 0' }}>
                    <label className="label" htmlFor={`np-start-${i}`}>
                      Starting clip no.
                    </label>
                    <input
                      id={`np-start-${i}`}
                      className="field field--mono"
                      inputMode="numeric"
                      value={u.start}
                      onChange={(e) => setUnit(i, { start: e.target.value.replace(/[^0-9]/g, '') })}
                    />
                  </div>
                </div>
              );
            })}
          </div>
        </>
      )}

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

// Script Mode. The live path: a signed-in user uploads their script PDF; we
// extract the text on-device, send it to the breakdown edge function (Groq +
// quota, all server-side, identity from the JWT) and import the returned scene
// pack. Upload needs a free Google account; the two example breakdowns never
// hit the server, so anyone can feel the on-set flow signed out.
function ScriptPackSheet(props: { onClose: () => void; onPack: (pack: ScriptPack) => void }) {
  const { session, loading } = useSession();
  const [phase, setPhase] = useState<'idle' | 'reading' | 'thinking'>('idle');
  const [error, setError] = useState<string | null>(null);
  const [showSignIn, setShowSignIn] = useState(false);
  const [signingIn, setSigningIn] = useState(false);
  const [usage, setUsage] = useState<Usage | null>(null);
  // True once Script Mode is refused for being out of free uses — shows "go Pro".
  const [capped, setCapped] = useState(false);

  const busy = phase !== 'idle';
  const signedIn = !!session;

  useEffect(() => {
    if (!signedIn) {
      setUsage(null);
      return;
    }
    let active = true;
    void getUsage().then((u) => {
      if (active) setUsage(u);
    });
    return () => {
      active = false;
    };
  }, [signedIn]);

  async function onPickPdf(e: ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0];
    e.target.value = ''; // let the same file be picked again after an error
    if (!file) return;
    setError(null);
    setCapped(false);
    try {
      setPhase('reading');
      const text = await extractPdfText(file);
      if (text.trim().length < 40) {
        throw new Error('That PDF had no readable text. A scan or photo will not work. Use a text PDF.');
      }
      setPhase('thinking');
      const pack = await breakdownScript(text, file.name);
      if (!pack.scenes?.length) throw new Error('No scenes came back. Try a clearer script PDF.');
      haptics.tap();
      props.onPack(pack); // hand to the camera-setup step
    } catch (err) {
      setPhase('idle');
      if (err instanceof SignInRequiredError) {
        setShowSignIn(true);
        return;
      }
      if (err instanceof Error && err.message === 'CAP') {
        track('cap_hit', { which: 'script' });
        setError('Free limit reached. More coming soon.');
        setCapped(true);
        return;
      }
      setError(err instanceof Error ? err.message : 'Could not process that PDF.');
    }
  }

  function loadExample(pack: ScriptPack, which: string) {
    track('example_loaded', { which });
    haptics.tap();
    props.onPack(pack); // examples are bundled — no server, no account needed
  }

  async function startSignIn() {
    setSigningIn(true);
    setError(null);
    try {
      await signInWithGoogle(); // redirects to Google; nothing after this runs
    } catch {
      setError('Could not start sign-in. Check your connection and try again.');
      setSigningIn(false);
    }
  }

  // A gated (401) upload swaps the whole sheet for the dedicated sign-in sheet.
  if (showSignIn) return <SignInSheet onClose={props.onClose} />;

  return (
    <Sheet title="Script Mode" onClose={props.onClose}>
      <p className="camnote" style={{ marginTop: 0 }}>
        Upload your script as a PDF. We break it into scenes shot by shot, each with tappable
        coverage and key-moment chips, then load it as a project, so on set you just tap.
      </p>

      {loading ? (
        <div className="empty">Checking your account</div>
      ) : signedIn ? (
        <>
          <label className={`btn btn--go btn--full sp-upload${busy ? ' btn--disabled' : ''}`}>
            {phase === 'reading' ? 'Reading PDF…' : phase === 'thinking' ? 'Breaking down…' : 'Upload script PDF'}
            <input
              type="file"
              accept="application/pdf,.pdf"
              hidden
              disabled={busy}
              onChange={onPickPdf}
            />
          </label>
          {usage && (
            <p className="camnote" style={{ textAlign: 'center', marginBottom: 0 }}>
              {usage.script.left} of {FREE_LIMIT} Script Mode uses left
            </p>
          )}
        </>
      ) : (
        <>
          <button
            type="button"
            className="btn btn--go btn--full"
            disabled={signingIn}
            onClick={() => void startSignIn()}
          >
            {signingIn ? 'Opening Google…' : 'Sign in with Google to upload'}
          </button>
          <p className="camnote" style={{ marginBottom: 0 }}>
            Script Mode needs a free account. The examples below work without one.
          </p>
        </>
      )}

      {error && (
        <span className="tnum tnum--bad sp-error">
          {error}
        </span>
      )}
      {capped && <ProCta gate="script" />}

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
            onClick={() => loadExample(ex.pack, ex.key)}
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

// The full-window guide. Not a sheet: this is documentation a crew member
// reads standing up, one-handed, in daylight, so it gets the whole viewport,
// its own scroller, a sticky header and jump chips.
const GUIDE_NAV: { id: string; label: string }[] = [
  { id: 'g-what', label: 'What it is' },
  { id: 'g-handoff', label: 'The handoff' },
  { id: 'g-setup', label: 'Setup' },
  { id: 'g-onset', label: 'On set' },
  { id: 'g-status', label: 'Discard vs delete' },
  { id: 'g-fix', label: 'Fixing a number' },
  { id: 'g-cams', label: 'Two to four cams' },
  { id: 'g-voice', label: 'Voice' },
  { id: 'g-out', label: 'Exports' },
];

function HowToScreen(props: { onClose: () => void }) {
  const scrollRef = useRef<HTMLDivElement>(null);
  const { onClose } = props;

  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      if (e.key === 'Escape') onClose();
    }
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);

  function jump(id: string) {
    const el = scrollRef.current?.querySelector(`#${id}`);
    if (el) el.scrollIntoView({ behavior: 'smooth', block: 'start' });
  }

  return (
    <div className="guide" role="dialog" aria-modal="true" aria-label="How Clapper works">
      <div className="guide__bar">
        <div className="guide__barrow">
          <button
            type="button"
            className="guide__close"
            aria-label="Close the guide"
            onClick={() => {
              haptics.tap();
              onClose();
            }}
          >
            <span aria-hidden="true">←</span>
          </button>
          <div className="guide__mark" aria-hidden="true">
            <span />
            <span />
          </div>
          <h2 className="guide__title">How Clapper works</h2>
        </div>
        <div className="guide__nav">
          {GUIDE_NAV.map((n) => (
            <button
              key={n.id}
              type="button"
              className="guide__navchip"
              onClick={() => jump(n.id)}
            >
              {n.label}
            </button>
          ))}
        </div>
      </div>

      <div className="guide__scroll" ref={scrollRef}>
        <div className="guide__inner">
          {/* 1 ---------------------------------------------------------- */}
          <section className="gsec" id="g-what">
            <p className="gsec__num tnum">01</p>
            <h3 className="gsec__h">What Clapper is</h3>
            <p className="gsec__lede">
              Your shot list and your timecode report in the same document, built as you shoot
              instead of typed up afterwards.
            </p>
            <p>
              A TCR is only worth something if the clip numbers in it are right. One wrong number
              and the editor stops trusting the whole page, then goes back to opening card folders
              by hand.
            </p>
            <p>
              On paper you hand-write the camera’s clip number for every single take. Hundreds of
              numbers a day, read off a monitor, in the dark, between setups. Clapper assigns them
              instead. You never write one down.
            </p>

            <div className="grule">
              <p className="grule__label">The one rule</p>
              <p className="grule__big">
                Hit ROLL every time the camera rolls. Every single time.
              </p>
              <p>
                Clapper cannot see the camera. It counts. It assumes the file the camera just wrote
                is the next number after the last one, so its count and the camera’s count only stay
                together if you press ROLL exactly as often as the camera does.
              </p>
              <p>
                Camera rolled by accident? Still ROLL, then CUT, then <b>Discard</b>. The camera
                wrote a file either way, so the number has to get used up either way. Discarding
                uses it up and moves the count on. Skipping the roll does not, and every clip number
                after that is wrong.
              </p>
            </div>
          </section>

          {/* 2 ---------------------------------------------------------- */}
          <section className="gsec" id="g-handoff">
            <p className="gsec__num tnum">02</p>
            <h3 className="gsec__h">What the editor gets</h3>
            <p className="gsec__lede">
              Export Premiere (FCP XML), hand it over, and the day opens as one timeline with the
              work already sorted.
            </p>
            <ol className="gflow">
              <li>
                <b>First, the assembly.</b> The good takes laid end to end in story order, scene by
                scene, take by take.
              </li>
              <li>
                <b>Then a gap.</b> Three seconds of air so the two halves never read as one cut.
              </li>
              <li>
                <b>Then every clip again</b>, scene by scene, the rejected ones included. The selects
                pool, parked behind the cut in the same sequence.
              </li>
            </ol>
            <p>
              Nothing is lost. The editor gets a first assembly to look at and every alternate take
              sitting right behind it, without going near a card.
            </p>
            <p>
              Every chip you tapped on set arrives as a marker on the clip it happened in. The media
              comes in offline and relinks by filename plus extension, which is why the extension
              field in setup matters.
            </p>
            <p className="gnote">
              The selects pool ships on projects with two or more cameras. A single-camera export is
              the story cut only.
            </p>
          </section>

          {/* 3 ---------------------------------------------------------- */}
          <section className="gsec" id="g-setup">
            <p className="gsec__num tnum">03</p>
            <h3 className="gsec__h">Before you roll: sixty seconds</h3>
            <p className="gsec__lede">
              Clip-number errors are born here, at the trolley, not out on the floor.
            </p>
            <p>
              <b>Starting clip no.</b> Set it to what is actually in the camera right now. Not 1.
              Read the last file on the card and enter the next number.
            </p>
            <p>
              <b>Camera.</b> Picking your camera fills in the prefix, the number of digits and the
              file extension. Check all three against a real file. C0001 and C001 are different
              names and will not relink.
            </p>
            <p>
              <b>Frame rate.</b> Set it to what the camera is shooting. It is what the exported
              timeline is built at.
            </p>
            <p className="gnote">
              iPhone: IMG_ numbers are shared with your photo roll, so they skip and cannot be
              predicted. Set the start from real footage and expect to correct numbers during the
              day.
            </p>
          </section>

          {/* 4 ---------------------------------------------------------- */}
          <section className="gsec" id="g-onset">
            <p className="gsec__num tnum">04</p>
            <h3 className="gsec__h">On set</h3>
            <p>
              Tap the scene, then hit the big <b>ROLL</b>. The number on screen is elapsed shot
              length: Clapper cannot read the camera’s clock, so it times the take rather than
              pretend to know its timecode.
            </p>
            <p>
              While it runs, tap what you see. Coverage chips <b>WIDE · MID · CU · OTS · INSERT</b>,{' '}
              <b>GOLD</b> for the keeper, plus PICKUP and NOISE. <b>MARK IN</b> then{' '}
              <b>MARK OUT</b> flags a range instead of a point. Each tap lands at the second it
              happened, and nothing needs typing.
            </p>
            <p>
              <b>CUT.</b> Clapper stamps the clip number and asks you to keep or discard. You can
              add the camera timecode and a one-line note on the same screen.
            </p>
            <p>
              Shoot in any order. A <span className="gdot gdot--done" /> green dot marks a scene in
              the can, a <span className="gdot" /> dim dot marks what is left, and the header keeps
              a running “X / Y in the can”.
            </p>
            <p>
              <b>Script Mode.</b> Upload the script PDF and Clapper breaks it into scenes with their
              own tap chips, so instead of generic coverage you are tapping “door slams” and “she
              turns”.
            </p>
            <p className="gnote">
              The screen holds itself awake the whole time you are on a scene, so it will not lock
              between takes.
            </p>
          </section>

          {/* 5 ---------------------------------------------------------- */}
          <section className="gsec" id="g-status">
            <p className="gsec__num tnum">05</p>
            <h3 className="gsec__h">Discard is not delete</h3>
            <p className="gsec__lede">
              One question sorts it: is there a file on the card? If there is, discard it. If there
              is nothing on the card, delete it.
            </p>
            <div className="gsplit">
              <div className="gsplit__half">
                <p className="gsplit__k gsplit__k--keep">Discard</p>
                <p>
                  There is a file. The camera rolled and wrote it, the take was just no good. It
                  keeps its clip number, prints on the PDF struck through in the discarded list, and
                  still reaches the editor in the selects pool of a multi-camera XML.
                </p>
                <p>Flubbed take, false start, a roll nobody meant to make.</p>
              </div>
              <div className="gsplit__half">
                <p className="gsplit__k gsplit__k--kill">Delete</p>
                <p>
                  There is no file. You logged something that never happened: a double tap, or the
                  same shot logged twice. Delete removes the row and every moment tagged in it.
                </p>
                <p>
                  It does not renumber anything by itself. After deleting a phantom row, open the
                  next shot on that camera and set its clip number to what the card actually says.
                  Every later shot follows it down.
                </p>
              </div>
            </div>
            <p className="gnote">
              The two mistakes cost different things. Discard a shot the camera never wrote and
              every number after it is off by one. Delete a shot the camera did write and the
              numbers survive, but that clip disappears from the report and the editor never hears
              about it. Go by the card.
            </p>
          </section>

          {/* 6 ---------------------------------------------------------- */}
          <section className="gsec" id="g-fix">
            <p className="gsec__num tnum">06</p>
            <h3 className="gsec__h">When a number goes wrong</h3>
            <p>
              Open the shot and correct its clip number. Clapper shifts every <b>later</b> shot on
              that camera by the same amount, and moves the live counter with them, because the
              camera kept counting while you were wrong.
            </p>
            <p>Earlier shots never move.</p>
            <p>
              It shifts rather than resequences, so deliberate gaps survive: a stretch where the
              camera rolled and Clapper did not stays a gap instead of being closed up.
            </p>
            <p>
              Per camera. Fixing B never disturbs A, C or D. You can also correct the live clip
              number straight from the roll screen header.
            </p>
          </section>

          {/* 7 ---------------------------------------------------------- */}
          <section className="gsec" id="g-cams">
            <p className="gsec__num tnum">07</p>
            <h3 className="gsec__h">Two to four cameras</h3>
            <p className="gsec__lede">
              Pick 1 to 4 cameras when you make the project. Units are lettered A to D.
            </p>
            <p>
              Every unit carries its own independent clip counter and advances on its own at every
              CUT. Set each one’s starting number and camera type separately.
            </p>
            <p>
              Two identical bodies both writing <span className="tnum">C0001.MP4</span> is fine and
              expected. The unit letter travels in the XML as the FCP7 reel/tape name, so the
              editor’s clips still relink to the right card. Nobody has to rename anything.
            </p>
            <p>
              In the timeline each camera is a synced picture and sound pair on its own track pair,
              V1/A1 for A, V2/A2 for B and so on, dropped at the same position, so it multicam-cuts
              straight away.
            </p>
            <p className="gnote">
              A tapped chip belongs to the take, not to one angle, so it rides on camera A’s
              picture.
            </p>
          </section>

          {/* 8 ---------------------------------------------------------- */}
          <section className="gsec" id="g-voice">
            <p className="gsec__num tnum">08</p>
            <h3 className="gsec__h">Voice, when your hands are full</h3>
            <p>
              Tap the mic on the roll screen and Clapper listens for the slate. It appears only on
              browsers that support speech recognition.
            </p>
            <dl className="gsay">
              <dt>Starts a take</dt>
              <dd>“roll” · “rolling” · “roll camera” · “camera roll”</dd>
              <dt>Stops it</dt>
              <dd>“cut” · “cut it”</dd>
            </dl>
            <p className="gnote">
              It matches the word anywhere in the sentence. While a take is rolling, someone saying
              “cut” in conversation will stop it. Turn the mic off if the room talks over takes.
            </p>
          </section>

          {/* 9 ---------------------------------------------------------- */}
          <section className="gsec" id="g-out">
            <p className="gsec__num tnum">09</p>
            <h3 className="gsec__h">Three exports, three readers</h3>
            <dl className="gsay gsay--wide">
              <dt>Premiere (FCP XML)</dt>
              <dd>
                For the editor. The assembly, the selects, and every tap as a timeline marker.
              </dd>
              <dt>PDF shot log</dt>
              <dd>
                For production and the director. Scenes, shots, clip numbers, durations, camera TC
                and wall clock, a GOLD summary at the front and the discarded shots at the back.
              </dd>
              <dt>CSV</dt>
              <dd>
                For anyone who wants the data. One row per tapped moment, plus a row per take so
                takes with no moments still appear.
              </dd>
            </dl>
            <p>
              Everything lives on the phone. Logging shots and PDF export need no account and no
              signal. Script Mode and the Premiere/CSV exports need a free Google sign-in.
            </p>
          </section>

          <div className="rail rail--thin guide__tail" aria-hidden="true" />

          <button type="button" className="btn btn--go btn--full" onClick={onClose}>
            Back to projects
          </button>
        </div>
      </div>
    </div>
  );
}
