// The quick-tag chip editor, in one place.
//
// This widget was inline in the New project sheet and nowhere else, which meant
// the ONLY moment you could choose a shoot's vocabulary was the moment before
// the shoot existed. It is a component now with FOUR mounts — the New project
// sheet, the project screen (an existing shoot), Settings (the per-mode
// default), and the roll screen mid-take (see RollingScreen.tsx's tag-edit
// deck) — because the same control doing the same job should not be four
// hand-typed near-copies that drift.
//
// Everything it produces goes through normaliseTags (see tagdefaults.ts), so a
// tag cannot arrive downstream in lower case, over length, or carrying a quote
// that would break the CSV export.
//
// A NOTE ON THE REMOVE BUTTON: `.chip__x` is a 44px tap target that lives
// inside a chip about that tall, so the whole chip reads as "tap to delete".
// That is intentional — this is a setup screen, never touched while rolling,
// and a confirm step on removing the word NOISE would be ceremony. Nothing
// here can destroy logged work: a take that already carries a tag keeps it
// (Take.tag is a plain string), it just stops being offered on the keypad.
//
// THE `variant="deck"` PROP is the one exception to "never touched while
// rolling" above — it is what the roll screen's own tag-edit deck renders,
// on the dark mass, in the middle of a take. Everything about *what* a tag
// is (normalised, capped at MAX_TAGS, GOLD is special) stays identical; only
// the chrome changes, to a keycap grid that matches the deck it sits on top
// of. GOLD renders locked there — no × — because the mockup's own words are
// "GOLD is structural: it can move, not delete", and a take that already
// carries the tag keeps it either way (see the note above). Reordering
// ("move") is deliberately NOT built here — that reads as drag-and-drop, a
// second gesture on a screen that already has a long-press meaning something
// else, and it was not asked for. Renaming an existing chip in place (the
// pitch's blinking-caret `keycap--field` state) is also out of scope; the
// only two live acts this variant offers are add and remove, which is what
// "edit the vocabulary mid-take" actually needs.

import { useState } from 'react';
import { MAX_TAGS, MAX_TAG_LEN, normaliseTag } from './tagdefaults';
import { CloseMark } from './marks';
import * as haptics from './haptics';

export function TagEditor(props: {
  tags: readonly string[];
  onChange: (tags: string[]) => void;
  /** Rendered above the chips. Omit inside a sheet that already has a heading. */
  label?: string;
  /** Sits under the add line — the one sentence explaining what this set does
   *  in THIS mount, since the mounts mean different things. Ignored by the
   *  `deck` variant, which carries its own fixed GOLD note instead. */
  note?: string;
  /** `form` (default): the chip list + text field, used on setup screens.
   *  `deck`: the keycap grid used mid-take on the roll screen — see the
   *  header comment above for what stays the same and what does not. */
  variant?: 'form' | 'deck';
}) {
  const { tags, onChange } = props;
  const [draft, setDraft] = useState('');
  const [adding, setAdding] = useState(false);
  const full = tags.length >= MAX_TAGS;

  function add() {
    const tag = normaliseTag(draft);
    setDraft('');
    if (!tag || full) return;
    // Re-adding an existing tag is a no-op rather than an error: the operator
    // meant "I want this tag", and it is already true.
    if (tags.includes(tag)) return;
    haptics.tap();
    onChange([...tags, tag]);
  }

  function remove(tag: string) {
    haptics.tap();
    onChange(tags.filter((t) => t !== tag));
  }

  if (props.variant === 'deck') {
    return (
      <div className="rolltags">
        <div className="rolltags__grid">
          {tags.map((t) => {
            const gold = t === 'GOLD';
            return (
              <span key={t} className={`chip keycap rolltags__key${gold ? ' chip--gold' : ''}`}>
                {t}
                {!gold && (
                  <button
                    type="button"
                    className="rolltags__x"
                    aria-label={`Remove tag ${t}`}
                    onClick={() => remove(t)}
                  >
                    <CloseMark />
                  </button>
                )}
              </span>
            );
          })}
          {!full && (
            <button
              type="button"
              className="chip keycap rolltags__add"
              aria-label="Add a tag"
              onClick={() => {
                haptics.tap();
                setAdding(true);
              }}
            >
              + Tag
            </button>
          )}
        </div>

        {adding && (
          <div className="addline rolltags__addline">
            <input
              className="field field--mono"
              autoFocus
              value={draft}
              placeholder="Add tag"
              maxLength={MAX_TAG_LEN}
              autoCapitalize="characters"
              autoCorrect="off"
              spellCheck={false}
              aria-label="New tag"
              onChange={(e) => setDraft(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter') {
                  e.preventDefault();
                  add();
                  setAdding(false);
                }
                if (e.key === 'Escape') {
                  setDraft('');
                  setAdding(false);
                }
              }}
              onBlur={() => {
                add();
                setAdding(false);
              }}
            />
          </div>
        )}

        {tags.includes('GOLD') && (
          <span className="rolltags__note">GOLD is structural — it can move, not delete</span>
        )}
      </div>
    );
  }

  return (
    <div className="formrow">
      {props.label && <span className="label">{props.label}</span>}

      {tags.length > 0 ? (
        <div className="chips">
          {tags.map((t) => (
            <span key={t} className={`chip chip--removable${t === 'GOLD' ? ' chip--gold' : ''}`}>
              {t}
              <button
                type="button"
                className="chip__x"
                aria-label={`Remove tag ${t}`}
                onClick={() => remove(t)}
              >
                <CloseMark />
              </button>
            </span>
          ))}
        </div>
      ) : (
        // An empty set is allowed on purpose — a crew that taps nothing but
        // CUT should be able to clear the keypad away. Say so, so it does not
        // read as a screen that failed to load.
        <span className="tagedit__empty">No quick tags. The roll screen shows CUT and nothing else.</span>
      )}

      <div className="addline">
        <input
          className="field field--mono"
          value={draft}
          placeholder={full ? 'Full' : 'Add tag'}
          disabled={full}
          maxLength={MAX_TAG_LEN}
          autoCapitalize="characters"
          autoCorrect="off"
          spellCheck={false}
          aria-label="New tag"
          onChange={(e) => setDraft(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter') {
              e.preventDefault();
              add();
            }
          }}
        />
        <button type="button" className="btn" disabled={full || !draft.trim()} onClick={add}>
          Add
        </button>
      </div>

      {(props.note || full) && (
        <span className="tagedit__note">
          {full ? `That is the limit — ${MAX_TAGS} chips is already more than fits without scrolling.` : props.note}
        </span>
      )}
    </div>
  );
}
