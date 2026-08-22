// SHOTLIST — upload a shot division as a PDF and stand it up as a project.
//
// A STAGED FLOW, not a form. Five stages, one decision each, a position
// indicator, and forward/back in the footer where a thumb already is:
//
//   1 DOCUMENT    choose the PDF (or an example pack). The gate, the sign-in
//                 and the free-tier counter all live HERE, because here is
//                 where they bite.
//   2 WHAT WE READ  the scenes and shots found, scannable, with a way out if
//                 the parse read the wrong document.
//   3 FRAME RATE  eight big targets. It lands in every exported timecode, so
//                 it is the one value that is painful to correct later.
//   4 CAMERA      the presets as cards showing the clip name each produces.
//   5 NAME AND GO the name, a receipt of the four decisions, one action.
//
// The parse is on-device and takes real seconds, so stage 1 spends that wait
// showing what it has FOUND — pages read, then scenes and shots — rather than
// a spinner. See PdfProgress in pdftext.ts.
//
// ALL the parsing logic is imported, none of it is written here — every piece
// is the same module the projects list has always called:
//
//   pdftext.extractPdfText   the text off the PDF, on the device
//   shotlist.parseShotlist   the scene/shot table, on the device, exactly
//   scriptpack.importScriptPack   the pack -> a Project with one Slate per scene
//   breakdown.enrichShotMoments   the ONE server call: key-moment chips
//
// So the structure of your document never leaves the phone. Only the parsed
// shot division goes out, and only to write the tappable chips.
//
// THIS IS NOW THE ONLY COPY. ProjectsScreen.tsx used to carry a private
// near-duplicate of the read half (ScriptPackSheet) that handed its pack to
// what was then a fourteen-field New project sheet; it is gone, and the
// projects list mounts this component instead. Two flows that looked different
// for the same job was the whole problem.
//
// The setup stages are deliberately three values. Name, frame rate, camera —
// the ones that are painful to correct after the fact. Clip prefix, padding,
// multi-cam and sound are all editable on the project screen the moment this
// closes, so asking for them here would be ceremony. The blank-project flow
// (ui/NewProjectSheet.tsx) is five stages for the same reason and asks two
// more questions, because a rig set up before the shoot starts is one of the
// things that IS painful to correct later.
//
// THE CHROME IS SHARED. StageRail, StagePanel and StageActions were written
// here first and now live in ui/stages.tsx, imported by all three staged flows
// — this one, first-open and New project. The .sl-* classes keep their name.

import { useEffect, useState, type ChangeEvent, type DragEvent, type ReactNode } from 'react';
import type { Fps, Project } from '../types';
import { Sheet, SheetClose } from './common';
import { StageRail, StagePanel, StageActions } from './stages';
import { CAMERA_PRESETS, findPreset, renderClip } from './cameras';
import { FPS_OPTIONS, FPS_WARNING } from './fps';
import { importScriptPack, EXAMPLE_PACKS, type ScriptPack } from './scriptpack';
import { extractPdfText } from './pdftext';
import { parseShotlist, shotlistToPack } from './shotlist';
import { enrichShotMoments, SignInRequiredError } from './breakdown';
import { SignInSheet } from './SignInSheet';
import { ProCta } from './ProCta';
import { useSession, signInWithGoogle } from '../net/auth';
import { getUsage, FREE_LIMITS, type Usage } from '../net/quota';
import { track } from '../net/analytics';
import * as haptics from './haptics';

type Stage = 'document' | 'read' | 'fps' | 'camera' | 'name';

const STAGES: readonly Stage[] = ['document', 'read', 'fps', 'camera', 'name'];

const STAGE_TITLE: Record<Stage, string> = {
  document: 'Shotlist',
  read: 'What we read',
  fps: 'Frame rate',
  camera: 'Camera',
  name: 'Name and go',
};

// ===========================================================================
// A SEAM FOR SCREENSHOTS. DEV ONLY.
// ===========================================================================
//
// Three states of stage one cannot be reached without a real Supabase session:
// signed in with a counter, and signed in with the counter exhausted. Same
// move `__clapperSyncFace` in common.tsx makes for the sync pill, and for the
// same reason — the states that matter most are the ones hardest to stand in
// front of. `import.meta.env.DEV` is a compile-time constant, so the whole
// block is dropped from the shipped bundle.
interface DocOverride {
  signedIn?: boolean;
  left?: number;
  capped?: boolean;
  /** Freeze the parse tally at a given moment. The counts move too fast to
   *  photograph and the server half needs a real account to be slow at all. */
  tally?: {
    phase: 'reading' | 'thinking';
    pages: { done: number; total: number } | null;
    found: { scenes: number; shots: number } | null;
  };
}
let devDoc: DocOverride | null = null;
const devDocListeners = new Set<() => void>();
if (import.meta.env.DEV && typeof window !== 'undefined') {
  (window as unknown as Record<string, unknown>).__clapperShotlistGate = (o: DocOverride | null) => {
    devDoc = o;
    for (const fn of devDocListeners) fn();
  };
}

function useDevDoc(): DocOverride | null {
  const [, bump] = useState(0);
  useEffect(() => {
    if (!import.meta.env.DEV) return;
    const fn = () => bump((n) => n + 1);
    devDocListeners.add(fn);
    return () => {
      devDocListeners.delete(fn);
    };
  }, []);
  return import.meta.env.DEV ? devDoc : null;
}

// ===========================================================================

export function ShotlistSheet(props: { onClose: () => void; onImported: (project: Project) => void }) {
  const [stage, setStage] = useState<Stage>('document');
  // Which way the last move went, so the stage animates in from the side it
  // came from. Purely presentational; the reduce-motion rules erase it.
  const [dir, setDir] = useState<'fwd' | 'back'>('fwd');

  const [pack, setPack] = useState<ScriptPack | null>(null);
  const [name, setName] = useState('');
  const [fps, setFps] = useState<Fps>(24);
  const [camera, setCamera] = useState('custom');
  const [creating, setCreating] = useState(false);
  // A 401 anywhere in stage one swaps the whole sheet for the sign-in sheet.
  const [showSignIn, setShowSignIn] = useState(false);

  const index = STAGES.indexOf(stage);

  function go(next: Stage) {
    const forward = STAGES.indexOf(next) > index;
    setDir(forward ? 'fwd' : 'back');
    haptics.tap();
    setStage(next);
  }

  function onPack(next: ScriptPack) {
    setPack(next);
    setName(next.project.name);
    setDir('fwd');
    setStage('read');
  }

  /** Back out of the result and read a different document. */
  function startOver() {
    setPack(null);
    setDir('back');
    setStage('document');
  }

  async function create() {
    if (!pack || creating || name.trim().length === 0) return;
    setCreating(true);
    const preset = findPreset(camera);
    try {
      const project = await importScriptPack(pack, {
        name: name.trim(),
        fps,
        camera,
        clipPrefix: preset?.prefix ?? 'C',
        clipSuffix: preset?.suffix ?? '',
        clipExt: preset?.ext ?? '.MP4',
        clipPadding: preset?.digits ?? 4,
        nextClipNumber: 1,
      });
      track('project_created', { mode: 'script', cameras: 1, sound: false });
      haptics.tap();
      props.onImported(project);
    } catch {
      setCreating(false);
    }
  }

  if (showSignIn) return <SignInSheet onClose={props.onClose} />;

  return (
    <Sheet title={STAGE_TITLE[stage]} onClose={creating ? undefined : props.onClose}>
      {/* `.dt-sheet` re-materials the camera-preset badge (see skin/detail.css);
          the sheet's grabber, title and slide stay the shared <Sheet> chrome. */}
      <div className="dt-sheet sl">
        <StageRail index={index} total={STAGES.length} title={STAGE_TITLE[stage]} />

        {/* Keyed on the stage so React remounts the panel and the enter
            animation replays. One <Sheet> for the whole sequence: a sheet that
            tore itself down between stages would slide out and back in five
            times for what is one continuous decision. */}
        <StagePanel dir={dir} key={stage}>
          {stage === 'document' && (
            <DocumentStage onPack={onPack} onGated={() => setShowSignIn(true)} onClose={props.onClose} />
          )}

          {stage === 'read' && pack && (
            <ReadStage pack={pack} onBack={startOver} onNext={() => go('fps')} onClose={props.onClose} />
          )}

          {stage === 'fps' && (
            <FpsStage fps={fps} onPick={setFps} onBack={() => go('read')} onNext={() => go('camera')} />
          )}

          {stage === 'camera' && (
            <CameraStage camera={camera} onPick={setCamera} onBack={() => go('fps')} onNext={() => go('name')} />
          )}

          {stage === 'name' && pack && (
            <NameStage
              pack={pack}
              name={name}
              fps={fps}
              camera={camera}
              busy={creating}
              onName={setName}
              onBack={() => go('camera')}
              onGo={() => void create()}
            />
          )}
        </StagePanel>
      </div>
    </Sheet>
  );
}

// ================================================================ one ======
// THE DOCUMENT. The gate, the counter and the wait all live here.

/**
 * Exported so NewProjectSheet.tsx's Shot list stage can mount this same
 * picker rather than writing a second PDF reader. The whole read/parse/gate
 * path (extractPdfText, parseShotlist, enrichShotMoments, the sign-in gate,
 * the free-tier counter) stays owned here, in ONE place.
 */
export function DocumentStage(props: {
  onPack: (pack: ScriptPack) => void;
  onGated: () => void;
  onClose: () => void;
  /**
   * Swap the default "Close" footer for something else. NewProjectSheet's
   * Shot list stage reads as one stage among six, not a sheet-ending action,
   * so it trades Close for Back + Skip. Receives whether a parse is
   * currently running, so the caller can disable its own buttons mid-parse
   * the same way the default footer disables Close. Omitted by ShotlistSheet's
   * own five-stage flow, whose stage one IS the sheet's entry and close point,
   * so that default renders byte-identical to before.
   */
  footer?: (busy: boolean) => ReactNode;
}) {
  const { session, loading } = useSession();
  const dev = useDevDoc();
  const [phase, setPhase] = useState<'idle' | 'reading' | 'thinking'>('idle');
  const [error, setError] = useState<string | null>(null);
  const [signingIn, setSigningIn] = useState(false);
  const [usage, setUsage] = useState<Usage | null>(null);
  // True once the breakdown is refused for being out of free uses.
  const [capped, setCapped] = useState(dev?.capped ?? false);
  const [over, setOver] = useState(false);
  // What has actually been found so far. Nulls are "not known yet" and render
  // as a dash, which is honest: pages tick as they are read, and the scene and
  // shot counts cannot exist until the whole document has been.
  const [pages, setPages] = useState<{ done: number; total: number } | null>(null);
  const [found, setFound] = useState<{ scenes: number; shots: number } | null>(null);

  const busy = phase !== 'idle';
  const signedIn = dev?.signedIn ?? !!session;
  const left = dev?.left ?? usage?.script.left;
  const showCap = dev?.capped ?? capped;

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

  async function read(file: File) {
    // Fired the moment a file is picked, before we know if it's readable -
    // distinct from `shotlist_parsed` below on purpose. Without this the
    // funnel can't tell "nobody tries to upload a shot list" apart from
    // "people try and the parser rejects them"; those are different bugs.
    track('shotlist_uploaded', { surface: 'sheet' });
    setError(null);
    setCapped(false);
    setPages(null);
    setFound(null);
    try {
      setPhase('reading');
      const text = await extractPdfText(file, (done, total) => setPages({ done, total }));
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
      setFound({ scenes: parsed.scenes.length, shots: shotCount });
      track('shotlist_parsed', { scenes: parsed.scenes.length, shots: shotCount });

      // The structure is already ours and already correct. Chips are the only
      // thing left that can fail, so a refusal still hands the shots over —
      // the operator gets their breakdown, just without the taps.
      setPhase('thinking');
      const enriched = await enrichShotMoments(parsed, file.name);
      haptics.tap();
      props.onPack(enriched);
    } catch (err) {
      setPhase('idle');
      setPages(null);
      setFound(null);
      if (err instanceof SignInRequiredError) {
        props.onGated();
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

  function onPickPdf(e: ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0];
    e.target.value = ''; // let the same file be picked again after an error
    if (!file) return;
    void read(file);
  }

  function onDrop(e: DragEvent<HTMLLabelElement>) {
    e.preventDefault();
    setOver(false);
    if (busy) return;
    const file = e.dataTransfer.files?.[0];
    if (file) void read(file);
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

  return (
    <>
      {dev?.tally ? (
        <Tally {...dev.tally} />
      ) : loading ? (
        <div className="empty">Checking your account</div>
      ) : busy ? (
        <Tally phase={phase} pages={pages} found={found} />
      ) : signedIn ? (
        <>
          <label
            className={`sl-drop${over ? ' sl-drop--over' : ''}`}
            data-testid="sl-drop"
            onDragOver={(e) => {
              e.preventDefault();
              setOver(true);
            }}
            onDragLeave={() => setOver(false)}
            onDrop={onDrop}
          >
            <span className="sl-drop__title">Choose your shotlist PDF</span>
            <span className="sl-drop__sub">
              Every scene and numbered shot, read off the document on this phone.
            </span>
            <input type="file" accept="application/pdf,.pdf" hidden onChange={onPickPdf} />
          </label>
          {typeof left === 'number' && (
            <p className="camnote sl-quota">
              <span className="tnum">{left}</span> of <span className="tnum">{FREE_LIMITS.script}</span>{' '}
              breakdowns left
            </p>
          )}
        </>
      ) : (
        <>
          <p className="camnote sl-lede">Every scene and numbered shot, read off the PDF.</p>
          <button
            type="button"
            className="btn btn--go btn--full sl-signin"
            disabled={signingIn}
            onClick={() => void startSignIn()}
          >
            {signingIn ? 'Opening Google…' : 'Sign in with Google to upload'}
          </button>
          {/* No second footnote here. The button says the upload needs an
              account, and the "or try an example" divider directly under it
              says the other path does not. */}
        </>
      )}

      {error && <span className="tnum tnum--bad sp-error">{error}</span>}
      {showCap && <ProCta gate="script" />}

      {!busy && !dev?.tally && (
        <>
          <div className="sp-or">
            <span>or try an example</span>
          </div>

          <div className="sl-examples">
            {EXAMPLE_PACKS.map((ex) => (
              <button
                key={ex.key}
                type="button"
                className="btn sp-example"
                onClick={() => {
                  track('example_loaded', { which: ex.key });
                  haptics.tap();
                  props.onPack(ex.pack); // bundled: no server, no account, no network
                }}
              >
                <b>{ex.label}</b>
                <span>{ex.blurb}</span>
              </button>
            ))}
          </div>
        </>
      )}

      {props.footer ? (
        props.footer(busy)
      ) : (
        <StageActions>
          <SheetClose className="btn btn--ghost" onClose={props.onClose} disabled={busy}>
            Close
          </SheetClose>
        </StageActions>
      )}
    </>
  );
}

/**
 * The wait, spent saying what has been found.
 *
 * Three counts, filled in as they become true. The first ticks per page; the
 * other two land together the instant the table has been parsed, and then sit
 * there through the one server call, which is the part that has nothing to
 * show. That is the whole trick: by the time there is genuinely nothing to
 * report, there is already something on screen worth reading.
 */
function Tally(props: {
  phase: 'reading' | 'thinking';
  pages: { done: number; total: number } | null;
  found: { scenes: number; shots: number } | null;
}) {
  const { phase, pages, found } = props;
  return (
    <div className="sl-tally" role="status" aria-live="polite">
      <p className="sl-tally__act">
        {phase === 'reading' ? 'Reading the document' : 'Finding the key moments'}
      </p>
      <dl className="sl-tally__rows">
        <div className="sl-tally__row" data-on={pages ? '' : undefined}>
          <dt>Pages read</dt>
          <dd className="tnum">{pages ? `${pages.done} of ${pages.total}` : '—'}</dd>
        </div>
        <div className="sl-tally__row" data-on={found ? '' : undefined}>
          <dt>Scenes seen</dt>
          <dd className="tnum">{found ? found.scenes : '—'}</dd>
        </div>
        <div className="sl-tally__row" data-on={found ? '' : undefined}>
          <dt>Shots seen</dt>
          <dd className="tnum">{found ? found.shots : '—'}</dd>
        </div>
      </dl>
      <p className="camnote">
        {phase === 'reading'
          ? 'The document is being read on this phone. Nothing about it is sent anywhere.'
          : 'Only the parsed shot division goes out, and only to write the tappable chips.'}
      </p>
    </div>
  );
}

// ================================================================ two ======
// WHAT WE READ.

/**
 * "SC 1 · INT. THE MANSION · NIGHT" -> "INT. THE MANSION · NIGHT".
 *
 * Both example packs and every parsed PDF put the scene label at the front of
 * the scene NAME, in whatever vernacular the document used ("SC 1", "GF 1",
 * "S 4a"), and the row already carries the reference as its own left column.
 * On a 390px phone the duplicate costs the end of the location, which is the
 * part an operator actually recognises.
 *
 * A SEPARATOR IS REQUIRED, which is what keeps this safe: only a leading
 * label that is followed by a real divider is dropped, so "12 Angry Men" and
 * any name that simply starts with a number survive whole. So does a name
 * that is nothing but its own reference.
 */
const SCENE_LABEL = /^\s*[A-Za-z]{0,4}\s*[-_ ]?\s*\d+[A-Za-z]?\s*[·:.–—-]\s*/;

function sceneName(name: string): string {
  return name.replace(SCENE_LABEL, '').trim() || name;
}

// How many scene rows stage two shows before it stops and says how many more
// there are. The stage's job is "does this look like your document" — six rows
// answers that, and a 40-scene feature would otherwise push "Looks right" so
// far down the scroll that the stage has no visible way forward.
const SCENES_SHOWN = 6;

function ReadStage(props: {
  pack: ScriptPack;
  onBack: () => void;
  onNext: () => void;
  onClose: () => void;
}) {
  const { pack } = props;
  const shots = pack.scenes.reduce((n, s) => n + (s.shots?.length ?? 0), 0);
  const shown = pack.scenes.slice(0, SCENES_SHOWN);
  const rest = pack.scenes.length - shown.length;
  // A pack can legitimately be scenes with no shot-level breakdown. "0 SHOTS"
  // over a column of zeros reads as a failed parse on the one stage whose job
  // is to say the parse went fine, so the whole shot column just is not there.
  const hasShots = shots > 0;

  return (
    <>
      <div className="sl-count">
        <span className="sl-count__cell">
          <b className="tnum">{pack.scenes.length}</b>
          <span className="label">Scenes</span>
        </span>
        {hasShots && (
          <span className="sl-count__cell">
            <b className="tnum">{shots}</b>
            <span className="label">Shots</span>
          </span>
        )}
      </div>

      <ol className="sl-scenes">
        {shown.map((s) => (
          <li key={s.scriptRef} className="sl-scene">
            <span className="sl-scene__ref tnum">{s.scriptRef}</span>
            <span className="sl-scene__say">
              <b>{sceneName(s.name)}</b>
              {s.summary && <span>{s.summary}</span>}
            </span>
            {hasShots && <span className="sl-scene__n tnum">{s.shots?.length ?? 0}</span>}
          </li>
        ))}
        {rest > 0 && (
          <li className="sl-scene sl-scene--more">
            and <span className="tnum">{rest}</span> more {rest === 1 ? 'scene' : 'scenes'}
          </li>
        )}
      </ol>

      {/* The honest way out. It is a full-width control and it says what it
          does, because "the parser read the wrong document" is a thing that
          happens and burying it under a back chevron would make it the user's
          fault for not finding it. */}
      <button type="button" className="sl-wrong" onClick={props.onBack}>
        Not this document? Choose another
      </button>

      <StageActions>
        <SheetClose className="btn btn--ghost" onClose={props.onClose}>
          Cancel
        </SheetClose>
        <button type="button" className="btn btn--go" onClick={props.onNext}>
          Looks right
        </button>
      </StageActions>
    </>
  );
}

// ============================================================== three ======
// FRAME RATE.

function FpsStage(props: { fps: Fps; onPick: (fps: Fps) => void; onBack: () => void; onNext: () => void }) {
  return (
    <>
      {/* Said once, quietly, and never again. */}
      <p className="camnote sl-lede">{FPS_WARNING}</p>

      <div className="sl-grid" role="group" aria-label="Frame rate">
        {FPS_OPTIONS.map(({ fps, note }) => (
          <button
            key={fps}
            type="button"
            className="sl-opt"
            data-on={props.fps === fps ? '' : undefined}
            aria-pressed={props.fps === fps}
            onClick={() => {
              haptics.tap();
              props.onPick(fps);
            }}
          >
            <b className="tnum">{fps}</b>
            <span>{note}</span>
          </button>
        ))}
      </div>

      <StageActions>
        <button type="button" className="btn btn--ghost" onClick={props.onBack}>
          Back
        </button>
        <button type="button" className="btn btn--go" onClick={props.onNext}>
          Continue
        </button>
      </StageActions>
    </>
  );
}

// =============================================================== four ======
// CAMERA.

/** "Sony A7 / FX (C0001)" -> "Sony A7 / FX". The card draws the real clip name
 *  underneath, so carrying a second, shorter copy of it in the title would be
 *  the same string twice at two different lengths. */
function presetName(label: string): string {
  return label.replace(/\s*\([^()]*\)\s*$/, '');
}

function CameraStage(props: {
  camera: string;
  onPick: (id: string) => void;
  onBack: () => void;
  onNext: () => void;
}) {
  const chosen = findPreset(props.camera);
  return (
    <>
      <p className="camnote sl-lede">Pick the camera writing the files. Match it to what is on the card.</p>

      <div className="sl-cams" role="group" aria-label="Camera">
        {CAMERA_PRESETS.map((p) => {
          const on = props.camera === p.id;
          return (
            <button
              key={p.id}
              type="button"
              className="sl-cam"
              data-on={on ? '' : undefined}
              aria-pressed={on}
              onClick={() => {
                haptics.tap();
                props.onPick(p.id);
              }}
            >
              <span className="sl-cam__head">
                <b>{presetName(p.label)}</b>
                {/* The badge rides the CHOSEN card only. Twelve pills at rest
                    was a wall of brass, and exact-vs-approximate is not how
                    anyone picks: you pick by recognising the filename under
                    the name. How literally we can promise that filename is
                    what you want to know once you have. */}
                {on && (
                  <span className={`cambadge${p.exact ? '' : ' cambadge--approx'}`}>
                    {p.exact ? 'exact' : 'approximate'}
                  </span>
                )}
              </span>
              <span className="sl-cam__eg tnum">
                {renderClip(p.prefix, 1, p.digits, p.suffix)}
                {p.ext}
              </span>
            </button>
          );
        })}
      </div>

      {/* The caveat, for the one preset actually chosen. Twelve notes rendered
          at rest would be a page of small print nobody reads; one, attached to
          a decision just made, is the moment it means something. */}
      {chosen?.note && <p className="camnote sl-camnote">{chosen.note}</p>}

      <StageActions>
        <button type="button" className="btn btn--ghost" onClick={props.onBack}>
          Back
        </button>
        <button type="button" className="btn btn--go" onClick={props.onNext}>
          Continue
        </button>
      </StageActions>
    </>
  );
}

// =============================================================== five ======
// NAME AND GO.

function NameStage(props: {
  pack: ScriptPack;
  name: string;
  fps: Fps;
  camera: string;
  busy: boolean;
  onName: (name: string) => void;
  onBack: () => void;
  onGo: () => void;
}) {
  const preset = findPreset(props.camera);
  const clip = renderClip(preset?.prefix ?? 'C', 1, preset?.digits ?? 4, preset?.suffix ?? '') + (preset?.ext ?? '.MP4');
  const shots = props.pack.scenes.reduce((n, s) => n + (s.shots?.length ?? 0), 0);
  const ready = props.name.trim().length > 0 && !props.busy;

  return (
    <>
      <div className="formrow">
        <label className="label" htmlFor="sl-name">
          Project name
        </label>
        <input
          id="sl-name"
          className="field"
          value={props.name}
          placeholder="e.g. The Last Monsoon"
          onChange={(e) => props.onName(e.target.value)}
        />
      </div>

      {/* The receipt: the four things just decided, in one block, before the
          one action that spends them. */}
      <dl className="sl-receipt">
        <div className="sl-receipt__row">
          <dt>Shot division</dt>
          <dd>
            <span className="tnum">{props.pack.scenes.length}</span> scenes{' '}
            <span aria-hidden="true">&middot;</span> <span className="tnum">{shots}</span> shots
          </dd>
        </div>
        <div className="sl-receipt__row">
          <dt>Frame rate</dt>
          <dd className="tnum">{props.fps} fps</dd>
        </div>
        <div className="sl-receipt__row">
          <dt>Links in Premiere as</dt>
          <dd className="tnum">{clip}</dd>
        </div>
      </dl>

      <StageActions>
        <button type="button" className="btn btn--ghost" onClick={props.onBack} disabled={props.busy}>
          Back
        </button>
        <button type="button" className="btn btn--go" disabled={!ready} onClick={props.onGo}>
          {props.busy ? 'Loading scenes…' : 'Start the shoot'}
        </button>
      </StageActions>
    </>
  );
}
