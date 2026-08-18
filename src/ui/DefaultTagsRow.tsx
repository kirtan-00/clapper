// Default quick tags, as two settings rows.
//
// MOUNTING: renders the ROWS ONLY, same contract as ThemeToggleRow and
// CutSizeRow — drops straight into a `.glist-card`:
//
//   <Section title="Quick tags">
//     <DefaultTagsRows />
//   </Section>
//
// Takes no props and needs no provider; it reads and writes through
// src/ui/tagdefaults.ts.
//
// SHAPE: a `.grow` push row per mode, opening a sheet — NOT the inline
// segmented control CutSizeRow uses. The difference is that a cut size is one
// choice among four and fits on a line, while a tag set is an unbounded list
// with a text input in it. iOS Settings makes the same split: Text Size is a
// slider in place, Keyboard > Text Replacement is a push.
//
// TWO rows rather than one, because the two modes have genuinely different
// vocabularies and always have (see newRoll.ts): coverage sizes describe a
// camera setup and mean nothing on a single continuous take, and the things
// worth flagging by ear in a two-hour conversation mean nothing on a shoot.
// One shared list would force one of them to be wrong.

import { useState, useSyncExternalStore } from 'react';
import { Sheet, SheetClose } from './common';
import { Row } from './glist';
import { TagEditor } from './TagEditor';
import {
  BUILTIN_TAGS,
  getDefaultTags,
  isBuiltinTags,
  resetDefaultTags,
  setDefaultTags,
  subscribe,
  tagsVersion,
} from './tagdefaults';
import type { ProjectMode } from './newRoll';
import * as haptics from './haptics';

const MODE_LABEL: Record<ProjectMode, string> = {
  video: 'Shoot tags',
  podcast: 'Podcast tags',
};

const MODE_NOTE: Record<ProjectMode, string> = {
  video: 'What a new shoot starts with. Projects you have already made keep their own tags.',
  podcast: 'What a new podcast roll starts with. Recordings already on this phone keep their own tags.',
};

export function DefaultTagsRows() {
  // Subscribe to the version string, not the arrays — getDefaultTags returns a
  // fresh array every call and would re-render on every store tick.
  useSyncExternalStore(subscribe, tagsVersion, () => '');
  const [editing, setEditing] = useState<ProjectMode | null>(null);

  return (
    <>
      {(['video', 'podcast'] as const).map((mode) => (
        <Row
          key={mode}
          label={MODE_LABEL[mode]}
          value={isBuiltinTags(mode) ? 'Default' : String(getDefaultTags(mode).length)}
          push
          onClick={() => {
            haptics.tap();
            setEditing(mode);
          }}
        />
      ))}

      {editing && (
        <DefaultTagsSheet mode={editing} onClose={() => setEditing(null)} />
      )}
    </>
  );
}

/**
 * The editor sheet. Writes STRAIGHT THROUGH on every change rather than
 * holding a draft behind a Save button — this is a preference, not a form,
 * and the same live-write contract every other row in Settings runs on. There
 * is nothing to cancel, so the sheet's one action is Done.
 */
function DefaultTagsSheet(props: { mode: ProjectMode; onClose: () => void }) {
  useSyncExternalStore(subscribe, tagsVersion, () => '');
  const tags = getDefaultTags(props.mode);
  const builtin = isBuiltinTags(props.mode);

  return (
    <Sheet title={MODE_LABEL[props.mode]} onClose={props.onClose}>
      <TagEditor
        tags={tags}
        onChange={(next) => setDefaultTags(props.mode, next)}
        note={MODE_NOTE[props.mode]}
      />

      {!builtin && (
        <button
          type="button"
          className="btn btn--ghost btn--full"
          onClick={() => {
            haptics.tap();
            resetDefaultTags(props.mode);
          }}
        >
          Back to the standard {BUILTIN_TAGS[props.mode].length}
        </button>
      )}

      <div className="sheet__actions">
        <SheetClose className="btn btn--go" onClose={props.onClose}>
          Done
        </SheetClose>
      </div>
    </Sheet>
  );
}
