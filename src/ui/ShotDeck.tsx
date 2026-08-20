// The shot-card deck. Replaces the old .shotstrip (a flat prev/now/next pill)
// and .roll__summary (the action line duplicated under it) with the mockup's
// stacked cards: the current setup as a filled mass carrying its own spec,
// take count and description, with the next setup peeking dimmed beneath it,
// and a tick rail down the side standing in for "N of M" at a glance.
//
// NAME: this is `.shotdeck`, never `.roll__deck` — that class already belongs
// to the ROLL/CUT/tag-pad region lower on the screen (see roll.css). Two
// "decks" on one screen would be a name collision waiting to bite the next
// person who greps for it.
//
// R1 (this file, first commit) is tap-only: tap the peeked next card to make
// it current, tap the current card to open the full jump sheet — same jump
// sheet the old shotstrip opened, so nothing about finding a shot regressed.
// Stepping BACKWARD lost its dedicated arrow when the strip went away; the
// jump sheet covers it (any shot, one tap) and R3 (the drag wheel, same
// session) restores free back-and-forth scrubbing on this exact component.
//
// Locking follows the shotstrip's own rule, unchanged: disabled while rolling
// and while the post-cut sheet is open, because skidding onto the wrong setup
// mid-take mis-numbers a take and mislabels the clip.

import type { Shot } from '../types';
import { sizeInWords } from './shotlist';

function ShotDeckFace(props: { shot: Shot; takes: number }) {
  const { shot, takes } = props;
  return (
    <>
      <div className="shotdeck__row">
        <span className="shotdeck__code tnum">{shot.code}</span>
        <span className="shotdeck__spec">
          {[sizeInWords(shot.size), shot.move].filter(Boolean).join(' · ') || '—'}
        </span>
        <span className="shotdeck__takes tnum">
          {takes === 0 ? 'no takes' : `${takes} take${takes === 1 ? '' : 's'}`}
        </span>
      </div>
      {shot.action && <div className="shotdeck__text">{shot.action}</div>}
    </>
  );
}

export function ShotDeck(props: {
  shotList: Shot[];
  shotIndex: number;
  shot: Shot;
  nextShot: Shot | null;
  /** Kept takes logged against a shot, looked up by id — see refreshMeta's
   *  allTakes in RollingScreen.tsx. A function rather than a Map so the
   *  caller can memoise however it likes. */
  takeCountFor: (shotId: string) => number;
  locked: boolean;
  onOpenJump: () => void;
  onAdvance: (shot: Shot) => void;
}) {
  const { shot, nextShot, shotList, shotIndex, locked } = props;

  return (
    <div className="shotdeck">
      <div className="shotdeck__stack">
        <button
          type="button"
          className="shotdeck__card shotdeck__card--now"
          disabled={locked}
          aria-label={`Shot ${shot.code} of ${shotList.length}. Tap to jump to another shot.`}
          onClick={props.onOpenJump}
        >
          <ShotDeckFace shot={shot} takes={props.takeCountFor(shot.id)} />
        </button>
        {nextShot && (
          <button
            type="button"
            className="shotdeck__card shotdeck__card--next"
            disabled={locked}
            aria-label={`Next up, shot ${nextShot.code}. Tap to make it current.`}
            onClick={() => props.onAdvance(nextShot)}
          >
            <ShotDeckFace shot={nextShot} takes={props.takeCountFor(nextShot.id)} />
          </button>
        )}
      </div>
      {shotList.length > 1 && (
        <div className="shotdeck__rail" aria-hidden="true">
          {shotList.map((s, i) => (
            <span key={s.id} className={`shotdeck__tick${i === shotIndex ? ' is-cur' : ''}`} />
          ))}
        </div>
      )}
    </div>
  );
}
