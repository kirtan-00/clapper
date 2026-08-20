// Correct an already-logged take: the mis-typed clip number(s) first (the main
// ask, driven by a per-camera ClipNumberRows stepper shared with the save-time
// editor in RollingScreen), then the adjacent status / tags / note. This only
// rewrites THIS take's row - it never moves the live per-camera clip counter or
// renumbers other takes without saying so first (see requestSave's preview).
//
// Reachable from two places: RollingScreen (recent takes on the setup currently
// open) and ClipLogScreen (any take ever logged, from any scene or day) - the
// props below are everything either caller can hand over, nothing screen-specific.

import { useEffect, useState } from 'react';
import type { CameraUnit, CameraUnitLetter, Project, Slate, Take, TakeClip, TakeStatus } from '../types';
import { store } from '../store';
import { formatClip, parseClipNumber, rebaseClipNumbers } from '../store/util';
import { renderUnitClip, soundBadgeStyle } from './cameras';
import { Sheet, SheetClose } from './common';
import { SpeakerMark } from './marks';
import * as haptics from './haptics';

/**
 * One clip per camera that rolled this take - the FIRST file each one wrote.
 * Normally that is every clip on the take; a camera that cut and rejoined has
 * more, and they ride the first one's correction rather than being edited on
 * their own (see the note where this is used).
 */
function firstClipPerUnit(take: Take): TakeClip[] {
  const seen = new Set<CameraUnitLetter>();
  const out: TakeClip[] = [];
  for (const clip of take.clips ?? []) {
    if (seen.has(clip.unit)) continue;
    seen.add(clip.unit);
    out.push(clip);
  }
  return out;
}

// The per-unit clip-number stepper stack, shared by the save-time editor
// (MultiClipSheet in RollingScreen.tsx) and the take editor below. Each row
// shows the unit letter (multi-cam), a live formatted preview, and a - / value
// / + control. `showOperator` is opt-in and OFF by default so MultiClipSheet's
// project-settings look is untouched; the take editor turns it on because a
// three-camera take is exactly the case where "which one is B again?" bites.
export function ClipNumberRows(props: {
  units: CameraUnit[];
  nums: string[];
  showLetter?: boolean;
  showOperator?: boolean;
  /** Read-only line under a row, e.g. the other files that unit wrote on this
   *  take after cutting and rejoining. Absent/blank rows render as before. */
  notes?: Array<string | undefined>;
  onNum: (i: number, value: string) => void;
}) {
  const showLetter = props.showLetter !== false;
  const showOperator = props.showOperator === true;
  return (
    <div className="stack">
      {props.units.map((u, i) => {
        const n = Math.max(0, parseInt(props.nums[i], 10) || 0);
        const preview = renderUnitClip({ ...u, nextClipNumber: n }) + (u.clipExt ?? '');
        const who = showLetter ? `camera ${u.letter}` : 'clip';
        return (
          <div key={u.letter} className="camunit">
            <div className="camunit__head">
              {showLetter && <span className="camunit__badge">{u.letter}</span>}
              <span className="camunit__eg tnum">{preview}</span>
            </div>
            {showOperator && u.operator && <div className="camunit__operator">{u.operator}</div>}
            {props.notes?.[i] && <div className="camunit__also">{props.notes[i]}</div>}
            <div className="clipset" style={{ marginBottom: 0 }}>
              <button
                type="button"
                className="clipset__step"
                aria-label={`Lower ${who}`}
                onClick={() => props.onNum(i, String(Math.max(0, n - 1)))}
              >
                &minus;
              </button>
              <input
                className="field field--mono clipset__input"
                inputMode="numeric"
                value={props.nums[i]}
                onChange={(e) => props.onNum(i, e.target.value.replace(/[^0-9]/g, ''))}
              />
              <button
                type="button"
                className="clipset__step"
                aria-label={`Raise ${who}`}
                onClick={() => props.onNum(i, String(n + 1))}
              >
                +
              </button>
            </div>
          </div>
        );
      })}
    </div>
  );
}

export function TakeEditSheet(props: {
  project: Project;
  slate: Slate;
  take: Take;
  onClose: () => void;
  onSaved: (project: Project, shifted: number) => void;
}) {
  const { project, slate, take } = props;
  const multi = (take.clips?.length ?? 0) > 0;

  // Editable per-unit clip definitions rebuilt from the take's recorded clips,
  // using each unit's current prefix/padding/suffix so the stepper reformats
  // exactly like the save-time editor.
  //
  // ONE ROW PER CAMERA, not per clip. A camera that cut and rejoined wrote
  // several files inside this one take, and they are consecutive on its card -
  // so the number that can be wrong is the FIRST one, and correcting it slides
  // the rest by the same amount (withClipNumber in store/util.ts). A row each
  // would let the operator type two conflicting corrections for one card, and
  // only one of them could be obeyed. The others are named under the row so
  // nothing about what the card holds is hidden.
  const [units] = useState<CameraUnit[]>(() =>
    multi
      ? firstClipPerUnit(take).map((clip) => {
          const cam = project.cameras?.find((c) => c.letter === clip.unit);
          const clipPrefix = cam?.clipPrefix ?? project.clipPrefix;
          const clipPadding = cam?.clipPadding ?? project.clipPadding;
          const clipSuffix = cam?.clipSuffix ?? project.clipSuffix ?? '';
          const clipExt = cam?.clipExt ?? project.clipExt ?? '';
          return {
            letter: clip.unit,
            ...(cam?.camera ? { camera: cam.camera } : {}),
            ...(cam?.operator ? { operator: cam.operator } : {}),
            clipPrefix,
            clipPadding,
            clipSuffix,
            clipExt,
            nextClipNumber: parseClipNumber(clip.clipName, clipPrefix, clipSuffix),
          };
        })
      : [
          {
            letter: 'A' as const,
            clipPrefix: project.clipPrefix,
            clipPadding: project.clipPadding,
            clipSuffix: project.clipSuffix ?? '',
            clipExt: project.clipExt ?? '',
            nextClipNumber: parseClipNumber(take.clipName, project.clipPrefix, project.clipSuffix ?? ''),
          },
        ],
  );

  const [nums, setNums] = useState(units.map((u) => String(u.nextClipNumber)));
  // What else each camera wrote on this take, shown read-only beside its row.
  const alsoWrote = units.map((u) => {
    const rest = (take.clips ?? []).filter((c) => c.unit === u.letter).slice(1);
    return rest.length ? `then ${rest.map((c) => c.clipName).join(', ')}` : undefined;
  });
  // This take's sound file number, editable the same way as a camera clip
  // number - only when BOTH the take actually recorded sound AND the project
  // still has a Sound unit (it may have been turned off since this was shot).
  const soundEditable = !!(take.sound && project.sound);
  // The number as this take actually recorded it, kept beside the editable copy
  // so "never touched it" can be told apart from "typed the same value back"
  // (see numbersEdited below).
  const [origSoundNum] = useState(() =>
    take.sound && project.sound
      ? String(parseClipNumber(take.sound.fileName, project.sound.filePrefix, project.sound.fileSuffix ?? ''))
      : '',
  );
  const [soundNum, setSoundNum] = useState(origSoundNum);
  const [status, setStatus] = useState<TakeStatus>(take.status);
  const [note, setNote] = useState(take.note ?? '');
  // Tags live as tagged moments; we surface presence as toggle chips and
  // reconcile on save (add a point moment when turned on, delete the take's
  // moments of that tag when turned off).
  const [activeTags, setActiveTags] = useState<Set<string>>(new Set());
  const [origTags, setOrigTags] = useState<Set<string>>(new Set());
  const [momentIdsByTag, setMomentIdsByTag] = useState<Map<string, string[]>>(new Map());
  const [saving, setSaving] = useState(false);
  // Set when saving would renumber OTHER takes: holds the pending write and a
  // plain-language list of every take that moves, pending the user's go-ahead.
  // `soundOnly` picks the confirmation copy: "the camera" vs "the sound file".
  const [pendingShift, setPendingShift] = useState<{
    newNumbers: Partial<Record<CameraUnitLetter, number>>;
    newSoundNumber?: number;
    moved: string[];
    soundOnly: boolean;
  } | null>(null);

  useEffect(() => {
    let alive = true;
    void store.listMoments(take.id).then((ms) => {
      if (!alive) return;
      const byTag = new Map<string, string[]>();
      for (const m of ms) {
        if (!m.tag) continue;
        const list = byTag.get(m.tag) ?? [];
        list.push(m.id);
        byTag.set(m.tag, list);
      }
      setMomentIdsByTag(byTag);
      setActiveTags(new Set(byTag.keys()));
      setOrigTags(new Set(byTag.keys()));
    });
    return () => {
      alive = false;
    };
  }, [take.id]);

  // Offered chips mirror the rolling deck: scene coverage + GOLD + key beats in
  // Script Mode, else the project quick tags. Any already-present tag outside
  // that set is appended so it stays visible and removable.
  const coverage = (slate.tags ?? [])
    .filter((t) => t.tier === 'coverage')
    .sort((a, b) => a.order - b.order)
    .map((t) => t.label);
  const keyBeats = (slate.tags ?? [])
    .filter((t) => t.tier === 'keyMoment')
    .sort((a, b) => a.order - b.order)
    .map((t) => t.label);
  const scriptMode = coverage.length > 0 || keyBeats.length > 0;
  const offered = scriptMode ? [...coverage, 'GOLD', ...keyBeats] : project.tags;
  const tagChips = [...offered, ...[...origTags].filter((t) => !offered.includes(t))];

  function setNum(i: number, value: string) {
    setNums((prev) => prev.map((v, idx) => (idx === i ? value : v)));
  }
  function toggleTag(tag: string) {
    setActiveTags((prev) => {
      const next = new Set(prev);
      if (next.has(tag)) next.delete(tag);
      else next.add(tag);
      return next;
    });
  }

  const asNumber = (s: string) => Math.max(0, parseInt(s, 10) || 0);

  function typedNumbers(): Partial<Record<CameraUnitLetter, number>> {
    const out: Partial<Record<CameraUnitLetter, number>> = {};
    units.forEach((u, i) => {
      out[u.letter] = asNumber(nums[i]);
    });
    return out;
  }

  /** Did the operator actually move a number in this sheet? */
  function cameraEdited(): boolean {
    return units.some((u, i) => asNumber(nums[i]) !== u.nextClipNumber);
  }
  /**
   * The gate on the rebase: when this is false, every recorded clip and sound
   * name must come back byte-identical.
   *
   * Not an optimisation. The rebase rewrites every name it touches in
   * the project's clip pattern AS IT STANDS TODAY, so a take shot before
   * someone changed a prefix or a padding comes back as a different string: a
   * padding narrowed 4 -> 3 turns C0184 into C184, and a prefix the stored name
   * no longer starts with defeats parseClipNumber entirely, so it reads the
   * counter as 0 and C0184 is rewritten A001_C0000. Both are silent, because a
   * delta of 0 shifts nothing later and therefore never raises the confirmation
   * below. This sheet is now reachable against any take of the whole shoot from
   * the clip log, and most of those taps are a status or a tag, not a number.
   * A clip name is a physical fact about what is on the card, so only a
   * deliberate edit may rewrite it.
   */
  function numbersEdited(): boolean {
    if (cameraEdited()) return true;
    return soundEditable && asNumber(soundNum) !== asNumber(origSoundNum);
  }

  /**
   * Renumbering rewrites takes the user is not looking at - and this sheet can
   * now be opened from ClipLogScreen against a take from any scene or day, not
   * just the setup currently on the rolling screen - so never do it silently.
   * Dry-run the rebase against a copy of the WHOLE PROJECT's takes (a camera's
   * card counter runs across every scene/day until the card is swapped, so
   * that is the correct scope - see rebaseClipNumbers in store/util.ts), and if
   * anything downstream would move, show exactly what and make them agree.
   */
  async function requestSave() {
    if (saving) return;
    haptics.tap();

    const newNumbers = typedNumbers();
    const newSoundNumber = soundEditable ? asNumber(soundNum) : undefined;
    // No number was touched, so there is nothing to renumber and nothing to
    // preview: straight to the status/tags/note write.
    if (!numbersEdited()) {
      void commit(newNumbers, newSoundNumber);
      return;
    }
    const bundle = await store.getBundle(project.id);
    const preview = rebaseClipNumbers(project, bundle.takes, take.id, newNumbers, Date.now(), newSoundNumber);
    const others = preview.takes.filter((t) => t.id !== take.id);

    if (others.length === 0) {
      void commit(newNumbers, newSoundNumber);
      return;
    }

    // List ONLY the clips (and sound file) that actually change, each labelled
    // by ITS OWN scene/shot. A shift can now land on a take from a different
    // scene entirely (this sheet is reachable from the whole clip log), so
    // "take 3" alone is ambiguous the moment two scenes both have a take 3 -
    // label every line the same way ClipLogScreen labels a row: the shot code
    // if it resolves, else the scene name.
    const slateById = new Map(bundle.slates.map((s) => [s.id, s]));
    const was = new Map(bundle.takes.map((t) => [t.id, t]));
    const moved = others
      .slice()
      .sort((a, b) => a.createdAt - b.createdAt)
      .flatMap((t) => {
        const before = was.get(t.id);
        const pairs: string[] = [];
        if (before?.clips?.length && t.clips?.length) {
          for (const clip of t.clips) {
            const old = before.clips.find((c) => c.unit === clip.unit);
            if (old && old.clipName !== clip.clipName) {
              pairs.push(`${clip.unit} ${old.clipName} → ${clip.clipName}`);
            }
          }
        } else if (before && before.clipName !== t.clipName) {
          pairs.push(`${before.clipName} → ${t.clipName}`);
        }
        if (before?.sound && t.sound && before.sound.fileName !== t.sound.fileName) {
          pairs.push(`sound ${before.sound.fileName} → ${t.sound.fileName}`);
        }
        // rebaseClipNumbers hands back a fresh row for every later take it
        // walks, including one that rolled only the cameras this correction did
        // NOT touch, so its names can come back identical. That is not a
        // renumber, and it must not show up as a blank line in a list the
        // operator is being asked to vouch for.
        if (pairs.length === 0) return [];
        const destSlate = slateById.get(t.slateId);
        const destShot =
          destSlate && t.shotId !== undefined ? (destSlate.shots ?? []).find((s) => s.id === t.shotId) : undefined;
        const where = destShot?.code ?? destSlate?.name ?? 'scene';
        return [`${where} take ${t.number}:  ${pairs.join(',  ')}`];
      });

    // Every downstream row came back with its names unchanged, so there is
    // nothing to warn about. Asking anyway teaches the operator to tap through
    // this screen, which is the one screen that must never be tapped through.
    if (moved.length === 0) {
      void commit(newNumbers, newSoundNumber);
      return;
    }

    // Whether THIS take's camera number(s) actually changed - if not, whatever
    // triggered the shift was the sound file, so the confirmation talks about
    // the recorder instead of the camera.
    setPendingShift({ newNumbers, newSoundNumber, moved, soundOnly: !cameraEdited() });
  }

  async function commit(newNumbers: Partial<Record<CameraUnitLetter, number>>, soundNumber?: number) {
    if (saving) return;
    setSaving(true);
    setPendingShift(null);

    // A camera (and, if it recorded sound, the recorder) counts its own files
    // monotonically, so correcting THIS clip/file number means every later
    // one is off by the same delta, and so is the live counter. rebaseClips
    // carries the correction forward (per unit, later shots only) in one
    // atomic write. Skipped entirely when no number was touched, so a
    // status/tag/note edit leaves every recorded name exactly as it was
    // (see numbersEdited).
    const rebased = numbersEdited()
      ? await store.rebaseClips(project.id, take.id, newNumbers, soundNumber)
      : null;

    const trimmedNote = note.trim();
    // Status/tags/note are this row's alone; the clip names were just written
    // by the rebase, so this patch must not carry them.
    await store.updateTake(take.id, {
      status,
      note: trimmedNote ? trimmedNote : undefined,
    });

    for (const tag of activeTags) {
      if (!origTags.has(tag)) {
        await store.createMoment({ takeId: take.id, kind: 'point', atMs: 0, label: '', tag });
      }
    }
    for (const tag of origTags) {
      if (!activeTags.has(tag)) {
        for (const id of momentIdsByTag.get(tag) ?? []) await store.deleteMoment(id);
      }
    }

    props.onSaved(rebased?.project ?? project, rebased?.shifted ?? 0);
  }

  // Renumbering touches shots the user cannot see from here, so it gets its own
  // screen rather than a nested sheet: state below stays mounted, so STOP puts
  // them back on the edit form with every field exactly as they left it.
  if (pendingShift) {
    const n = pendingShift.moved.length;
    const title = pendingShift.soundOnly ? 'This renumbers later sound files' : 'This renumbers later shots';
    const lede = pendingShift.soundOnly
      ? `The recorder kept counting, so correcting this sound file number corrects every later sound file too, and the live counter with it. ${n} later shot${n === 1 ? '' : 's'} will change. If you did not mean to do this, press STOP.`
      : `The camera kept counting, so correcting this clip number corrects every later shot on that camera too, and the live counter with it. ${n} later shot${n === 1 ? '' : 's'} will change. If you did not mean to do this, press STOP.`;
    return (
      <Sheet title={title} lede={lede} onClose={() => setPendingShift(null)}>
        <ul
          style={{
            listStyle: 'none',
            margin: '0 0 4px',
            padding: 0,
            display: 'grid',
            gap: 8,
            fontFamily: 'var(--font-mono)',
            fontSize: '0.82rem',
            color: 'var(--chalk-dim)',
          }}
        >
          {pendingShift.moved.map((line) => (
            <li key={line}>{line}</li>
          ))}
        </ul>
        <div className="sheet__actions">
          <button type="button" className="btn btn--ghost" onClick={() => setPendingShift(null)}>
            STOP
          </button>
          <button
            type="button"
            className="btn btn--go"
            disabled={saving}
            onClick={() => void commit(pendingShift.newNumbers, pendingShift.newSoundNumber)}
          >
            Yes, renumber
          </button>
        </div>
      </Sheet>
    );
  }

  return (
    <Sheet title={`Edit shot ${take.number}`} onClose={props.onClose}>
      {/* `.dt-sheet` re-materials the camera-unit badge, the Good/No good
          toggle and the tag chips below (see skin/detail.css) — this sheet
          is reachable from RollingScreen and ClipLogScreen, neither of
          which carries `.pj`, so it reads the global `--m-*` pair rather
          than a `--pj-*` one that would resolve to nothing here. */}
      <div className="dt-sheet">
      <p className="camnote" style={{ marginTop: 0 }}>
        Fix a mis-logged clip{soundEditable ? ' or sound file' : ''} number, status, tags or note.
        Correcting a number also shifts every LATER shot on that camera{soundEditable ? ' or recorder' : ''}{' '}
        by the same amount, and the live counter with them - it kept counting, so they are all off
        by the same gap. Earlier shots never move.
      </p>

      <ClipNumberRows units={units} nums={nums} notes={alsoWrote} showLetter={multi} showOperator onNum={setNum} />

      {soundEditable && (
        <div className="camunit" style={{ marginTop: 12 }}>
          <div className="camunit__head">
            <span className="camunit__badge" style={soundBadgeStyle} aria-hidden="true"><SpeakerMark /></span>
            <span className="camunit__eg tnum">
              {formatClip(
                project.sound!.filePrefix,
                Math.max(0, parseInt(soundNum, 10) || 0),
                project.sound!.filePadding,
                project.sound!.fileSuffix,
              ) + (project.sound!.fileExt ?? '')}
            </span>
          </div>
          <div className="clipset" style={{ marginBottom: 0 }}>
            <button
              type="button"
              className="clipset__step"
              aria-label="Lower sound file number"
              onClick={() => setSoundNum(String(Math.max(0, (Math.max(0, parseInt(soundNum, 10) || 0)) - 1)))}
            >
              &minus;
            </button>
            <input
              className="field field--mono clipset__input"
              inputMode="numeric"
              value={soundNum}
              onChange={(e) => setSoundNum(e.target.value.replace(/[^0-9]/g, ''))}
            />
            <button
              type="button"
              className="clipset__step"
              aria-label="Raise sound file number"
              onClick={() => setSoundNum(String((Math.max(0, parseInt(soundNum, 10) || 0)) + 1))}
            >
              +
            </button>
          </div>
        </div>
      )}

      <div className="formrow" style={{ marginTop: 16 }}>
        <span className="label">Status</span>
        <div className="camcount" role="group" aria-label="Take status" style={{ gridTemplateColumns: '1fr 1fr' }}>
          <button
            type="button"
            className={`camcount__opt${status === 'good' ? ' camcount__opt--on' : ''}`}
            style={{ fontFamily: 'var(--font-ui)', fontSize: '0.9rem' }}
            aria-pressed={status === 'good'}
            onClick={() => setStatus('good')}
          >
            Good
          </button>
          <button
            type="button"
            className={`camcount__opt${status === 'discarded' ? ' camcount__opt--on' : ''}`}
            style={{ fontFamily: 'var(--font-ui)', fontSize: '0.9rem' }}
            aria-pressed={status === 'discarded'}
            onClick={() => setStatus('discarded')}
          >
            No good
          </button>
        </div>
      </div>

      <div className="formrow">
        <span className="label">Tags</span>
        <div className="chips">
          {tagChips.map((tag) => {
            const on = activeTags.has(tag);
            const gold = tag === 'GOLD';
            return (
              <button
                key={tag}
                type="button"
                className={`chip${gold ? ' chip--gold' : ''}${on ? ' chip--on' : ' chip--off'}`}
                aria-pressed={on}
                onClick={() => toggleTag(tag)}
              >
                {tag}
              </button>
            );
          })}
        </div>
      </div>

      <div className="formrow">
        <label className="label" htmlFor="te-note">
          Note
        </label>
        <textarea
          id="te-note"
          className="field"
          placeholder="e.g. lens flare on the door"
          value={note}
          onChange={(e) => setNote(e.target.value)}
        />
      </div>

      <div className="sheet__actions">
        <SheetClose className="btn btn--ghost" onClose={props.onClose} disabled={saving}>
          Cancel
        </SheetClose>
        <button type="button" className="btn btn--go" disabled={saving} onClick={() => void requestSave()}>
          Save shot
        </button>
      </div>
      </div>

    </Sheet>
  );
}
