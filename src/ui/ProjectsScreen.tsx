import { useEffect, useRef, useState, type ChangeEvent } from 'react';
import type { Fps, Project } from '../types';
import { store } from '../store';
import { CAMERA_PRESETS, findPreset, renderClip, makeCameraUnit, UNIT_LETTERS } from './cameras';
import { Sheet, Confirm, Rail } from './common';
import { importScriptPack, EXAMPLE_PACKS, type ScriptPack } from './scriptpack';
import { extractPdfText } from './pdftext';
import { parseShotlist, shotlistToPack } from './shotlist';
import { enrichShotMoments, SignInRequiredError } from './breakdown';
import { SignInSheet } from './SignInSheet';
import { ProCta } from './ProCta';
import InstallNudge from './InstallNudge';
import { useSession, signInWithGoogle, signOut } from '../net/auth';
import { getUsage, FREE_LIMIT, type Usage } from '../net/quota';
import { track } from '../net/analytics';
import * as haptics from './haptics';

const FPS_OPTIONS: Fps[] = [23.976, 24, 25, 29.97, 30, 50, 59.94, 60];
// Normal-mode quick tags: the standard coverage a crew notes (WIDE/MID/CU/OTS/
// INSERT) plus the usual take-quality flags. Script Mode overrides these per
// scene with its own chips.
const DEFAULT_TAGS = ['WIDE', 'MID', 'CU', 'OTS', 'INSERT', 'GOLD', 'PICKUP', 'NOISE'];

// Production sound's badge accent - same cool blue RollingScreen uses for the
// Sound roll control, applied inline on the shared .camunit__badge here too
// (styling stays scoped to src/ui/, not the shared stylesheet).
const soundBadgeStyle = {
  color: 'var(--sound)',
  background: 'color-mix(in srgb, var(--sound) 16%, var(--ink-800))',
  borderColor: 'color-mix(in srgb, var(--sound) 45%, transparent)',
};

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

      <InstallNudge />

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
                  {takeCount === 1 ? '1 take' : `${takeCount} takes`}
                </span>
                <span
                  className="rowdel"
                  role="button"
                  tabIndex={0}
                  aria-label={`Delete ${project.name}`}
                  style={{ marginLeft: 'auto' }}
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
                  Delete
                </span>
              </div>
            </button>
          ))}
        </div>
      )}

      <button
        type="button"
        className="newproject newproject--primary"
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
        <span aria-hidden="true">≡</span> Shotlist · from a PDF
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
          message="This removes the project and every scene, shot, take and moment in it. This cannot be undone."
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
        Sign in to unlock shotlist import and Premiere/CSV export. Logging takes and PDF export are
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
  const [units, setUnits] = useState<{ camera: string; start: string; operator: string }[]>(() =>
    UNIT_LETTERS.map(() => ({ camera: 'sony', start: '1', operator: '' })),
  );
  function setUnit(i: number, patch: Partial<{ camera: string; start: string; operator: string }>) {
    setUnits((prev) => prev.map((u, idx) => (idx === i ? { ...u, ...patch } : u)));
  }

  // Production sound. Off by default (every project keeps working with no
  // sound at all, exactly as before); ON writes an orthogonal Sound unit -
  // it exists independent of camera count, single- or multi-cam alike.
  const [soundOn, setSoundOn] = useState(false);
  const [soundOperator, setSoundOperator] = useState('');
  const [soundRecorder, setSoundRecorder] = useState('');
  const [soundPrefix, setSoundPrefix] = useState('SND_');
  const [soundStart, setSoundStart] = useState('1');
  const [soundPadding, setSoundPadding] = useState('4');
  const [soundExt, setSoundExt] = useState('.WAV');

  const canCreate = name.trim().length > 0 && !busy;
  const preset = findPreset(camera);
  const exampleNumber = Math.max(0, parseInt(startNumber, 10) || 0);
  const exampleDigits = Math.min(8, Math.max(1, parseInt(padding, 10) || 4));
  const example = renderClip(prefix, exampleNumber, exampleDigits, suffix);
  const soundExampleNumber = Math.max(0, parseInt(soundStart, 10) || 0);
  const soundExampleDigits = Math.min(8, Math.max(1, parseInt(soundPadding, 10) || 4));
  const soundExample = renderClip(soundPrefix, soundExampleNumber, soundExampleDigits, '');

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
          .map((u, i) =>
            makeCameraUnit(UNIT_LETTERS[i], u.camera, Math.max(0, parseInt(u.start, 10) || 0), u.operator),
          )
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
      ...(soundOn
        ? {
            sound: {
              filePrefix: soundPrefix,
              nextFileNumber: Math.max(0, parseInt(soundStart, 10) || 0),
              filePadding: Math.min(8, Math.max(1, parseInt(soundPadding, 10) || 4)),
              fileExt: soundExt.trim(),
              ...(soundRecorder.trim() ? { recorder: soundRecorder.trim() } : {}),
              ...(soundOperator.trim() ? { operator: soundOperator.trim() } : {}),
            },
          }
        : {}),
      tags,
    };
    const project = props.pack
      ? await importScriptPack(props.pack, config)
      : await store.createProject(config);
    track('project_created', { mode: props.pack ? 'script' : 'normal', cameras: camCount, sound: soundOn });
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
          placeholder="e.g. The Last Monsoon"
          onChange={(e) => setName(e.target.value)}
        />
      </div>

      {/* Two co-equal recording departments, set up from the get-go: VIDEO
          (cameras, always present) and AUDIO (the recorder, optional). They
          stay separate streams with separate file counters, but always land
          on ONE shared shot - that marriage is the whole point of the tool. */}
      <div style={{ display: 'flex', alignItems: 'baseline', gap: 8, margin: '20px 0 12px' }}>
        <span style={{ fontSize: '0.72rem', fontWeight: 800, letterSpacing: '0.16em', textTransform: 'uppercase' }}>
          Video
        </span>
        <span className="section__note">picture · camera clips</span>
        <span style={{ height: 1, flex: 1, alignSelf: 'center', background: 'rgba(255, 255, 255, 0.18)' }} />
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
                  <div className="formrow" style={{ margin: '10px 0 0' }}>
                    <label className="label" htmlFor={`np-operator-${i}`}>
                      Operator <span className="section__note">optional</span>
                    </label>
                    <input
                      id={`np-operator-${i}`}
                      className="field"
                      placeholder="e.g. Rohan"
                      value={u.operator}
                      onChange={(e) => setUnit(i, { operator: e.target.value })}
                    />
                  </div>
                </div>
              );
            })}
          </div>
        </>
      )}

      {/* AUDIO department - co-equal with VIDEO above, but optional (a shoot
          may cut sound in-camera). A single recorder unit, independent of the
          camera count; when on it rolls as its own stream onto the same shot. */}
      <div className="formrow" style={{ marginTop: 24 }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 10 }}>
          <span
            style={{
              fontSize: '0.72rem',
              fontWeight: 800,
              letterSpacing: '0.16em',
              textTransform: 'uppercase',
              color: 'var(--sound)',
            }}
          >
            Audio
          </span>
          <span className="section__note">sound · recorder files</span>
          <span style={{ height: 1, flex: 1, alignSelf: 'center', background: 'rgba(255, 255, 255, 0.18)' }} />
          <div
            className="camcount"
            role="group"
            aria-label="Production sound"
            style={{ gridTemplateColumns: '1fr 1fr', width: 128 }}
          >
            <button
              type="button"
              className={`camcount__opt${!soundOn ? ' camcount__opt--on' : ''}`}
              aria-pressed={!soundOn}
              onClick={() => setSoundOn(false)}
            >
              Off
            </button>
            <button
              type="button"
              className={`camcount__opt${soundOn ? ' camcount__opt--on' : ''}`}
              aria-pressed={soundOn}
              onClick={() => setSoundOn(true)}
            >
              On
            </button>
          </div>
        </div>
        {soundOn && (
          <div className="camunit">
            <div className="camunit__head">
              <span className="camunit__badge" style={soundBadgeStyle} aria-hidden="true">S</span>
              <span className="camunit__eg tnum">{soundExample}{soundExt}</span>
            </div>
            <div className="formrow" style={{ margin: '12px 0 0' }}>
              <label className="label" htmlFor="np-sound-operator">
                Mixer <span className="section__note">optional</span>
              </label>
              <input
                id="np-sound-operator"
                className="field"
                placeholder="e.g. Priya"
                value={soundOperator}
                onChange={(e) => setSoundOperator(e.target.value)}
              />
            </div>
            <div className="formrow" style={{ margin: '10px 0 0' }}>
              <label className="label" htmlFor="np-sound-recorder">
                Recorder <span className="section__note">optional</span>
              </label>
              <input
                id="np-sound-recorder"
                className="field"
                placeholder="e.g. MixPre-6"
                value={soundRecorder}
                onChange={(e) => setSoundRecorder(e.target.value)}
              />
            </div>
            <div className="formgrid" style={{ marginTop: 10 }}>
              <div className="formrow" style={{ margin: 0 }}>
                <label className="label" htmlFor="np-sound-prefix">
                  File prefix
                </label>
                <input
                  id="np-sound-prefix"
                  className="field field--mono"
                  value={soundPrefix}
                  placeholder="SND_"
                  onChange={(e) => setSoundPrefix(e.target.value)}
                />
              </div>
              <div className="formrow" style={{ margin: 0 }}>
                <label className="label" htmlFor="np-sound-start">
                  Starting file no.
                </label>
                <input
                  id="np-sound-start"
                  className="field field--mono"
                  inputMode="numeric"
                  value={soundStart}
                  onChange={(e) => setSoundStart(e.target.value.replace(/[^0-9]/g, ''))}
                />
              </div>
            </div>
            <div className="formgrid" style={{ marginTop: 10 }}>
              <div className="formrow" style={{ margin: 0 }}>
                <label className="label" htmlFor="np-sound-pad">
                  Number digits
                </label>
                <input
                  id="np-sound-pad"
                  className="field field--mono"
                  inputMode="numeric"
                  value={soundPadding}
                  onChange={(e) => setSoundPadding(e.target.value.replace(/[^0-9]/g, ''))}
                />
              </div>
              <div className="formrow" style={{ margin: 0 }}>
                <label className="label" htmlFor="np-sound-ext">
                  File extension
                </label>
                <input
                  id="np-sound-ext"
                  className="field field--mono"
                  placeholder=".WAV"
                  value={soundExt}
                  onChange={(e) => setSoundExt(e.target.value)}
                />
              </div>
            </div>
          </div>
        )}
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

// Shotlist import, in two halves that play to different strengths.
//
// STRUCTURE is read on the device. A shotlist is a TABLE — numbered setups with
// size, move, action and dialogue columns — so the scene and shot breakdown is
// parsed here, exactly, offline, instantly, with nothing that could truncate a
// long list or invent a row that was never printed.
//
// JUDGEMENT comes from the model, and only judgement. It never sees the script;
// it sees the parsed shot division and writes the tappable key-moment chips for
// each shot — the beats an operator marks mid-take. That is a small structured
// payload rather than 17k characters of raw text, and it is the one part of
// this that isn't transcription. It's also the server call, so it needs an
// account.
function ScriptPackSheet(props: { onClose: () => void; onPack: (pack: ScriptPack) => void }) {
  const { session, loading } = useSession();
  const [phase, setPhase] = useState<'idle' | 'reading' | 'thinking'>('idle');
  const [error, setError] = useState<string | null>(null);
  const [showSignIn, setShowSignIn] = useState(false);
  const [signingIn, setSigningIn] = useState(false);
  const [usage, setUsage] = useState<Usage | null>(null);
  // True once the breakdown is refused for being out of free uses — shows "go Pro".
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

      const shotlist = parseShotlist(text);
      if (!shotlist) {
        throw new Error(
          "That doesn't look like a shotlist. Upload one with numbered shots — rows like 1.1, 1.2 with a size column (WS, MCU, CU).",
        );
      }
      const parsed = shotlistToPack(shotlist, file.name);
      const shotCount = parsed.scenes.reduce((n, s) => n + (s.shots?.length ?? 0), 0);
      track('shotlist_parsed', { scenes: parsed.scenes.length, shots: shotCount });

      // The structure is already correct and already ours. Enriching it with
      // key moments is the only thing that can fail from here, so if the server
      // says no we still import the shotlist rather than throwing the whole
      // parse away — the operator gets their shots, just without the chips.
      setPhase('thinking');
      const pack = await enrichShotMoments(parsed, file.name);
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
      setError(err instanceof Error ? err.message : 'Could not read that PDF.');
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
    <Sheet title="Shotlist" onClose={props.onClose}>
      <p className="camnote">
        Upload your shotlist as a PDF. We read every scene and every numbered shot
        off it — 1.1, 1.2, 1.3 — with the size and move each one is marked with, then
        work out the key moments inside each shot. On set you pick the shot and roll.
      </p>

      {loading ? (
        <div className="empty">Checking your account</div>
      ) : signedIn ? (
        <>
          <label className={`btn btn--go btn--full sp-upload${busy ? ' btn--disabled' : ''}`}>
            {phase === 'reading'
              ? 'Reading shotlist…'
              : phase === 'thinking'
                ? 'Finding key moments…'
                : 'Upload shotlist PDF'}
            <input type="file" accept="application/pdf,.pdf" hidden disabled={busy} onChange={onPickPdf} />
          </label>
          {usage && (
            <p className="camnote" style={{ textAlign: 'center', marginBottom: 0 }}>
              {usage.script.left} of {FREE_LIMIT} breakdowns left
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
            Reading your shotlist needs a free account. The examples below work without one.
          </p>
        </>
      )}

      {error && (
        <span className="tnum tnum--bad sp-error">
          {error}
        </span>
      )}
      {capped && <ProCta gate="script" />}

      <>
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
      </>

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
  { id: 'g-setup', label: 'Setup' },
  { id: 'g-cams', label: 'Multiple cameras' },
  { id: 'g-onset', label: 'On set' },
  { id: 'g-status', label: 'Discard vs delete' },
  { id: 'g-fix', label: 'Fixing a number' },
  { id: 'g-scenes', label: 'Scene order' },
  { id: 'g-voice', label: 'Voice' },
  { id: 'g-out', label: 'Handing off' },
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
              Your shot log, built while you shoot instead of typed up afterwards.
            </p>
            <p>
              Every file a camera writes gets a clip number in its name. Someone has always had to
              copy that number onto a shot log by hand, off a monitor, between setups, hundreds of
              times a day. Get one digit wrong and the log stops matching the actual files, so the
              editor stops trusting it and starts opening card folders instead.
            </p>
            <p>
              Clapper keeps the count for you. It knows the last number it handed out, and every
              ROLL gives out the next one. You never write a clip number down, and the log always
              matches what is really on the card.
            </p>

            <div className="grule">
              <p className="grule__label">The one rule</p>
              <p className="grule__big">Hit ROLL every time a camera rolls. No exceptions.</p>
              <p>
                Clapper cannot see the camera. It can only count, and its count only matches the
                camera’s if you press ROLL exactly as many times as the camera actually rolled.
              </p>
              <p>
                Camera rolled by mistake? Still hit ROLL, then CUT, then <b>Discard</b> it. The
                camera already wrote a file, so that number is spent either way. Discarding uses it
                up correctly; skipping the roll does not, and every number after it is wrong for the
                rest of the day.
              </p>
            </div>
          </section>

          {/* 2 ---------------------------------------------------------- */}
          <section className="gsec" id="g-setup">
            <p className="gsec__num tnum">02</p>
            <h3 className="gsec__h">Setting up a project</h3>
            <p className="gsec__lede">
              Two minutes at the top of the day. Every numbering mistake starts here, not out on the
              floor.
            </p>
            <p>
              A project has two independent blocks: <b>Video</b>, for your camera or cameras, and{' '}
              <b>Audio</b>, for a sound recorder if you are using one. Each keeps its own running
              count, but every shot you log carries both together.
            </p>
            <p>
              <b>Video.</b> Pick 1 to 4 cameras. For each one, set the starting clip number and its
              clip format — prefix, number of digits, file extension. Read the last file already on
              the card and enter the next number, not 1. Match the format to a real file: C0001 and
              C001 are different names and will not relink in the edit.
            </p>
            <p>
              <b>Audio.</b> Turn it on only if a separate recorder is rolling sound. Set its file
              prefix (e.g. SND_), digit count and extension (e.g. .WAV) the same way, read off a
              real file on the recorder’s card.
            </p>
            <p>
              <b>Frame rate.</b> Match what the camera is shooting. It is what the exported timeline
              gets built at.
            </p>
            <p className="gnote">
              iPhone footage shares its counter with the photo roll, so numbers skip and cannot be
              predicted. Set the start from real footage and expect to correct a number during the
              day.
            </p>
          </section>

          {/* 3 ---------------------------------------------------------- */}
          <section className="gsec" id="g-cams">
            <p className="gsec__num tnum">03</p>
            <h3 className="gsec__h">Running more than one camera</h3>
            <p className="gsec__lede">
              Pick 2 to 4 cameras in setup and each one becomes its own lettered unit, A to D.
            </p>
            <p>
              Every unit has its own clip counter, and it only advances when that camera rolls. Two
              identical cameras both writing <span className="tnum">C0001.MP4</span> is completely
              normal — the letter is what tells them apart on export, not the filename. Nobody has
              to rename anything.
            </p>
            <p>
              On export, each camera’s picture and sound land synced at the same point in the
              timeline, so the editor can start cutting between angles right away.
            </p>
            <p className="gnote">
              A tag you tap during a shot belongs to the take, not to one camera. It is saved on
              camera A’s clip.
            </p>
          </section>

          {/* 4 ---------------------------------------------------------- */}
          <section className="gsec" id="g-onset">
            <p className="gsec__num tnum">04</p>
            <h3 className="gsec__h">Rolling and cutting a shot</h3>
            <p className="gsec__lede">Open a scene, then roll.</p>
            <p>
              Tap the big <b>ROLL</b>. On a project with one camera and sound turned on, this rolls
              the camera and the recorder together.
            </p>
            <p>
              Prefer to start the recorder first? Roll it alone from the <b>SOUND</b> box — the
              camera joins the same shot the moment it rolls.
            </p>
            <p>
              Running more than one camera? Each one gets its own slot: tap a slot to roll that
              camera alone, tap <b>JOIN</b> to bring a camera into a shot already rolling, or tap a
              rolling camera to cut just that one. The shot ends once every camera and the recorder
              have all cut.
            </p>
            <p>
              The number on screen counts up while the shot rolls — it is the shot’s length, not the
              camera’s own on-screen clock (its timecode). Clapper cannot read that clock, so add it
              yourself at CUT if you want it on the record.
            </p>
            <p>
              While it rolls, tap what you see: <b>WIDE · MID · CU · OTS · INSERT</b> for coverage,{' '}
              <b>GOLD</b> for a keeper, PICKUP and NOISE for the rest. <b>MARK IN</b> then{' '}
              <b>MARK OUT</b> flags a stretch instead of one instant. Uploaded a shotlist? Shotlist mode
              swaps these for chips built from that scene instead, so you are tapping “door slams”
              and “she turns” rather than generic coverage.
            </p>
            <p>
              Hit <b>CUT</b> to close it. Clapper stamps the clip number(s), then asks you to Keep or
              Discard, with room for the camera’s timecode and a one-line note if you want them.
            </p>
            <p>
              Shoot scenes in any order you like. A <span className="gdot gdot--done" /> green dot
              marks a scene already in the can, a <span className="gdot" /> dim dot marks what is
              left, and the header keeps a running “X / Y in the can”.
            </p>
            <p className="gnote">
              The screen stays awake the whole time a scene is open, so it will not lock between
              takes.
            </p>
          </section>

          {/* 5 ---------------------------------------------------------- */}
          <section className="gsec" id="g-status">
            <p className="gsec__num tnum">05</p>
            <h3 className="gsec__h">Discard is not delete</h3>
            <p className="gsec__lede">
              One question sorts it: is there a file on the card? If yes, discard it. If no, delete
              it.
            </p>
            <div className="gsplit">
              <div className="gsplit__half">
                <p className="gsplit__k gsplit__k--keep">Discard</p>
                <p>
                  There is a file. The camera rolled and wrote it, the take was just no good. It
                  keeps its clip number, prints on the PDF struck through in the discarded list, and
                  still reaches the editor in the export, parked behind the good takes.
                </p>
                <p>Use it for a flubbed take, a false start, a roll nobody meant to make.</p>
              </div>
              <div className="gsplit__half">
                <p className="gsplit__k gsplit__k--kill">Delete</p>
                <p>
                  There is no file. You logged something that never happened: a double tap, the same
                  shot twice. Delete removes the row.
                </p>
                <p>
                  Clapper reclaims its clip number automatically: every later shot on that camera —
                  and the sound file, if it rolled — slides down by one to match.
                </p>
              </div>
            </div>
            <p className="gnote">
              Go by the card, not by memory. Discard something the camera never actually wrote and
              every number after it is off by one. Delete something it did write and that clip
              vanishes from the report without a trace.
            </p>
          </section>

          {/* 6 ---------------------------------------------------------- */}
          <section className="gsec" id="g-fix">
            <p className="gsec__num tnum">06</p>
            <h3 className="gsec__h">When a number goes wrong</h3>
            <p>
              Tap any shot to open it. It has its own stepper for the camera clip number and, if
              sound rolled on it, a separate stepper for the sound file number — fix whichever is
              wrong.
            </p>
            <p>
              Clapper shifts every <b>later</b> shot on that same camera or recorder by the same
              amount, and moves its live counter with it, because the camera or recorder kept
              counting while the log was wrong. It shows you exactly how many shots are about to
              change and asks you to confirm first — press <b>STOP</b> if that is not what you
              meant. Earlier shots never move.
            </p>
            <p>
              It shifts the numbers rather than renumbering from scratch, so a deliberate gap — a
              stretch where the camera rolled and you did not log it — survives instead of getting
              closed up.
            </p>
            <p>
              Fixing one camera never touches another. And you do not have to wait for a mistake:
              tap the pencil on any camera or on the sound box before you roll, to fix its next
              number in advance.
            </p>
          </section>

          {/* 7 ---------------------------------------------------------- */}
          <section className="gsec" id="g-scenes">
            <p className="gsec__num tnum">07</p>
            <h3 className="gsec__h">Scenes and shooting order</h3>
            <p className="gsec__lede">
              Add every scene before you shoot, then drag them into the order you will actually
              shoot in.
            </p>
            <p>
              Story order — the order scenes were written in — never changes once you set it.
              Shooting order is separate: drag a scene up or down the list to match your call sheet
              for the day.
            </p>
            <p>
              This matters at export. The editor’s timeline always follows story order, so
              reordering your on-set list to shoot scene 12 before scene 3 never scrambles the final
              cut.
            </p>
          </section>

          {/* 8 ---------------------------------------------------------- */}
          <section className="gsec" id="g-voice">
            <p className="gsec__num tnum">08</p>
            <h3 className="gsec__h">Voice, when your hands are full</h3>
            <p>
              Tap the mic on the roll screen and Clapper listens for the call. It appears only on
              browsers that support speech recognition.
            </p>
            <dl className="gsay">
              <dt>Starts a shot</dt>
              <dd>“roll” · “rolling” · “roll camera” · “camera roll”</dd>
              <dt>Stops it</dt>
              <dd>“cut” · “cut it”</dd>
            </dl>
            <p className="gnote">
              It matches the word anywhere in the sentence. While a shot is rolling, someone saying
              “cut” in conversation will stop it. Turn the mic off if the room talks over takes.
            </p>
          </section>

          {/* 9 ---------------------------------------------------------- */}
          <section className="gsec" id="g-out">
            <p className="gsec__num tnum">09</p>
            <h3 className="gsec__h">Handing off at wrap</h3>
            <p className="gsec__lede">
              Four export formats, all built from the same shot log.
            </p>
            <dl className="gsay gsay--wide">
              <dt>Premiere (XML)</dt>
              <dd>
                Opens as one timeline: the good takes cut together in story order, then a gap, then
                every take again — rejects included — in the same order, parked behind it. Every tap
                you made on set arrives as a marker on the clip it happened in.
              </dd>
              <dt>DaVinci Resolve (XML)</dt>
              <dd>The same timeline, built for Resolve instead of Premiere.</dd>
              <dt>PDF shot log</dt>
              <dd>
                For production and the director: scenes, shots, clip numbers, durations, camera
                timecode and wall clock, a GOLD summary up front and the discarded shots at the back.
              </dd>
              <dt>CSV</dt>
              <dd>
                For anyone who wants the raw data. One row per tapped moment, plus a row per take so
                takes with no tapped moments still appear.
              </dd>
            </dl>
            <p>
              Every camera’s clip lands on its own synced picture track, and the sound recorder’s
              file lands on the audio track under it, already lined up — the editor relinks the
              recorder’s file and it sits in sync under the picture, no manual reconciling.
              Multi-camera projects export the same way, with every camera’s angle stacked in sync
              at each position.
            </p>
            <p className="gnote">
              PDF export works offline, no account needed. Premiere, Resolve and CSV need a quick,
              free Google sign-in — same for uploading a shotlist.
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
