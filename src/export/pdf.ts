// Editor-facing PDF report. pdf-lib, standard Helvetica, A4 portrait.
// Editorial and printable: cover header with stats, GOLD summary, takes
// grouped by slate, discarded appendix in gray, page numbers bottom right.
// No em dashes anywhere; plain '-' only.

import { PDFDocument, PDFFont, PDFPage, StandardFonts, rgb } from 'pdf-lib';
import type { Fps, Moment, ProjectBundle, Take } from '../types';
import { tc, wallClockTC } from './timecode';

const A4: [number, number] = [595.28, 841.89];
const MARGIN = 54;
const BOTTOM = 64; // keep clear of the page number
const CONTENT_WIDTH = A4[0] - MARGIN * 2;
const TC_COLUMN_X = A4[0] - MARGIN - 92; // right column for true camera TC

const INK = rgb(0.09, 0.09, 0.11);
const GRAY = rgb(0.45, 0.45, 0.48);
const LIGHT = rgb(0.78, 0.78, 0.8);
const GOLD = rgb(0.62, 0.47, 0.08);

/** Make text safe for WinAnsi encoding; swap em/en dashes for '-'. */
function sanitize(text: string): string {
  const swapped = text
    .replace(/[—–―]/g, '-')
    .replace(/[‘’]/g, "'")
    .replace(/[“”]/g, '"')
    .replace(/…/g, '...')
    .replace(/[\r\n\t]+/g, ' ');
  let out = '';
  for (const ch of swapped) {
    const code = ch.codePointAt(0) ?? 0;
    out += (code >= 0x20 && code <= 0x7e) || (code >= 0xa0 && code <= 0xff) ? ch : '?';
  }
  return out;
}

function truncate(text: string, font: PDFFont, size: number, maxWidth: number): string {
  if (font.widthOfTextAtSize(text, size) <= maxWidth) return text;
  let t = text;
  while (t.length > 1 && font.widthOfTextAtSize(t + '...', size) > maxWidth) {
    t = t.slice(0, -1);
  }
  return t + '...';
}

function safeCameraTc(base: string | undefined, ms: number, fps: Fps): string | undefined {
  if (!base) return undefined;
  try {
    return tc.addMsToTimecode(base, ms, fps);
  } catch {
    return undefined;
  }
}

function formatDate(epochMs: number): string {
  const d = new Date(epochMs);
  const months = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
  return `${d.getDate()} ${months[d.getMonth()]} ${d.getFullYear()}`;
}

function momentLine(m: Moment): string {
  const time =
    m.kind === 'range' && m.endMs !== undefined
      ? `${tc.msToClock(m.atMs)}-${tc.msToClock(m.endMs)}`
      : tc.msToClock(m.atMs);
  return [time, m.tag, m.label].filter(Boolean).join('  ');
}

export async function toPdf(bundle: ProjectBundle): Promise<Blob> {
  const { project, slates, takes, moments } = bundle;
  const fps = project.fps;

  const doc = await PDFDocument.create();
  const helv = await doc.embedFont(StandardFonts.Helvetica);
  const bold = await doc.embedFont(StandardFonts.HelveticaBold);

  let page: PDFPage = doc.addPage(A4);
  let y = A4[1] - MARGIN;

  const newPage = () => {
    page = doc.addPage(A4);
    y = A4[1] - MARGIN;
  };
  const ensure = (needed: number) => {
    if (y - needed < BOTTOM) newPage();
  };
  const text = (
    str: string,
    opts: { x?: number; size?: number; font?: PDFFont; color?: ReturnType<typeof rgb>; maxWidth?: number } = {},
  ) => {
    const font = opts.font ?? helv;
    const size = opts.size ?? 9;
    const clean = truncate(sanitize(str), font, size, opts.maxWidth ?? CONTENT_WIDTH);
    page.drawText(clean, { x: opts.x ?? MARGIN, y, size, font, color: opts.color ?? INK });
  };
  const rule = (color = LIGHT) => {
    page.drawLine({
      start: { x: MARGIN, y },
      end: { x: A4[0] - MARGIN, y },
      thickness: 0.6,
      color,
    });
  };

  // ---- data prep ---------------------------------------------------------
  const slatesOrdered = [...slates].sort((a, b) => a.order - b.order);
  const slateName = new Map(slates.map((s) => [s.id, s.name]));
  const takesBySlate = new Map<string, Take[]>();
  for (const t of takes) {
    const list = takesBySlate.get(t.slateId) ?? [];
    list.push(t);
    takesBySlate.set(t.slateId, list);
  }
  for (const list of takesBySlate.values()) list.sort((a, b) => a.number - b.number);

  const momentsByTake = new Map<string, Moment[]>();
  for (const m of moments) {
    const list = momentsByTake.get(m.takeId) ?? [];
    list.push(m);
    momentsByTake.set(m.takeId, list);
  }
  for (const list of momentsByTake.values()) list.sort((a, b) => a.atMs - b.atMs);

  const goodTakes = takes.filter((t) => t.status === 'good');
  const discardedTakes = takes.filter((t) => t.status === 'discarded');
  const totalRollMs = takes.reduce((sum, t) => sum + t.durationMs, 0);
  const takeById = new Map(takes.map((t) => [t.id, t]));

  // ---- cover header ------------------------------------------------------
  y -= 18;
  text(project.name, { font: bold, size: 26 });
  y -= 16;
  text(formatDate(Date.now()), { size: 9.5, color: GRAY });
  y -= 16;
  text(
    `${slates.length} slates  -  ${goodTakes.length} good takes  -  ${discardedTakes.length} discarded  -  total roll ${tc.msToClock(totalRollMs)}`,
    { size: 9.5, color: GRAY },
  );
  y -= 12;
  text('Wall clock columns line up with cameras jammed to time-of-day TC.', {
    size: 8,
    color: LIGHT,
  });
  y -= 14;
  rule();
  y -= 22;

  // ---- GOLD moments ------------------------------------------------------
  const goodTakeIds = new Set(goodTakes.map((t) => t.id));
  const goldMoments = moments
    .filter((m) => m.tag === 'GOLD' && goodTakeIds.has(m.takeId))
    .sort((a, b) => a.atMs - b.atMs);
  if (goldMoments.length > 0) {
    ensure(30 + goldMoments.length * 13);
    text('GOLD moments', { font: bold, size: 11, color: GOLD });
    y -= 16;
    for (const m of goldMoments) {
      ensure(13);
      const take = takeById.get(m.takeId);
      if (!take) continue;
      const line = [
        slateName.get(take.slateId) ?? '',
        `Take ${take.number}`,
        take.clipName,
        tc.msToClock(m.atMs),
        m.label,
      ]
        .filter(Boolean)
        .join('  -  ');
      text(line, { size: 9 });
      y -= 13;
    }
    y -= 8;
    rule();
    y -= 22;
  }

  // ---- slates ------------------------------------------------------------
  for (const slate of slatesOrdered) {
    const slateGood = (takesBySlate.get(slate.id) ?? []).filter((t) => t.status === 'good');
    if (slateGood.length === 0) continue;

    ensure(46);
    text(slate.name, { font: bold, size: 14 });
    y -= 7;
    rule();
    y -= 18;

    for (const take of slateGood) {
      const takeMoments = momentsByTake.get(take.id) ?? [];
      ensure(20 + (take.note ? 13 : 0) + Math.min(takeMoments.length, 3) * 13);

      let title = `Take ${take.number}  -  ${take.clipName}  -  ${tc.msToClock(take.durationMs)}`;
      if (take.cameraTC) title += `  -  TC ${take.cameraTC}`;
      title += `  -  clock ${wallClockTC(take.startedAt, fps)}`;
      text(title, { font: bold, size: 10.5 });
      y -= 14;

      if (take.note) {
        ensure(13);
        text(take.note, { x: MARGIN + 12, size: 9, color: GRAY });
        y -= 13;
      }

      for (const m of takeMoments) {
        ensure(13);
        const cameraCol = safeCameraTc(take.cameraTC, m.atMs, fps);
        text(momentLine(m), {
          x: MARGIN + 12,
          size: 9,
          maxWidth: (cameraCol ? TC_COLUMN_X - 10 : A4[0] - MARGIN) - (MARGIN + 12),
        });
        if (cameraCol) {
          text(cameraCol, { x: TC_COLUMN_X, size: 9, color: GRAY });
        }
        y -= 13;
      }
      y -= 9;
    }
    y -= 8;
  }

  // ---- discarded appendix ------------------------------------------------
  if (discardedTakes.length > 0) {
    ensure(46);
    text('Discarded takes', { font: bold, size: 12, color: GRAY });
    y -= 7;
    rule();
    y -= 16;
    for (const take of discardedTakes) {
      ensure(13);
      const line = [
        'DISCARDED',
        slateName.get(take.slateId) ?? '',
        `Take ${take.number}`,
        take.clipName,
        tc.msToClock(take.durationMs),
      ]
        .filter(Boolean)
        .join('  -  ');
      text(line, { size: 9, color: GRAY });
      y -= 13;
    }
  }

  // ---- page numbers ------------------------------------------------------
  const pages = doc.getPages();
  pages.forEach((p, i) => {
    const label = `${i + 1} / ${pages.length}`;
    const w = helv.widthOfTextAtSize(label, 8);
    p.drawText(label, { x: A4[0] - MARGIN - w, y: 32, size: 8, font: helv, color: GRAY });
  });

  const bytes = await doc.save();
  return new Blob([bytes as unknown as BlobPart], { type: 'application/pdf' });
}
