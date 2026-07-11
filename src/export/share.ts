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
 * Share `blob` as a file if the platform supports file sharing, otherwise
 * download it. Resolves once the share sheet closes or the download starts;
 * a user-cancelled share sheet resolves quietly (no double download).
 */
export async function shareBlob(blob: Blob, filename: string, mime: string): Promise<void> {
  const file = new File([blob], filename, { type: mime });

  if (typeof navigator.share === 'function' && typeof navigator.canShare === 'function') {
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
