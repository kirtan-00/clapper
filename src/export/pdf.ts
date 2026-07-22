// Editor-facing PDF report. pdf-lib, standard Helvetica, A4 portrait.
// Editorial and printable: cover header with stats, GOLD summary table, shots
// grouped by scene in ruled tables, discarded appendix in gray, page numbers
// bottom right. No em dashes anywhere; plain '-' only.

import { PDFDocument, PDFFont, PDFPage, StandardFonts, rgb } from 'pdf-lib';
import type { Fps, Moment, ProjectBundle, Take } from '../types';
import { tc, wallClockTC } from './timecode';

const A4: [number, number] = [595.28, 841.89];
const MARGIN = 54;
const BOTTOM = 64; // keep clear of the page number
const CONTENT_WIDTH = A4[0] - MARGIN * 2;
const RIGHT = A4[0] - MARGIN;

const INK = rgb(0.09, 0.09, 0.11);
const GRAY = rgb(0.45, 0.45, 0.48);
const LIGHT = rgb(0.78, 0.78, 0.8);
const RULE = rgb(0.85, 0.85, 0.88);
const GOLD = rgb(0.62, 0.47, 0.08);
const BAND = rgb(0.925, 0.925, 0.94); // shot header band
const HEADBAND = rgb(0.87, 0.87, 0.9); // column header row
const ALT = rgb(0.972, 0.972, 0.98); // alternating detail row

type Color = ReturnType<typeof rgb>;
type Align = 'left' | 'right';
interface Col {
  x: number;
  w: number;
  align: Align;
  header: string;
}

/** Build columns left-to-right from a list of [header, width, align] specs. */
function layout(specs: [string, number, Align][]): Col[] {
  let x = MARGIN;
  return specs.map(([header, w, align]) => {
    const col: Col = { x, w, align, header };
    x += w;
    return col;
  });
}

// SHOT | CLIP | MOMENT | TIME | CAMERA TC | WALL CLOCK  (sum = CONTENT_WIDTH)
// The shot band writes the roll length into TIME and the clock into WALL CLOCK,
// so every value sits under its own heading. There is deliberately no separate
// LENGTH column: it was never populated, and a shot's length IS its time.
const SHOT_COLS = layout([
  ['SHOT', 40, 'left'],
  ['CLIP', 52, 'left'],
  ['MOMENT', 189.28, 'left'],
  ['TIME', 56, 'right'],
  ['CAMERA TC', 96, 'right'],
  ['WALL CLOCK', 54, 'right'],
]);
const [, , C_MOMENT, C_TIME, C_CAMTC, C_WALL] = SHOT_COLS;

// SCENE | SHOT | CLIP | TIME | LABEL  (GOLD summary)
const GOLD_COLS = layout([
  ['SCENE', 96, 'left'],
  ['SHOT', 40, 'left'],
  ['CLIP', 56, 'left'],
  ['TIME', 60, 'right'],
  ['LABEL', 235.28, 'left'],
]);
const [G_SCENE, G_SHOT, G_CLIP, G_TIME, G_LABEL] = GOLD_COLS;

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

function momentTime(m: Moment): string {
  return m.kind === 'range' && m.endMs !== undefined
    ? `${tc.msToClock(m.atMs)}-${tc.msToClock(m.endMs)}`
    : tc.msToClock(m.atMs);
}

/**
 * A take's clip(s) for a table cell. Single-cam is just the clip name; multi-cam
 * lists every camera with its unit letter, e.g. "A C0012 · B C0007 · C C0003".
 */
function clipLabel(take: Take): string {
  if (take.clips && take.clips.length) {
    return take.clips.map((c) => `${c.unit} ${c.clipName}`).join('  ·  ');
  }
  return take.clipName;
}

export async function toPdf(bundle: ProjectBundle): Promise<Blob> {
  const { project, slates, takes, moments } = bundle;
  const fps = project.fps;

  const doc = await PDFDocument.create();
  const helv = await doc.embedFont(StandardFonts.Helvetica);
  const bold = await doc.embedFont(StandardFonts.HelveticaBold);

  let page: PDFPage = doc.addPage(A4);
  let y = A4[1] - MARGIN;

  // Redrawn at the top of a fresh page when a table breaks mid-flow.
  let onBreak: (() => void) | null = null;

  const newPage = () => {
    page = doc.addPage(A4);
    y = A4[1] - MARGIN;
    if (onBreak) onBreak();
  };
  /** Ensure a row of height h fits; break (and repeat headers) if not. */
  const ensure = (h: number) => {
    if (y - h < BOTTOM) newPage();
  };

  const baselineOf = (bottom: number, h: number, size: number) => bottom + (h - size) / 2 + 1;

  /** Draw one text value inside a column at the given baseline. */
  const cell = (
    col: Col,
    value: string,
    baseline: number,
    opts: { font?: PDFFont; size?: number; color?: Color; trunc?: boolean } = {},
  ) => {
    if (!value) return;
    const font = opts.font ?? helv;
    const size = opts.size ?? 8;
    let t = sanitize(value);
    if (opts.trunc) t = truncate(t, font, size, col.w - 4);
    const w = font.widthOfTextAtSize(t, size);
    const x = col.align === 'right' ? col.x + col.w - w - 2 : col.x + 2;
    page.drawText(t, { x, y: baseline, size, font, color: opts.color ?? INK });
  };

  /** A simple heading line (project sections). Advances y. */
  const heading = (str: string, size: number, color: Color = INK, font: PDFFont = bold) => {
    ensure(size + 8);
    y -= size + 2;
    page.drawText(truncate(sanitize(str), font, size, CONTENT_WIDTH), {
      x: MARGIN,
      y,
      size,
      font,
      color,
    });
    y -= 8;
  };

  const rule = (color: Color = LIGHT, thickness = 0.6) => {
    page.drawLine({ start: { x: MARGIN, y }, end: { x: RIGHT, y }, thickness, color });
  };

  /** Column header row for a table. Advances y. */
  const columnHeader = (cols: Col[]) => {
    const h = 15;
    const bottom = y - h;
    page.drawRectangle({ x: MARGIN, y: bottom, width: CONTENT_WIDTH, height: h, color: HEADBAND });
    const base = baselineOf(bottom, h, 7.5);
    for (const c of cols) cell(c, c.header, base, { font: bold, size: 7.5, color: INK, trunc: true });
    page.drawLine({ start: { x: MARGIN, y: bottom }, end: { x: RIGHT, y: bottom }, thickness: 0.6, color: GRAY });
    y -= h;
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
  page.drawText(sanitize(project.name), { x: MARGIN, y, size: 26, font: bold, color: INK });
  y -= 16;
  page.drawText(formatDate(Date.now()), { x: MARGIN, y, size: 9.5, font: helv, color: GRAY });
  y -= 16;
  page.drawText(
    sanitize(
      `${slates.length} scenes  -  ${goodTakes.length} good shots  -  ${discardedTakes.length} discarded  -  total roll ${tc.msToClock(totalRollMs)}`,
    ),
    { x: MARGIN, y, size: 9.5, font: helv, color: GRAY },
  );
  y -= 12;
  page.drawText('Wall clock columns line up with cameras jammed to time-of-day TC.', {
    x: MARGIN,
    y,
    size: 8,
    font: helv,
    color: LIGHT,
  });
  y -= 14;
  rule();
  y -= 20;

  // ---- GOLD moments summary table ----------------------------------------
  const goodTakeIds = new Set(goodTakes.map((t) => t.id));
  const goldMoments = moments
    .filter((m) => m.tag === 'GOLD' && goodTakeIds.has(m.takeId))
    .sort((a, b) => a.atMs - b.atMs);
  if (goldMoments.length > 0) {
    heading('GOLD moments', 11, GOLD);
    onBreak = () => columnHeader(GOLD_COLS);
    columnHeader(GOLD_COLS);
    let i = 0;
    for (const m of goldMoments) {
      const take = takeById.get(m.takeId);
      if (!take) continue;
      const h = 14;
      ensure(h);
      const bottom = y - h;
      if (i % 2 === 1) page.drawRectangle({ x: MARGIN, y: bottom, width: CONTENT_WIDTH, height: h, color: ALT });
      page.drawLine({ start: { x: MARGIN, y: bottom }, end: { x: RIGHT, y: bottom }, thickness: 0.4, color: RULE });
      const base = baselineOf(bottom, h, 8);
      cell(G_SCENE, slateName.get(take.slateId) ?? '', base, { trunc: true });
      cell(G_SHOT, `Shot ${take.number}`, base, { trunc: true });
      cell(G_CLIP, clipLabel(take), base, { trunc: true });
      cell(G_TIME, momentTime(m), base, { size: 7.5 });
      cell(G_LABEL, m.label || '-', base, { trunc: true });
      y -= h;
      i += 1;
    }
    onBreak = null;
    y -= 20;
  }

  // ---- scenes: one ruled table per scene ---------------------------------
  for (const slate of slatesOrdered) {
    const sceneGood = (takesBySlate.get(slate.id) ?? []).filter((t) => t.status === 'good');
    if (sceneGood.length === 0) continue;

    // Keep scene heading + column header + first shot band together.
    ensure(20 + 15 + 16);
    heading(`Scene: ${slate.name}`, 12);
    onBreak = () => columnHeader(SHOT_COLS);
    columnHeader(SHOT_COLS);

    for (const take of sceneGood) {
      // shot header band (shaded, full width)
      const bandH = 16;
      ensure(bandH);
      const bandBottom = y - bandH;
      page.drawRectangle({ x: MARGIN, y: bandBottom, width: CONTENT_WIDTH, height: bandH, color: BAND });
      // The band is column-aligned with the moment rows below it, so a value
      // always sits under its own heading: roll length under TIME, and the
      // clock ONLY under WALL CLOCK. The identity (shot + clip) runs free
      // across the left, truncated before it can reach the TIME column.
      const bandBase = baselineOf(bandBottom, bandH, 8.5);
      const bandLabel = [`Shot ${take.number}`, clipLabel(take)].filter(Boolean).join('  -  ');
      const labelWidth = C_TIME.x - (MARGIN + 4) - 6;
      page.drawText(truncate(sanitize(bandLabel), bold, 8.5, labelWidth), {
        x: MARGIN + 4,
        y: bandBase,
        size: 8.5,
        font: bold,
        color: INK,
      });
      cell(C_TIME, tc.msToClock(take.durationMs), bandBase, { font: bold, size: 8.5 });
      if (take.cameraTC) cell(C_CAMTC, take.cameraTC, bandBase, { font: bold, size: 8.5 });
      cell(C_WALL, wallClockTC(take.startedAt, fps), bandBase, { font: bold, size: 8.5 });
      y -= bandH;

      // optional shot note (muted, spans the width)
      if (take.note) {
        const nh = 12;
        ensure(nh);
        const nb = y - nh;
        page.drawText(truncate(sanitize(`note: ${take.note}`), helv, 7.5, CONTENT_WIDTH - 8), {
          x: MARGIN + 4,
          y: baselineOf(nb, nh, 7.5),
          size: 7.5,
          font: helv,
          color: GRAY,
        });
        y -= nh;
      }

      // one detail row per moment
      const takeMoments = momentsByTake.get(take.id) ?? [];
      let i = 0;
      for (const m of takeMoments) {
        const h = 14;
        ensure(h);
        const bottom = y - h;
        if (i % 2 === 1) page.drawRectangle({ x: MARGIN, y: bottom, width: CONTENT_WIDTH, height: h, color: ALT });
        page.drawLine({ start: { x: MARGIN, y: bottom }, end: { x: RIGHT, y: bottom }, thickness: 0.4, color: RULE });
        const base = baselineOf(bottom, h, 8);
        const isRange = m.kind === 'range' && m.endMs !== undefined;
        const gold = m.tag === 'GOLD';
        const momentText = [m.tag, m.label].filter(Boolean).join(' ') || (isRange ? 'range' : 'mark');
        cell(C_MOMENT, momentText, base, { font: gold ? bold : helv, color: gold ? GOLD : INK, trunc: true });
        cell(C_TIME, momentTime(m), base, { size: 7.5 });
        const camStart = safeCameraTc(take.cameraTC, m.atMs, fps);
        if (camStart) {
          const camEnd = isRange ? safeCameraTc(take.cameraTC, m.endMs as number, fps) : undefined;
          cell(C_CAMTC, camEnd ? `${camStart}-${camEnd}` : camStart, base, { size: 7.5, color: GRAY });
        }
        cell(C_WALL, wallClockTC(take.startedAt + m.atMs, fps), base, { size: 7.5, color: GRAY });
        y -= h;
        i += 1;
      }
    }
    onBreak = null;
    y -= 16;
  }

  // ---- discarded appendix (gray, strikethrough) --------------------------
  if (discardedTakes.length > 0) {
    heading('Discarded shots', 12, GRAY);
    y -= 2;
    rule();
    y -= 14;
    for (const take of discardedTakes) {
      const h = 13;
      ensure(h);
      const bottom = y - h;
      const base = baselineOf(bottom, h, 8);
      const parts = [
        'DISCARDED',
        slateName.get(take.slateId) ?? '',
        `Shot ${take.number}`,
        clipLabel(take),
        tc.msToClock(take.durationMs),
      ].filter(Boolean);
      const line = truncate(sanitize(parts.join('  -  ')), helv, 8, CONTENT_WIDTH);
      page.drawText(line, { x: MARGIN, y: base, size: 8, font: helv, color: GRAY });
      const lineW = helv.widthOfTextAtSize(line, 8);
      page.drawLine({
        start: { x: MARGIN, y: base + 2.5 },
        end: { x: MARGIN + lineW, y: base + 2.5 },
        thickness: 0.5,
        color: GRAY,
      });
      y -= h;
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
