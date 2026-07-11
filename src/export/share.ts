// Deliver an exported Blob to the user by downloading it directly — always, on
// every device. This is intentional: exports go straight to Files/Downloads and
// the user shares the file himself from there. We never open the OS share sheet
// (no Web Share API), so a PDF/CSV/XML export is never intercepted by
// AirDrop/Messages. No DOM assumptions beyond a browser.

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
 * Download `blob` to the device as `filename`. Always a direct download on every
 * device — never the Web Share sheet. We re-wrap the blob in a File so the
 * download carries the correct MIME type. Kept async and with this signature so
 * callers stay untouched.
 */
export async function shareBlob(blob: Blob, filename: string, mime: string): Promise<void> {
  const file = new File([blob], filename, { type: mime });
  downloadBlob(file, filename);
}
