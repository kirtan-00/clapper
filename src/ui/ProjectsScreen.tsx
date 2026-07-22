import { useEffect, useState, type ChangeEvent } from 'react';
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

function HowToSheet(props: { onClose: () => void }) {
  return (
    <Sheet title="How Clapper works" onClose={props.onClose}>
      <div className="howto">
        <section>
          <h4>Log every shot with one tap</h4>
          <p>
            Hit the big ROLL when the camera rolls, CUT when it stops (or just say “roll” / “cut”).
            The timer is your shot length. Tap a chip the instant something happens and it becomes a
            marker the editor jumps straight to.
          </p>
        </section>
        <section>
          <h4>Normal mode: you build the scenes</h4>
          <p>
            Add a scene, then tap it to begin rolling. On set, tap the coverage as you get it: <b>WIDE · MID · CU · OTS ·
            INSERT</b>, plus <b>GOLD</b> for the keeper. MARK IN / OUT flags a range. Nothing to type.
          </p>
        </section>
        <section>
          <h4>Script Mode: the script builds them for you</h4>
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
            The big number is elapsed shot length, since Clapper can’t read the camera’s clock. After CUT
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
