// Deliver an exported Blob to the user. On phones with the Web Share API we
// hand off a real File (AirDrop, Files, Mail, etc.); everywhere else we fall
// back to a temporary <a download> click. No DOM assumptions beyond a browser.

/** Trigger a plain download via a throwaway object-URL anchor. */
function downloadBlob(blob: Blob, filename: string): void {
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  a.rel = 'noopener';
  a.style.display = 'none';
  document.body.appendChild(a);
  a.click();
  a.remove();
  // Revoke on the next tick so the browser has grabbed the blob first.
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

/**
 * Mobile-ish device heuristic: a real touch pointer. Desktops (even with a
 * touchscreen laptop the pointer is still fine, but the primary case is that
 * desktop browsers report no coarse pointer) should download rather than pop
 * the OS share sheet. Both APIs are guarded for availability.
 */
function isMobileLike(): boolean {
  const touch = typeof navigator !== 'undefined' && navigator.maxTouchPoints > 0;
  const coarse =
    typeof window !== 'undefined' &&
    typeof window.matchMedia === 'function' &&
    window.matchMedia('(pointer: coarse)').matches;
  return touch && coarse;
}

/**
 * Share `blob` as a file if the platform supports file sharing, otherwise
 * download it. On desktop we go straight to the anchor download so the PDF
 * lands in Downloads instead of opening the OS share sheet; only mobile-ish
 * devices get the Web Share path. Resolves once the share sheet closes or the
 * download starts; a user-cancelled share sheet resolves quietly (no double
 * download).
 */
export async function shareBlob(blob: Blob, filename: string, mime: string): Promise<void> {
  const file = new File([blob], filename, { type: mime });

  // The Web Share API only works in a secure context. Opened from file:// (a
  // sandboxed webview, or a file the owner saved and tapped) the context is
  // insecure, and navigator.share can be missing or throw synchronously — so we
  // require isSecureContext and go straight to the anchor download otherwise.
  const secure = typeof window !== 'undefined' && window.isSecureContext === true;

  if (
    secure &&
    isMobileLike() &&
    typeof navigator.share === 'function' &&
    typeof navigator.canShare === 'function'
  ) {
    try {
      if (navigator.canShare({ files: [file] })) {
        await navigator.share({ files: [file], title: filename });
        return;
      }
    } catch (err) {
      // User dismissed the sheet: honor that, don't also download.
      if (err instanceof DOMException && err.name === 'AbortError') return;
      // Any other failure (e.g. share not actually permitted): fall through.
    }
  }

  downloadBlob(blob, filename);
}
