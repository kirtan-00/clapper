// The Settings entry point for the identity StudioSheet asks for once. Two
// jobs: show what the exports currently say, and open the same sheet again.
//
// It reuses StudioSheet rather than growing a second editor. A row that opened
// a different form from the one someone answered on day one is how two fields
// drift into disagreeing about their own labels.

import { useState } from 'react';
import { Row } from './glist';
import { StudioSheet } from './StudioSheet';
import { getStudio } from './studio';
import * as haptics from './haptics';

export function StudioRow() {
  const [open, setOpen] = useState(false);
  // Re-read on every close so the row reflects an edit immediately. Cheap:
  // one localStorage read, and only when the sheet shuts.
  const [identity, setIdentity] = useState(getStudio);

  return (
    <>
      <Row
        label="Production house"
        // "Not set" rather than a blank: a value cell with nothing in it reads
        // as a row that failed to load, which is a different worry.
        value={identity.studio || 'Not set'}
        push
        onClick={() => {
          haptics.tap();
          setOpen(true);
        }}
      />
      {open && (
        <StudioSheet
          onDone={() => {
            setIdentity(getStudio());
            setOpen(false);
          }}
        />
      )}
    </>
  );
}
