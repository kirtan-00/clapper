// Client-side PDF -> plain text. pdf.js is heavy, so it is dynamically imported
// here — it never touches the app shell and only downloads the first time a user
// actually uploads a script PDF in Script Mode.

export async function extractPdfText(file: File): Promise<string> {
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
  }
  await doc.destroy();
  return pages.join('\n').replace(/[ \t]+/g, ' ').replace(/\n{3,}/g, '\n\n').trim();
}
