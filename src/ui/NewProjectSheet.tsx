// NEW PROJECT. One draft, two roads, built from the same six stage bodies.
//
// TWO FLOWS SHARE THIS SHEET NOW, chosen by the `flow` prop:
//
//   DIRECTOR (the default: every call site that does not pass `flow` gets
//   this, which is both the Projects tab's plain "New project" button and
//   Home's Director mode) walks SIX stages:
//     1 NAME       what the shoot is called. One field, big, nothing else.
//     2 FRAME RATE eight big targets. Said once, quietly, that this lands in
//                  every exported timecode and is painful to correct later.
//     3 CAMERAS    a card per unit, LETTER + camera + STARTING CLIP NUMBER +
//                  OPERATOR (see the reversal note below).
//     4 SOUND      off or on; on asks for the mixer, the recorder, the prefix.
//     5 SHOT LIST  upload a PDF or skip it. Not a gate: the project this
//                  closes on exists either way.
//     6 READY      a receipt of every decision, then one confirm.
//
//   PODCAST (Home's Podcast mode only) walks FOUR stages: no frame rate
//   (inherited from the most recent podcast project, 24 when there is none,
//   still changeable afterwards) and no shot list (a podcast has no scenes):
//     1 NAME, 2 CAMERAS, 3 SOUND, 4 READY.
//   It still stands up exactly what `startPodcastRoll` used to build wholesale
//   (see newRoll.ts): `mode: 'podcast'`, podcast-flavoured default tags, and
//   one slate named "Recording", now assembled from whatever the Cameras and
//   Sound stages actually decided, instead of hardcoded defaults.
//
// THE REVERSAL. This file used to say the starting clip number belonged on
// the project screen, not here: a preset can only guess it. The owner
// overruled that: the number typed on set is the one the camera body ALREADY
// SHOWS, which a preset genuinely cannot know, so it is asked on the Cameras
// stage now (see ./projectdraft's UnitDraft.startNumber). Everything else the
// original note listed (clip prefix, padding, suffix, file extension, the
// sound counter's padding and extension, and the quick-tag list) is still
// deliberately not asked here, for the reason the note always gave: every one
// of them is on the project screen the second this closes (ProjectScreen.tsx:
// the per-unit counter rows, the sound rows and the Quick tags editor), and
// every one of them has a right answer derived from the camera preset the
// operator just picked. Asking for four cameras' worth of padding on a phone,
// standing up, is the fourteen-field form again wearing a progress rail.
//
// THE SHOT LIST STAGE IS NOT A SECOND PDF READER. It mounts ShotlistSheet's
// own `DocumentStage` (exported from ShotlistSheet.tsx for exactly this),
// footer swapped for Back + Skip. See ShotListStage below. The read, the
// parse, the sign-in gate and the free-tier counter all stay owned there, in
// one place.
//
// THE CHROME IS NOT WRITTEN HERE. StageRail, StagePanel and StageActions come
// from ./stages, and the .sl-* classes they and the option cards use are the
// shotlist flow's: that is the point of extracting them. Because the two
// flows carry different stage counts, StageRail's `total` is read off
// whichever STAGES array `flow` picked, never a literal number. That is what
// keeps "3 of 5" honest on a "3 of 4" run.
//
// THE OBJECT THIS BUILDS IS NOT WRITTEN HERE EITHER. ./projectdraft owns the
// draft and the turn into `store.createProject`'s argument, under test, because
// a fourth camera that never reached the object looks identical on screen to
// one that did.

import { useEffect, useState, type ReactNode } from 'react';
import type { Fps, Project, Slate } from '../types';
import { store } from '../store';
import { Sheet, SheetClose } from './common';
import { StageRail, StagePanel, StageActions, type StageDir } from './stages';
import { CAMERA_PRESETS, findPreset, renderClip, soundBadgeStyle } from './cameras';
import { FPS_OPTIONS, FPS_WARNING } from './fps';
import { getDefaultTags } from './tagdefaults';
import { track } from '../net/analytics';
import * as haptics from './haptics';
import { DocumentStage } from './ShotlistSheet';
import { SignInSheet } from './SignInSheet';
import { importScriptPack, type ScriptPack } from './scriptpack';
import { PODCAST_SLATE_NAME, pickResumeProject, scratchName } from './newRoll';
import {
  addUnit,
  buildPodcastProjectConfig,
  buildProjectConfig,
  canAddUnit,
  emptyDraft,
  isReady,
  letterAt,
  newSoundDraft,
  removeUnit,
  setUnit,
  soundExample,
  unitExample,
  type ProjectDraft,
  type SoundDraft,
} from './projectdraft';

/** Which road the sheet walks. Absent (every call site that does not pass
 *  it) is DIRECTOR: the Projects tab's plain "New project" button and Home's
 *  Director mode both get the six-stage flow with the skippable shot list. */
export type NewProjectFlow = 'director' | 'podcast';

type Stage = 'name' | 'fps' | 'cameras' | 'sound' | 'shotlist' | 'ready';

const DIRECTOR_STAGES: readonly Stage[] = ['name', 'fps', 'cameras', 'sound', 'shotlist', 'ready'];
// No frame rate (inherited, see below) and no shot list (a podcast has no
// scenes to break down).
const PODCAST_STAGES: readonly Stage[] = ['name', 'cameras', 'sound', 'ready'];

const STAGE_TITLE: Record<Stage, string> = {
  name: 'New project',
  fps: 'Frame rate',
  cameras: 'Cameras',
  sound: 'Sound',
  shotlist: 'Shot list',
  ready: 'Ready',
};

/** "Sony A7 / FX (C0001)" -> "Sony A7 / FX". The filename is drawn separately,
 *  in full, so carrying a truncated second copy of it in the title is the same
 *  string twice at two different lengths. */
function presetName(label: string): string {
  return label.replace(/\s*\([^()]*\)\s*$/, '');
}

export function NewProjectSheet(props: {
  flow?: NewProjectFlow;
  onClose: () => void;
  /** `slate` is only ever populated for the Podcast road: its "Recording"
   *  slate, made the moment the project is (see `create` below). The
   *  Director road hands back `undefined`; every existing caller that only
   *  reads `project` keeps working unchanged. */
  onCreated: (project: Project, slate?: Slate) => void;
}) {
  const flow = props.flow ?? 'director';
  const STAGES = flow === 'podcast' ? PODCAST_STAGES : DIRECTOR_STAGES;

  const [draft, setDraft] = useState<ProjectDraft>(() => {
    const base = emptyDraft(getDefaultTags(flow === 'podcast' ? 'podcast' : 'video'));
    if (flow !== 'podcast') return base;
    return {
      ...base,
      // A real name typed here always wins; this is only a starting point so
      // tapping straight through still lands on a name that tells two
      // same-day sessions apart (see scratchName's own header note).
      name: scratchName(Date.now(), 'Podcast'),
      // Sound is the product on a podcast: the owner's own framing for why
      // frame rate gets skipped here. On by default; "No sound" is still one
      // tap away on the Sound stage for the shoot that genuinely has none.
      sound: newSoundDraft(),
    };
  });
  const [stage, setStage] = useState<Stage>('name');
  const [dir, setDir] = useState<StageDir>('fwd');
  const [busy, setBusy] = useState(false);
  // Which unit is having its camera chosen, if any. A sub-view of the CAMERAS
  // stage rather than a stage of its own: the rail must not claim the flow got
  // longer because somebody tapped a camera row.
  const [picking, setPicking] = useState<number | null>(null);
  // The Shot list stage's own decision, director road only: a parsed pack, or
  // null once "Skip" (or nothing yet) has been chosen. Ready and create()
  // both read this rather than a second source of truth.
  const [shotlistPack, setShotlistPack] = useState<ScriptPack | null>(null);
  // A 401 anywhere in the Shot list stage swaps the whole sheet for sign-in,
  // same contract ShotlistSheet's own stage one keeps.
  const [showSignIn, setShowSignIn] = useState(false);

  // PODCAST'S FRAME RATE, INHERITED. No stage ever asks for it: it starts at
  // 24 (emptyDraft's default) and, the moment the most recently touched
  // podcast project on this phone is known, quietly becomes that project's
  // fps instead. Reuses newRoll's own "most recent project of this mode"
  // read rather than inventing a second lookup. This is NOT resolveRoll,
  // which deliberately never looks at existing projects; that rule is about
  // the one-tap roll target, not this draft's starting value.
  useEffect(() => {
    if (flow !== 'podcast') return;
    let active = true;
    void store.listProjects().then((projects) => {
      if (!active) return;
      const recent = pickResumeProject(projects, 'podcast');
      if (recent) setDraft((d) => ({ ...d, fps: recent.fps }));
    });
    return () => {
      active = false;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [flow]);

  const index = STAGES.indexOf(stage);

  function go(next: Stage) {
    setDir(STAGES.indexOf(next) > index ? 'fwd' : 'back');
    haptics.tap();
    setPicking(null);
    setStage(next);
  }

  async function create() {
    if (busy || !isReady(draft)) return;
    setBusy(true);
    try {
      let project: Project;
      let slate: Slate | undefined;
      if (flow === 'podcast') {
        project = await store.createProject(buildPodcastProjectConfig(draft));
        slate = await store.createSlate(project.id, PODCAST_SLATE_NAME);
      } else if (shotlistPack) {
        // The stage-1-typed name is the ground truth, not the PDF's own
        // title. buildProjectConfig already carries it, so overriding with
        // the draft's build hands importScriptPack exactly what every other
        // decision on this sheet agreed to.
        project = await importScriptPack(shotlistPack, buildProjectConfig(draft));
      } else {
        project = await store.createProject(buildProjectConfig(draft));
      }
      track('project_created', {
        mode: flow === 'podcast' ? 'podcast' : shotlistPack ? 'script' : 'normal',
        cameras: draft.units.length,
        sound: draft.sound !== null,
      });
      haptics.tap();
      props.onCreated(project, slate);
    } catch {
      setBusy(false);
    }
  }

  if (showSignIn) return <SignInSheet onClose={props.onClose} />;

  return (
    <Sheet title={STAGE_TITLE[stage]} onClose={busy ? undefined : props.onClose}>
      {/* `.dt-sheet` re-materials the shared badges inside a sheet; `.sl` is the
          staged flow's own scope (see styles.css), and `.np` is only what these
          stages add. */}
      <div className="dt-sheet sl np">
        <StageRail index={index} total={STAGES.length} title={STAGE_TITLE[stage]} />

        {/* Keyed so the panel remounts and its enter animation replays — and
            keyed on the picker too, because opening it is a move sideways and
            reads as one. */}
        <StagePanel dir={dir} key={`${stage}:${picking ?? ''}`}>
          {stage === 'name' && (
            <NameStage
              name={draft.name}
              onName={(name) => setDraft((d) => ({ ...d, name }))}
              onClose={props.onClose}
              onNext={() => go(flow === 'podcast' ? 'cameras' : 'fps')}
            />
          )}

          {stage === 'fps' && (
            <FpsStage
              fps={draft.fps}
              onPick={(fps) => setDraft((d) => ({ ...d, fps }))}
              onBack={() => go('name')}
              onNext={() => go('cameras')}
            />
          )}

          {stage === 'cameras' &&
            (picking === null ? (
              <CamerasStage
                draft={draft}
                onAdd={() => {
                  haptics.tap();
                  setDraft(addUnit);
                }}
                onRemove={(i) => {
                  haptics.tap();
                  setDraft((d) => removeUnit(d, i));
                }}
                onOperator={(i, operator) => setDraft((d) => setUnit(d, i, { operator }))}
                onStartNumber={(i, startNumber) => setDraft((d) => setUnit(d, i, { startNumber }))}
                onPick={(i) => {
                  haptics.tap();
                  setDir('fwd');
                  setPicking(i);
                }}
                onBack={() => go(flow === 'podcast' ? 'name' : 'fps')}
                onNext={() => go('sound')}
              />
            ) : (
              <PickCameraStage
                letter={letterAt(picking)}
                camera={draft.units[picking].camera}
                onPick={(camera) => {
                  haptics.tap();
                  setDraft((d) => setUnit(d, picking, { camera }));
                  setDir('back');
                  setPicking(null);
                }}
                onBack={() => {
                  haptics.tap();
                  setDir('back');
                  setPicking(null);
                }}
              />
            ))}

          {stage === 'sound' && (
            <SoundStage
              sound={draft.sound}
              onOff={() => {
                haptics.tap();
                setDraft((d) => ({ ...d, sound: null }));
              }}
              onOn={() => {
                haptics.tap();
                setDraft((d) => (d.sound ? d : { ...d, sound: newSoundDraft() }));
              }}
              onField={(patch) =>
                setDraft((d) => (d.sound ? { ...d, sound: { ...d.sound, ...patch } } : d))
              }
              onBack={() => go('cameras')}
              onNext={() => go(flow === 'director' ? 'shotlist' : 'ready')}
            />
          )}

          {stage === 'shotlist' && (
            <ShotListStage
              onPack={(pack) => {
                setShotlistPack(pack);
                go('ready');
              }}
              onGated={() => setShowSignIn(true)}
              onSkip={() => {
                haptics.tap();
                setShotlistPack(null);
                go('ready');
              }}
              onBack={() => go('sound')}
              onClose={props.onClose}
            />
          )}

          {stage === 'ready' && (
            <ReadyStage
              flow={flow}
              draft={draft}
              shotlistPack={shotlistPack}
              busy={busy}
              onBack={() => go(flow === 'director' ? 'shotlist' : 'sound')}
              onGo={() => void create()}
            />
          )}
        </StagePanel>
      </div>
    </Sheet>
  );
}

// ================================================================ one ======
// NAME. One field, and the only thing on the screen.

function NameStage(props: {
  name: string;
  onName: (name: string) => void;
  onClose: () => void;
  onNext: () => void;
}) {
  const ready = props.name.trim().length > 0;
  return (
    <>
      <div className="formrow">
        <label className="label" htmlFor="np-name">
          Project name
        </label>
        <input
          id="np-name"
          className="field np-name"
          value={props.name}
          autoFocus
          enterKeyHint="next"
          placeholder="e.g. The Last Monsoon"
          onChange={(e) => props.onName(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter' && ready) props.onNext();
          }}
        />
      </div>
      <p className="camnote sl-lede">
        What the crew calls the shoot. It heads every export and every PDF shot log.
      </p>

      <StageActions>
        <SheetClose className="btn btn--ghost" onClose={props.onClose}>
          Cancel
        </SheetClose>
        <button type="button" className="btn btn--go" disabled={!ready} onClick={props.onNext}>
          Continue
        </button>
      </StageActions>
    </>
  );
}

// ================================================================ two ======
// FRAME RATE. The same eight targets the shotlist flow offers, from the same list.

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

// ============================================================== three ======
// CAMERAS. The rig, one card per unit.

function CamerasStage(props: {
  draft: ProjectDraft;
  onAdd: () => void;
  onRemove: (i: number) => void;
  onOperator: (i: number, operator: string) => void;
  onStartNumber: (i: number, startNumber: string) => void;
  onPick: (i: number) => void;
  onBack: () => void;
  onNext: () => void;
}) {
  const { units } = props.draft;
  const more = canAddUnit(props.draft);
  const nextLetter = letterAt(units.length);

  return (
    <>
      <p className="camnote sl-lede">
        Each camera keeps its own clip numbers. The letter is what tells two of the same body
        apart in the edit, so two cameras writing C0001 is fine.
      </p>

      <div className="np-units">
        {units.map((u, i) => {
          const letter = letterAt(i);
          const preset = findPreset(u.camera);
          return (
            <div className="np-unit" key={letter}>
              <div className="np-unit__head">
                <span className="np-unit__letter" aria-hidden="true">
                  {letter}
                </span>
                <span className="np-unit__eg tnum">{unitExample(u)}</span>
                {i > 0 && (
                  <button
                    type="button"
                    className="np-unit__drop"
                    aria-label={`Remove camera ${letter}`}
                    onClick={() => props.onRemove(i)}
                  >
                    Remove
                  </button>
                )}
              </div>

              {/* The camera is chosen by RECOGNISING ITS FILENAME, which is why
                  this opens a list of cards rather than being a <select> of
                  menu names nobody can map to the body in their hands. */}
              <button type="button" className="np-pick" onClick={() => props.onPick(i)}>
                <span className="label">Camera</span>
                <span className="np-pick__val">{preset ? presetName(preset.label) : 'Choose'}</span>
                <span className="np-pick__go" aria-hidden="true">
                  Change
                </span>
              </button>

              {/* The number this unit's next clip will carry: what the camera
                  BODY already shows, which is exactly why a preset cannot
                  supply it. Same field shape and the same clamp as
                  ProjectScreen's own clip counter (clampClipNumber, cameras.ts),
                  so the two never disagree about what "1" means. Feeds the
                  filename preview above live. */}
              <div className="formrow np-unit__op">
                <label className="label" htmlFor={`np-start-${letter}`}>
                  Starting clip number
                </label>
                <input
                  id={`np-start-${letter}`}
                  className="field field--mono"
                  inputMode="numeric"
                  placeholder="1"
                  value={u.startNumber}
                  onChange={(e) => props.onStartNumber(i, e.target.value.replace(/[^0-9]/g, ''))}
                />
              </div>

              <div className="formrow np-unit__op">
                <label className="label" htmlFor={`np-op-${letter}`}>
                  Operator <span className="section__note">optional</span>
                </label>
                <input
                  id={`np-op-${letter}`}
                  className="field"
                  placeholder="e.g. Rohan"
                  value={u.operator}
                  onChange={(e) => props.onOperator(i, e.target.value)}
                />
              </div>
            </div>
          );
        })}
      </div>

      {/* ONE TAP, and it says which letter it is about to make. */}
      {more ? (
        <button type="button" className="np-add" onClick={props.onAdd}>
          <span className="np-add__plus" aria-hidden="true">
            +
          </span>
          Add camera {nextLetter}
        </button>
      ) : (
        <p className="camnote np-full">
          Four cameras is the limit — A, B, C and D are every letter the log can carry.
        </p>
      )}

      <p className="visually-hidden" role="status">
        {units.length === 1 ? 'One camera' : `${units.length} cameras`}, A to {letterAt(units.length - 1)}
      </p>

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

/** One unit's camera, chosen off the filename each preset writes. */
function PickCameraStage(props: {
  letter: string;
  camera: string;
  onPick: (id: string) => void;
  onBack: () => void;
}) {
  const chosen = findPreset(props.camera);
  return (
    <>
      <p className="camnote sl-lede">
        Camera {props.letter}. Match it to the filenames on the card.
      </p>

      <div className="sl-cams" role="group" aria-label={`Camera ${props.letter}`}>
        {CAMERA_PRESETS.map((p) => {
          const on = props.camera === p.id;
          return (
            <button
              key={p.id}
              type="button"
              className="sl-cam"
              data-on={on ? '' : undefined}
              aria-pressed={on}
              onClick={() => props.onPick(p.id)}
            >
              <span className="sl-cam__head">
                <b>{presetName(p.label)}</b>
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

      {/* The caveat, for the one preset actually chosen. */}
      {chosen?.note && <p className="camnote sl-camnote">{chosen.note}</p>}

      <StageActions>
        <button type="button" className="btn btn--ghost" onClick={props.onBack}>
          Back
        </button>
      </StageActions>
    </>
  );
}

// =============================================================== four ======
// SOUND. Off is one tap and a real answer.

function SoundStage(props: {
  sound: SoundDraft | null;
  onOff: () => void;
  onOn: () => void;
  onField: (patch: Partial<SoundDraft>) => void;
  onBack: () => void;
  onNext: () => void;
}) {
  const on = props.sound !== null;
  return (
    <>
      <p className="camnote sl-lede">
        A separate recorder, independent of how many cameras are on the shoot. It rolls its own
        files onto the same take.
      </p>

      <div className="sl-grid" role="group" aria-label="Production sound">
        <button
          type="button"
          className="sl-opt"
          data-on={!on ? '' : undefined}
          aria-pressed={!on}
          onClick={props.onOff}
        >
          <b>No sound</b>
          <span>In-camera only</span>
        </button>
        <button
          type="button"
          className="sl-opt"
          data-on={on ? '' : undefined}
          aria-pressed={on}
          onClick={props.onOn}
        >
          <b>Sound</b>
          <span>A recorder rolls</span>
        </button>
      </div>

      {props.sound && (
        <div className="np-unit np-unit--sound">
          <div className="np-unit__head">
            <span className="np-unit__letter" style={soundBadgeStyle} aria-hidden="true">
              S
            </span>
            <span className="np-unit__eg tnum">{soundExample(props.sound)}</span>
          </div>

          <div className="formrow np-unit__op">
            <label className="label" htmlFor="np-sound-op">
              Mixer <span className="section__note">optional</span>
            </label>
            <input
              id="np-sound-op"
              className="field"
              placeholder="e.g. Priya"
              value={props.sound.operator}
              onChange={(e) => props.onField({ operator: e.target.value })}
            />
          </div>

          <div className="formrow np-unit__op">
            <label className="label" htmlFor="np-sound-rec">
              Recorder <span className="section__note">optional</span>
            </label>
            <input
              id="np-sound-rec"
              className="field"
              placeholder="e.g. MixPre-6"
              value={props.sound.recorder}
              onChange={(e) => props.onField({ recorder: e.target.value })}
            />
          </div>

          <div className="formrow np-unit__op">
            <label className="label" htmlFor="np-sound-prefix">
              File prefix
            </label>
            <input
              id="np-sound-prefix"
              className="field field--mono"
              placeholder="SND_"
              value={props.sound.filePrefix}
              onChange={(e) => props.onField({ filePrefix: e.target.value })}
            />
          </div>
        </div>
      )}

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
// SHOT LIST. Director road only. Upload a PDF or skip it. Mounts
// ShotlistSheet's own DocumentStage rather than a second reader; see the file
// header and DocumentStage's `footer` prop in ShotlistSheet.tsx.

function ShotListStage(props: {
  onPack: (pack: ScriptPack) => void;
  onGated: () => void;
  onSkip: () => void;
  onBack: () => void;
  onClose: () => void;
}) {
  return (
    <>
      <p className="camnote sl-lede">
        Every scene and numbered shot, read off the PDF. Skip it and the project opens
        with none. Scenes can still be added by hand once it does.
      </p>
      <DocumentStage
        onPack={props.onPack}
        onGated={props.onGated}
        onClose={props.onClose}
        footer={(busy) => (
          <StageActions>
            <button type="button" className="btn btn--ghost" onClick={props.onBack} disabled={busy}>
              Back
            </button>
            <button type="button" className="btn btn--go" onClick={props.onSkip} disabled={busy}>
              Skip
            </button>
          </StageActions>
        )}
      />
    </>
  );
}

// =============================================================== six ======
// READY. Every decision, once, before the one action that spends them.

function ReadyStage(props: {
  flow: NewProjectFlow;
  draft: ProjectDraft;
  shotlistPack: ScriptPack | null;
  busy: boolean;
  onBack: () => void;
  onGo: () => void;
}) {
  const { draft } = props;
  const approx = draft.units.some((u) => {
    const p = findPreset(u.camera);
    return p ? !p.exact : false;
  });
  const shots = props.shotlistPack?.scenes.reduce((n, s) => n + (s.shots?.length ?? 0), 0) ?? 0;

  return (
    <>
      <p className="camnote sl-lede">
        Everything below is editable on the project screen the moment this closes — clip
        numbering, operators, tags and all.
      </p>

      <dl className="sl-receipt">
        <div className="sl-receipt__row">
          <dt>Name</dt>
          <dd>{draft.name.trim()}</dd>
        </div>
        <div className="sl-receipt__row">
          <dt>Frame rate</dt>
          <dd className="tnum">{draft.fps} fps</dd>
        </div>
        {props.flow === 'director' && (
          <div className="sl-receipt__row">
            <dt>Shot list</dt>
            <dd>
              {props.shotlistPack ? (
                <>
                  <span className="tnum">{props.shotlistPack.scenes.length}</span> scenes{' '}
                  <span aria-hidden="true">&middot;</span> <span className="tnum">{shots}</span> shots
                </>
              ) : (
                'Skipped'
              )}
            </dd>
          </div>
        )}
        {draft.units.map((u, i) => (
          <div className="sl-receipt__row" key={letterAt(i)}>
            <dt>
              Camera {letterAt(i)}
              {u.operator.trim() && <span className="np-receipt__who"> · {u.operator.trim()}</span>}
            </dt>
            <dd className="tnum">{unitExample(u)}</dd>
          </div>
        ))}
        <div className="sl-receipt__row">
          <dt>
            Sound
            {draft.sound?.operator.trim() && (
              <span className="np-receipt__who"> · {draft.sound.operator.trim()}</span>
            )}
          </dt>
          <dd className={draft.sound ? 'tnum' : undefined} style={draft.sound ? { color: 'var(--sound-text)' } : undefined}>
            {draft.sound ? soundExample(draft.sound) : 'None'}
          </dd>
        </div>
      </dl>

      {/* An approximate filename is not an error — it is a camera stamping a
          record time or a date nobody can know in advance (see cameras.ts).
          Said once, in brass as a line of type, never in red. */}
      {approx && (
        <p className="camnote np-approx">
          Some of these names carry a <span className="tnum">*</span> the camera fills in at record
          time. Match those files by their number.
        </p>
      )}

      <StageActions>
        <button type="button" className="btn btn--ghost" onClick={props.onBack} disabled={props.busy}>
          Back
        </button>
        <button
          type="button"
          className="btn btn--go"
          disabled={props.busy || !isReady(draft)}
          onClick={props.onGo}
        >
          {/* The receipt directly above says how many cameras and whether sound
              is on. Saying it again on the button only made the label wrap to
              two lines on a 390px phone. */}
          {props.busy ? 'Creating…' : 'Create project'}
        </button>
      </StageActions>
    </>
  );
}
