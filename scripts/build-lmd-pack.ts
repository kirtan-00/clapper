// One-shot generator: the LMD shotlist PDF plus the key-moment chips the
// server returned for it -> the TS literal that becomes a bundled example pack.
//
// Structure comes from the same on-device parser the app uses, so the template
// is exactly what a user importing this PDF would get. Only the chips had to
// come from the server; those are pasted in from that run.
//
// Run from the repo root:  npx vite-node scripts/build-lmd-pack.ts

import { readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { parseShotlist, shotlistToPack, repairLigatures } from '../src/ui/shotlist';

const PDF = '/Users/purohit/Downloads/LMD_Shotlist.pdf';
const MOMENTS = fileURLToPath(new URL('./lmd-moments.json', import.meta.url));
const OUT = fileURLToPath(new URL('./lmd-pack.json', import.meta.url));
// The printed title is letter-spaced on the cover page, which the parser
// correctly refuses to guess word breaks for, so it falls back to the filename.
// A bundled template gets the real name.
const TITLE = "Let's Meet Dobaara";

/** Undo the model's escape artifacts: stray backslashes, then an unclosed quote. */
function tidyLabel(raw: string): string {
  let t = raw.replace(/\\/g, '').trim();
  const quotes = (t.match(/"/g) ?? []).length;
  if (t.startsWith('"') && quotes % 2 === 1) t = `${t}"`;
  return t;
}

async function extract(): Promise<string> {
  const pdfjs: any = await import('pdfjs-dist/legacy/build/pdf.mjs');
  const doc = await pdfjs.getDocument({ data: new Uint8Array(readFileSync(PDF)) }).promise;
  const pages: string[] = [];
  for (let i = 1; i <= doc.numPages; i++) {
    const page = await doc.getPage(i);
    const content = await page.getTextContent();
    pages.push(content.items.map((it: any) => it.str).join(' '));
  }
  return repairLigatures(pages.join('\n'));
}

const text = await extract();
const parsed = parseShotlist(text);
if (!parsed) throw new Error('parseShotlist returned null — the PDF did not read as a shotlist.');
const pack = shotlistToPack(parsed, 'LMD_Shotlist.pdf');
pack.project.name = TITLE;

const moments: Record<string, string[]> = JSON.parse(readFileSync(MOMENTS, 'utf8'));
let tagged = 0;
for (const scene of pack.scenes) {
  for (const shot of scene.shots ?? []) {
    const m = moments[shot.code];
    if (m && m.length) {
      shot.keyMoments = m.map(tidyLabel).filter(Boolean);
      tagged++;
    }
  }
}

const shots = pack.scenes.reduce((n, s) => n + (s.shots?.length ?? 0), 0);
console.log(`scenes=${pack.scenes.length} shots=${shots} tagged=${tagged}`);
console.log('coverage:', JSON.stringify(pack.scenes[0].coverageTags));
console.log('scene names:', pack.scenes.map((s) => s.name).join(' | '));

writeFileSync(OUT, JSON.stringify(pack, null, 2) + '\n');
console.log('wrote', OUT);
