// The projects list. Since the shell landed, this screen is the list and its
// stack, and nothing else — the settings-shaped things that used to be welded
// to the bottom of it (the guide, Restore, Feedback, the account row) now live
// on the Settings and Account tabs. Shotlist import and InstallNudge are still
// here on purpose: the spec moves both to Home, which another agent owns, and
// leaving them reachable beats making them unreachable in the meantime.

import { useEffect, useMemo, useState, type ChangeEvent } from 'react';
import type { Fps, Project } from '../types';
import { store } from '../store';
import { CAMERA_PRESETS, findPreset, renderClip, makeCameraUnit, UNIT_LETTERS } from './cameras';
import { Sheet, SheetClose, Confirm, Rail } from './common';
import { importScriptPack, EXAMPLE_PACKS, type ScriptPack } from './scriptpack';
import { extractPdfText } from './pdftext';
import { parseShotlist, shotlistToPack } from './shotlist';
import { enrichShotMoments, SignInRequiredError } from './breakdown';
import { SignInSheet } from './SignInSheet';
import { ScreenHeader } from './glist';
import { lastActivity } from './newRoll';
import { PlusMark, ListMark } from './marks';
import { ProCta } from './ProCta';
import InstallNudge from './InstallNudge';
import { useSession, signInWithGoogle } from '../net/auth';
import { getUsage, FREE_LIMIT, type Usage } from '../net/quota';
import { track } from '../net/analytics';
import { TagEditor } from './TagEditor';
import { getDefaultTags } from './tagdefaults';
import * as haptics from './haptics';

const FPS_OPTIONS: Fps[] = [23.976, 24, 25, 29.97, 30, 50, 59.94, 60];

// Production sound's badge accent - same cool blue RollingScreen uses for the
// Sound roll control, applied inline on the shared .camunit__badge here too
// (styling stays scoped to src/ui/, not the shared stylesheet).
// The deep token for the type and the edge, the wash for the fill: bright
// --sound as text on paper is 2.91:1. See docs/specs/2026-08-14-light-theme.md.
const soundBadgeStyle = {
  color: 'var(--sound-text)',
  background: 'var(--sound-tint)',
  borderColor: 'var(--sound-edge)',
};

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

// Recency buckets, seeded-and-measured against a real 25+ project list: with
// ONE creation-order pile a director scrolling for a shoot from six weeks ago
// has no landmark to stop at. Four bands mirror the Photos/Files idiom
// everyone's phone already teaches — the smallest structure that turns a
// scroll into a scan. A single band renders no header at all (see `grouped`
// below): a lone pile has nothing to be distinguished from, so a phone with a
// handful of projects touched around the same time looks exactly as plain as
// it does today.
const BUCKETS = ['Today', 'This week', 'This month', 'Earlier'] as const;
type Bucket = (typeof BUCKETS)[number];
const DAY_MS = 86400000;

/** Midnight, local time, for the day `ms` falls on — CALENDAR day, not a
 *  rolling 24h window. A take logged at 11pm and one logged at 6am the next
 *  morning are eight hours apart and both "yesterday" by the clock, but the
 *  crew calls the second one a new day; a stopwatch boundary would still be
 *  calling the first one TODAY at 5am the morning after. */
function startOfDay(ms: number): number {
  const d = new Date(ms);
  d.setHours(0, 0, 0, 0);
  return d.getTime();
}

function bucketFor(now: number, p: Project): Bucket {
  const touched = lastActivity(p);
  if (startOfDay(touched) === startOfDay(now)) return 'Today';
  const days = (now - touched) / DAY_MS;
  if (days < 7) return 'This week';
  if (days < 30) return 'This month';
  return 'Earlier';
}

export function ProjectsScreen(props: { onOpen: (project: Project) => void }) {
  const [rows, setRows] = useState<Row[] | null>(null);
  const [creating, setCreating] = useState(false);
  const [loadingScript, setLoadingScript] = useState(false);
  const [pendingPack, setPendingPack] = useState<ScriptPack | null>(null);

  async function refresh() {
    const projects = await store.listProjects();
    // The one you touched last is the one you want — same read `startNewRoll`
    // already uses to pick where New roll lands (src/ui/newRoll.ts), reused
    // rather than sorting by creation date, which stops answering "where was
    // I" the moment a director reopens an old project for a pickup shoot.
    // Tie-break on id, the same way ClipLogScreen's take sort does, so two
    // projects that landed the same millisecond never swap places between
    // renders.
    projects.sort(
      (a, b) => lastActivity(b) - lastActivity(a) || (a.id < b.id ? 1 : a.id > b.id ? -1 : 0),
    );
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

  // One pass into four bands rather than filtering `rows` once per bucket.
  // `now` is captured here (not read again per row below) so a card can never
  // wander bands mid-scroll while the clock ticks under it.
  const grouped = useMemo(() => {
    if (!rows) return [];
    const now = Date.now();
    const byBucket = new Map<Bucket, Row[]>();
    for (const row of rows) {
      const bucket = bucketFor(now, row.project);
      const list = byBucket.get(bucket);
      if (list) list.push(row);
      else byBucket.set(bucket, [row]);
    }
    const present = BUCKETS.filter((b) => byBucket.has(b));
    // One band alone has nothing to be distinguished from, so its header adds
    // a caption nobody asked for rather than a landmark to scan against.
    const showHeaders = present.length > 1;
    return present.map((bucket) => ({ bucket, rows: byBucket.get(bucket)!, showHeaders }));
  }, [rows]);

  return (
    <div className="app">
      {/* Was an app icon, the wordmark and a tagline: a website header, on a tab
          that is not even called Clapper. It is now the same large title the
          other three roots carry, from the same component, so all four shrink
          into the material bar on the same beat. */}
      <ScreenHeader title="Projects" />

      <InstallNudge />

      {rows === null ? (
        <div className="empty">Loading projects</div>
      ) : rows.length === 0 ? (
        <div className="empty">
          <b>No projects yet</b>
          Start one for your shoot day.
        </div>
      ) : (
        grouped.map(({ bucket, rows: bucketRows, showHeaders }) => (
          <section className="glist" key={bucket}>
            {showHeaders && <h2 className="glist-hdr">{bucket}</h2>}
            <div className="stack">
              {bucketRows.map(({ project, takeCount }) => (
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
                    <span>{fmtDate(lastActivity(project))}</span>
                    <span>
                      <b>{project.fps}</b> fps
                    </span>
                    <span>
                      {takeCount === 1 ? '1 take' : `${takeCount} takes`}
                    </span>
                    {/* No Delete at rest. It is a destructive row at the
                        bottom of the project's own screen now, which is
                        where iOS puts one. */}
                  </div>
                </button>
              ))}
            </div>
          </section>
        ))
      )}

      <button
        type="button"
        className="newproject newproject--primary"
        onClick={() => {
          haptics.tap();
          setCreating(true);
        }}
      >
        <PlusMark /> New project
      </button>

      <button
        type="button"
        className="newproject newproject--ghost"
        onClick={() => {
          haptics.tap();
          setLoadingScript(true);
        }}
      >
        <ListMark /> Shotlist · from a PDF
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
  // Seeded from the operator's Settings default rather than a list hard-coded
  // here, which is the whole point of the Settings row — a crew with a house
  // vocabulary should never retype it. Still fully editable per project: this
  // is a starting point, not a binding.
  const [tags, setTags] = useState<string[]>(() => getDefaultTags('video'));
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
          <span className="tnum">{props.pack.scenes.length}</span> scenes ready
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
      <div className="formsection">
        <span className="label">Video</span>
        <span className="section__note">picture · camera clips</span>
        <span className="formsection__rule" />
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
      <div className="formrow">
        <div className="formsection">
          <span className="label" style={{ color: 'var(--sound-text)' }}>
            Audio
          </span>
          <span className="section__note">sound · recorder files</span>
          <span className="formsection__rule" />
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

      <TagEditor label="Quick tags" tags={tags} onChange={setTags} />

      <div className="sheet__actions">
        <SheetClose className="btn btn--ghost" onClose={props.onClose}>
          Cancel
        </SheetClose>
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
        <SheetClose className="btn btn--ghost" onClose={props.onClose} disabled={busy}>
          Close
        </SheetClose>
      </div>
    </Sheet>
  );
}
