// THE CHAPTER BAR — four tabs on a Sheet, shown when the tour starts and
// again the moment a chapter finishes (see TourController.tsx's `advance`).
// Tapping a selectable chapter runs its walkthrough; the three not built yet
// read "Coming up" and refuse the tap (see tourChapters.ts's
// `isChapterSelectable`) rather than opening an empty chapter that would
// complete itself with nothing shown. The persistent Done/Skip tour row at
// the foot always works, whatever is or is not finished yet.

import { Sheet } from '../common';
import { CheckMark } from '../marks';
import { TOUR_CHAPTERS, isChapterSelectable, type TourChapterId } from './tourChapters';

export function TourChapterMenu(props: {
  completed: ReadonlySet<TourChapterId>;
  onSelect: (id: TourChapterId) => void;
  onDone: () => void;
}) {
  const { completed, onSelect, onDone } = props;
  const anyDone = completed.size > 0;

  return (
    <Sheet
      title="Take the tour"
      lede="A real example shoot, chapter by chapter — pick one or go straight through."
      onClose={onDone}
    >
      <div className="tourmenu" role="tablist" aria-label="Tour chapters">
        {TOUR_CHAPTERS.map((chapter) => {
          const done = completed.has(chapter.id);
          const selectable = isChapterSelectable(chapter);
          return (
            <button
              key={chapter.id}
              type="button"
              role="tab"
              aria-selected={false}
              aria-disabled={!selectable}
              className={`tourmenu__tab${done ? ' tourmenu__tab--done' : ''}${
                selectable ? '' : ' tourmenu__tab--soon'
              }`}
              disabled={!selectable}
              onClick={() => selectable && onSelect(chapter.id)}
            >
              <span className="tourmenu__row">
                <span className="tourmenu__label">{chapter.label}</span>
                {done ? (
                  <span className="tourmenu__status tourmenu__status--done" aria-label="Done">
                    <CheckMark />
                  </span>
                ) : !selectable ? (
                  <span className="tourmenu__status tourmenu__status--soon">Coming up</span>
                ) : null}
              </span>
              <span className="tourmenu__blurb">{chapter.blurb}</span>
            </button>
          );
        })}
      </div>
      <div className="sheet__actions">
        <button type="button" className="btn btn--ghost" onClick={onDone}>
          {anyDone ? 'Done' : 'Skip tour'}
        </button>
      </div>
    </Sheet>
  );
}
