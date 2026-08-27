// THE HEADLINE STUDIO PLUS FEATURE: swap Clapper's own mark for a
// subscriber's own logo, on the PDF cover and in the app masthead (see
// ScreenMark in ui/glist.tsx and drawLogo/embedLogo in export/pdf.ts). Sits
// beside StudioRow in Settings' Exports section - the two rows together are
// "who this export is from" and "what it looks like when it says so".
//
// GATED ON THE ENTITLEMENT READ, and it is a SOFT gate. This is a static
// site: the value lives in this browser's own localStorage, and there is no
// server in the loop for this row to ask "is this account really Studio
// Plus" before it draws a control. What IS server-enforced is whether a PDF
// export happens at all - `gateExport` in net/quota.ts, called from
// ProjectScreen before any export runs. That gate has nothing to do with
// logos. This row's own gate only decides whether to SHOW the upload
// control, using `logoEligible` (ui/studio.ts) against the caller's cached
// entitlements - the same predicate ProjectScreen uses to decide whether to
// ATTACH a stored logo to an export. Someone editing localStorage or the
// in-memory entitlements object directly can defeat both; that is the honest
// ceiling of a client-side check on a static site, not a bug in this row.
//
// RENDERS NOTHING - not a locked row, not an upsell card - for anyone whose
// entitlements have not settled as an active Studio Plus subscription. A
// free or signed-out user never sees a control they cannot use flash into
// view and then vanish; they simply never see it, the same way a free
// account never sees Studio Plus-only rows anywhere else in Settings.

import { useState, type ChangeEvent } from 'react';
import { Row } from './glist';
import { Sheet, SheetClose } from './common';
import {
  ACCEPTED_LOGO_TYPES,
  getStudio,
  isAcceptedLogoType,
  logoEligible,
  resizeLogoFile,
  setStudioLogo,
} from './studio';
import type { StudioLogo } from '../types';
import { useSession } from '../net/auth';
import { useEntitlements } from './useEntitlements';
import * as haptics from './haptics';
import './studioLogo.css';

export function StudioLogoRow() {
  const { session } = useSession();
  const { entitlements, loaded } = useEntitlements(!!session);
  const [open, setOpen] = useState(false);
  // Re-read on every close, same reasoning as StudioRow: cheap, and it keeps
  // the row honest about what storage actually holds after a write that may
  // have silently failed (quota, private mode).
  const [logo, setLogo] = useState<StudioLogo | undefined>(() => getStudio().logo);

  // THE GATE. Not loaded yet reads the same as not eligible - see the header.
  if (!loaded || !logoEligible(entitlements)) return null;

  return (
    <>
      <Row
        label="Studio logo"
        value={logo ? 'Set' : 'Not set'}
        push
        onClick={() => {
          haptics.tap();
          setOpen(true);
        }}
      />
      {open && (
        <StudioLogoSheet
          logo={logo}
          onDone={() => {
            setLogo(getStudio().logo);
            setOpen(false);
          }}
        />
      )}
    </>
  );
}

function StudioLogoSheet(props: { logo: StudioLogo | undefined; onDone: () => void }) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // Local preview, ahead of the parent's own re-read on close - so picking a
  // new logo (or removing one) shows up in THIS sheet immediately, not only
  // after it closes.
  const [preview, setPreview] = useState<StudioLogo | undefined>(props.logo);

  async function onPick(e: ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0];
    e.target.value = ''; // let the same file be picked again after an error
    if (!file) return;
    setError(null);
    // Checked here too, ahead of resizeLogoFile's own identical guard - the
    // file picker's `accept` attribute already steers most people away from
    // this, but it does not stop a drag-and-drop or a renamed file, and the
    // message here can be specific in a way a rejected promise's is not.
    if (!isAcceptedLogoType(file.type)) {
      setError('PNG or JPEG only.');
      return;
    }
    setBusy(true);
    try {
      const resized = await resizeLogoFile(file);
      setStudioLogo(resized);
      haptics.tap();
      // Re-read rather than trust `resized` directly: setStudioLogo swallows
      // a quota/storage failure (see its own comment in studio.ts), so the
      // sheet has to show what actually landed, not what it tried to write.
      setPreview(getStudio().logo);
    } catch {
      setError("Couldn't use that image. Try a different PNG or JPEG.");
    } finally {
      setBusy(false);
    }
  }

  function remove() {
    haptics.tap();
    setStudioLogo(null);
    setPreview(getStudio().logo);
  }

  return (
    <Sheet title="Studio logo" onClose={props.onDone}>
      <p className="camnote studiologo__lede" style={{ marginTop: 0 }}>
        Shown on your PDF cover and in the app, in place of the Clapper mark. PNG or
        JPEG - resized on this device before it's saved, so a big photo never leaves
        the picker as one.
      </p>

      {preview && (
        <div className="studiologo__preview">
          <img src={preview.dataUri} alt="Your studio logo" />
        </div>
      )}

      <label className={`btn btn--go btn--full sp-upload${busy ? ' btn--disabled' : ''}`}>
        {busy ? 'Adding…' : preview ? 'Replace logo' : 'Choose logo'}
        <input
          type="file"
          accept={ACCEPTED_LOGO_TYPES.join(',')}
          hidden
          disabled={busy}
          onChange={onPick}
        />
      </label>
      {error && <span className="tnum tnum--bad sp-error">{error}</span>}

      <div className="studiologo__actions">
        {preview && (
          <button type="button" className="btn btn--full" onClick={remove} disabled={busy}>
            Remove logo
          </button>
        )}
        <SheetClose className="btn btn--full" onClose={props.onDone} disabled={busy}>
          Done
        </SheetClose>
      </div>
    </Sheet>
  );
}
