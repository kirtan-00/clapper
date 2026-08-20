// Client-side PDF -> plain text. pdf.js is heavy, so it is dynamically imported
// here — it never touches the app shell and only downloads the first time a user
// actually uploads a shotlist PDF.

import { repairLigatures } from './shotlist';

/**
 * Told after every page, with how many there are in total.
 *
 * WHY THIS EXISTS: reading a 40-page shot division on a phone takes real
 * seconds, and the honest thing to put in front of an operator during them is
 * what has actually been read so far — not a spinner, which says only that
 * something is happening. Optional, so the one caller that wants a tally opts
 * in and nothing else has to care.
 */
export type PdfProgress = (page: number, pages: number) => void;

export async function extractPdfText(file: File, onProgress?: PdfProgress): Promise<string> {
  const [pdfjs, workerMod] = await Promise.all([
    import('pdfjs-dist'),
    import('pdfjs-dist/build/pdf.worker.min.mjs?url'),
  ]);
  pdfjs.GlobalWorkerOptions.workerSrc = (workerMod as { default: string }).default;

  const buf = await file.arrayBuffer();
  const doc = await pdfjs.getDocument({ data: buf }).promise;
  const pages: string[] = [];
  for (let i = 1; i <= doc.numPages; i++) {
    const page = await doc.getPage(i);
    const content = await page.getTextContent();
    const line = content.items
      .map((it) => ('str' in it ? it.str : ''))
      .join(' ');
    pages.push(line);
    page.cleanup();
    // After the page, not before it: the number is a count of what is read,
    // and a tally that runs ahead of the work is the spinner problem again.
    if (onProgress) {
      onProgress(i, doc.numPages);
      // Yield a whole task so the tally actually PAINTS between pages. The
      // awaits above only hand control back to the worker; a render queued
      // from them can still land after the next page starts, which puts every
      // count on screen at once and looks exactly like the spinner this
      // replaced. Costs a frame per page and buys the only thing the tally is
      // for. Nobody who did not ask for progress pays it.
      await new Promise<void>((r) => setTimeout(r, 0));
    }
  }
  await doc.destroy();
  const joined = pages.join('\n').replace(/[ \t]+/g, ' ').replace(/\n{3,}/g, '\n\n').trim();
  // pdf.js emits each ligature as its own text item, so the join above splits
  // words: "traffic" -> "tra ffi c", "flat" -> "fl at". Repair before anything
  // downstream reads the text — a garbled word becomes a garbled chip on set.
  return repairLigatures(joined);
}
