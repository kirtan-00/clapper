// Crash recovery for an in-flight take — see src/engine/rollCheckpoint.ts for
// what gets checkpointed, when, and why localStorage/wall-clock specifically.
// This is the OTHER half: the three-door prompt shown at launch when a
// checkpoint from a killed tab is still sitting there.
//
// Mounted once at the app shell (AppShell.tsx), same level as Onboarding —
// cold launch always lands on Home (see ui/nav.ts), never on the rolling
// screen directly, so this cannot live inside RollingScreen itself. It reads
// localStorage once on mount; if there is nothing to recover it renders
// nothing and never touches the store.

import { useEffect, useState } from 'react';
import type { Project, Shot, Slate } from '../types';
import { hasSound, isMultiCam } from '../types';
import { store } from '../store';
import {
  buildRecoveredTake,
  clearCheckpoint,
  elapsedSince,
  formatClipsLabel,
  formatElapsedAgo,
  isStale,
  noCameraEverJoined,
  readCheckpoint,
  setPendingResume,
  type RollCheckpoint,
} from '../engine/rollCheckpoint';
import { Sheet } from './common';
import { ForwardMark } from './marks';
import * as haptics from './haptics';
import type { Nav } from './nav';

type State =
  | { phase: 'checking' | 'idle' | 'busy' }
  | {
      phase: 'prompt';
      checkpoint: RollCheckpoint;
      project: Project;
      slate: Slate;
      shot?: Shot;
      stale: boolean;
      elapsedMs: number;
      clipsLabel: string;
    };

export function RollRecovery(props: { nav: Nav }) {
  const [state, setState] = useState<State>({ phase: 'checking' });

  useEffect(() => {
    let cancelled = false;
    (async () => {
      const cp = readCheckpoint();
      if (!cp) return;
      try {
        // EXACTLY-ONCE GUARD. A checkpoint is only cleared AFTER its take and
        // moments are fully persisted (see RollingScreen's closeMultiTake/
        // doCut and this file's own `finish` below) — so the only way a
        // checkpoint can still be sitting here for an ALREADY-SAVED take is
        // the narrow window between that persist finishing and the
        // clearCheckpoint() call landing, if the tab died again in between.
        // Checked by exact epoch-ms match on `startedAt`, which only a take
        // actually built from this checkpoint could carry — collision-proof
        // in practice. Caught here, silently: showing a prompt for a take
        // already on disk risks double-logging it, which is worse than one
        // rare unexplained non-prompt.
        const takes = await store.listTakes(cp.slateId);
        if (takes.some((t) => t.startedAt === cp.takeStartedAt)) {
          clearCheckpoint();
          return;
        }
        const project = await store.getProject(cp.projectId);
        if (!project) {
          clearCheckpoint(); // the project itself is gone - nothing to recover into
          return;
        }
        const slates = await store.listSlates(cp.projectId);
        const slate = slates.find((s) => s.id === cp.slateId);
        if (!slate) {
          clearCheckpoint();
          return;
        }
        const shot = cp.shotId ? slate.shots?.find((s) => s.id === cp.shotId) : undefined;
        if (cp.shotId && !shot) {
          clearCheckpoint(); // the shot itself was deleted since the checkpoint was written
          return;
        }
        const now = Date.now();
        if (!cancelled) {
          setState({
            phase: 'prompt',
            checkpoint: cp,
            project,
            slate,
            shot,
            stale: isStale(cp, now),
            elapsedMs: elapsedSince(cp, now),
            clipsLabel: formatClipsLabel(cp),
          });
        }
      } catch {
        // A store read failed. Fail safe: do nothing and leave the
        // checkpoint exactly where it is - the operator loses nothing, and
        // the very next launch gets another chance to offer it back.
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  if (state.phase !== 'prompt') return null;
  const { checkpoint, project, slate, shot, stale, elapsedMs, clipsLabel } = state;

  /** "Cut it now" (status stays 'good') and "Discard" (status patched to
   *  'discarded' right after) both go through store.createTake exactly once
   *  - the same single number-consuming event every other take in this app
   *  goes through. "Still rolling" never reaches this function at all. That
   *  is the whole guarantee: one door writes zero takes, the other two write
   *  exactly one each, and every door clears the checkpoint before it hands
   *  control back, so the prompt can never re-fire for the same take. */
  async function finish(status: 'good' | 'discarded') {
    setState({ phase: 'busy' });
    try {
      const input = buildRecoveredTake(checkpoint, Date.now());
      // SOUND ROLLED SOLO ON A SINGLE-CAM PROJECT, AND THE CAMERA NEVER
      // JOINED. store/util.ts's single-cam path in buildTakeClips ALWAYS
      // mints a top-level camera clip and advances the counter — it does not
      // read `units` at all (that field is multi-cam only, "meaningless and
      // ignored" for single-cam, per createTake's own doc comment) — so
      // calling createTake here would fabricate a clip name for a camera
      // that never rolled. RollingScreen's own soundSoloCut hits this exact
      // situation and calls abortPendingTake() instead of writing anything,
      // for precisely this reason (see its comment: "nothing to save yet...
      // rather than fabricate a clip number the camera never wrote"). Mirror
      // it here: neither door writes a take: there is nothing to keep and
      // nothing to discard.
      //
      // GATED ON hasSound(project) too, not just noCameraEverJoined alone:
      // a PLAIN single-cam-no-sound checkpoint ALSO always carries empty
      // camRolls/finishedRolls (see checkpointNow's `!useEngine` branch in
      // RollingScreen.tsx — those fields are forced to {}/[] there because
      // that whole engine-tracking model does not apply), so
      // noCameraEverJoined alone cannot tell "sound solo, no camera" apart
      // from "the ordinary single-cam take this app logs a thousand times a
      // day". Only a project WITH a sound unit can produce the "solo sound,
      // no camera" shape in the first place — that is the only case this
      // guard exists to catch.
      if (!isMultiCam(project) && hasSound(project) && noCameraEverJoined(checkpoint)) {
        clearCheckpoint();
        return;
      }
      const take = await store.createTake(input);
      for (const m of input.moments) {
        await store.createMoment({
          takeId: take.id,
          kind: m.kind,
          atMs: m.atMs,
          ...(m.endMs !== undefined ? { endMs: m.endMs } : {}),
          label: m.label,
          ...(m.tag !== undefined ? { tag: m.tag } : {}),
        });
      }
      if (status === 'discarded') await store.updateTake(take.id, { status: 'discarded' });
      clearCheckpoint();
    } finally {
      setState({ phase: 'idle' });
    }
  }

  function stillRolling() {
    setPendingResume(checkpoint);
    props.nav.push({ name: 'rolling', project, slate, ...(shot ? { shot } : {}) });
    setState({ phase: 'idle' });
  }

  return (
    <Sheet title="Take recovered">
      <p className="sheet__lede">
        You were rolling {clipsLabel}. Started {formatElapsedAgo(elapsedMs)} ago
        {stale ? ' — too long ago to still be rolling' : ''}.
      </p>
      {/* No onClose: this prompt must resolve to exactly one of the three
          doors below, never be swiped away as "decide later" - a stale
          checkpoint offering to recover an already-decided take is its own
          bug (see the header comment). */}
      {!stale && (
        <button
          type="button"
          className="resumerow"
          onClick={() => {
            haptics.thump();
            stillRolling();
          }}
        >
          <ForwardMark />
          Still rolling — take {checkpoint.takeNumber} carries on
        </button>
      )}
      <div className="sheet__actions sheet__actions--weighted">
        <button type="button" className="btn btn--danger" onClick={() => void finish('discarded')}>
          Discard
        </button>
        <button type="button" className="btn btn--go" onClick={() => void finish('good')}>
          Cut it now
        </button>
      </div>
    </Sheet>
  );
}
