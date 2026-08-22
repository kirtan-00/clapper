// SHOTLIST — upload a shot division as a PDF and stand it up as a project.
//
// Two steps in one sheet: READ the document, then SET UP the shoot. The read is
// the interesting half and none of it is written here — every piece of it is
// the same module the projects list has always called:
//
//   pdftext.extractPdfText   the text off the PDF, on the device
//   shotlist.parseShotlist   the scene/shot table, on the device, exactly
//   scriptpack.importScriptPack   the pack -> a Project with one Slate per scene
//   breakdown.enrichShotMoments   the ONE server call: key-moment chips
//
// So the structure of your document never leaves the phone. Only the parsed
// shot division goes out, and only to write the tappable chips.
//
// WHY THIS FILE EXISTS AT ALL: the same flow is currently a private component
// inside ProjectsScreen.tsx, which was locked for edits while Home was built.
// The LOGIC is shared to the last line; only this JSX is new. Folding the two
// back together is a follow-up, and it belongs in ProjectsScreen's file.
//
// The setup step is deliberately three fields, not the fourteen of the New
// project sheet. Name, frame rate, camera — the ones that are painful to
// correct after the fact (frame rate lands in every exported timecode). Clip
// prefix, padding, multi-cam and sound are all editable on the project screen
// the moment this closes, so asking for them here would be ceremony.

import { useEffect, useState, type ChangeEvent } from 'react';
import type { Fps, Project } from '../types';
import { Sheet, SheetClose } from './common';
import { CAMERA_PRESETS, findPreset, renderClip } from './cameras';
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

const FPS_OPTIONS: Fps[] = [23.976, 24, 25, 29.97, 30, 50, 59.94, 60];

export function ShotlistSheet(props: { onClose: () => void; onImported: (project: Project) => void }) {
  const [pack, setPack] = useState<ScriptPack | null>(null);

  if (pack) {
    return <SetupStep pack={pack} onClose={props.onClose} onImported={props.onImported} />;
  }
  return <ReadStep onClose={props.onClose} onPack={setPack} />;
}

// ----------------------------------------------------------- step one -----

function ReadStep(props: { onClose: () => void; onPack: (pack: ScriptPack) => void }) {
  const { session, loading } = useSession();
  const [phase, setPhase] = useState<'idle' | 'reading' | 'thinking'>('idle');
  const [error, setError] = useState<string | null>(null);
  const [showSignIn, setShowSignIn] = useState(false);
  const [signingIn, setSigningIn] = useState(false);
  const [usage, setUsage] = useState<Usage | null>(null);
  // True once the breakdown is refused for being out of free uses.
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
    // Fired the moment a file is picked, before we know if it's readable -
    // distinct from `shotlist_parsed` below on purpose. Without this the
    // funnel can't tell "nobody tries to upload a shot list" apart from
    // "people try and the parser rejects them"; those are different bugs.
    track('shotlist_uploaded', { surface: 'sheet' });
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

      // The structure is already ours and already correct. Chips are the only
      // thing left that can fail, so a refusal still hands the shots over —
      // the operator gets their breakdown, just without the taps.
      setPhase('thinking');
      const enriched = await enrichShotMoments(parsed, file.name);
      haptics.tap();
      props.onPack(enriched);
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
      {/* One line. The four-line version of this (what a numbered shot looks
          like, what the size column is, what happens to the document, what the
          key moments are for) is in the guide under "Setting up a project". */}
      <p className="camnote">Every scene and numbered shot, read off the PDF.</p>

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
              {usage.script.left} of {FREE_LIMITS.script} breakdowns left
            </p>
          )}
        </>
      ) : (
        <>
          <button
            type="button"
            className="btn btn--go btn--full"
            style={{ marginTop: 14 }}
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

      <div className="sheet__actions">
        <SheetClose className="btn btn--ghost" onClose={props.onClose} disabled={busy}>
          Close
        </SheetClose>
      </div>
    </Sheet>
  );
}

// ----------------------------------------------------------- step two -----

function SetupStep(props: { pack: ScriptPack; onClose: () => void; onImported: (project: Project) => void }) {
  const [name, setName] = useState(props.pack.project.name);
  const [fps, setFps] = useState<Fps>(24);
  const [camera, setCamera] = useState('custom');
  const [busy, setBusy] = useState(false);

  const preset = findPreset(camera);
  const prefix = preset?.prefix ?? 'C';
  const suffix = preset?.suffix ?? '';
  const padding = preset?.digits ?? 4;
  const ext = preset?.ext ?? '.MP4';
  const example = renderClip(prefix, 1, padding, suffix);

  const shotCount = props.pack.scenes.reduce((n, s) => n + (s.shots?.length ?? 0), 0);
  const canStart = name.trim().length > 0 && !busy;

  async function create() {
    if (!canStart) return;
    setBusy(true);
    try {
      const project = await importScriptPack(props.pack, {
        name: name.trim(),
        fps,
        camera,
        clipPrefix: prefix,
        clipSuffix: suffix,
        clipExt: ext,
        clipPadding: padding,
        nextClipNumber: 1,
      });
      track('project_created', { mode: 'script', cameras: 1, sound: false });
      haptics.tap();
      props.onImported(project);
    } catch {
      setBusy(false);
    }
  }

  return (
    <Sheet title="Set up the shoot" onClose={busy ? undefined : props.onClose}>
      {/* `.dt-sheet` re-materials the camera-preset badge below (see
          skin/detail.css) — the sheet's grabber, title and slide stay the
          shared <Sheet> chrome, untouched. */}
      <div className="dt-sheet">
      {/* A count, not a paragraph. What used to follow it - that clip
          numbering, extra cameras and sound are all editable afterwards - is a
          reassurance nobody needs before they have hit a wall. */}
      <p className="camnote" style={{ marginTop: 0, marginBottom: 18 }}>
        <span className="tnum">{props.pack.scenes.length}</span> scenes{' '}
        <span aria-hidden="true">&middot;</span> <span className="tnum">{shotCount}</span> shots
        ready
      </p>

      <div className="formrow">
        <label className="label" htmlFor="sl-name">
          Project name
        </label>
        <input
          id="sl-name"
          className="field"
          value={name}
          placeholder="e.g. The Last Monsoon"
          onChange={(e) => setName(e.target.value)}
        />
      </div>

      <div className="formrow">
        <label className="label" htmlFor="sl-camera">
          Camera
        </label>
        <select
          id="sl-camera"
          className="field"
          value={camera}
          onChange={(e) => setCamera(e.target.value)}
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
            <span className="tnum">
              {example}
              {ext}
            </span>
          </span>
          <span className={`cambadge${preset && !preset.exact ? ' cambadge--approx' : ''}`}>
            {preset && !preset.exact ? 'approximate' : 'exact'}
          </span>
        </div>
      </div>

      <div className="formrow">
        <label className="label" htmlFor="sl-fps">
          Frame rate
        </label>
        <select
          id="sl-fps"
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

      <div className="sheet__actions">
        <SheetClose className="btn btn--ghost" onClose={props.onClose} disabled={busy}>
          Cancel
        </SheetClose>
        <button type="button" className="btn btn--go" disabled={!canStart} onClick={() => void create()}>
          {busy ? 'Loading scenes…' : 'Start the shoot'}
        </button>
      </div>
      </div>
    </Sheet>
  );
}
