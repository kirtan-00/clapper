// Editor-facing PDF report. pdf-lib, standard Helvetica, A4 portrait.
// Editorial and printable: cover header with stats, GOLD summary table, takes
// grouped by scene and then by SHOT in ruled tables, discarded appendix in
// gray, page numbers bottom right. No em dashes anywhere; plain '-' only.
//
// Hierarchy is Scene > Shot > Take throughout. This file used to print
// "Shot 3" for take 3, which stole the word from the real thing.

import { PDFDocument, PDFFont, PDFPage, StandardFonts, rgb } from 'pdf-lib';
import type { Fps, Moment, Project, ProjectBundle, Take } from '../types';
import { tc, wallClockTC } from './timecode';
import { buildShotIndex, compareTakesInStoryOrder, displayShootDay, shortDateLabel, shotCodeOf } from './order';

const A4: [number, number] = [595.28, 841.89];
const MARGIN = 54;
const BOTTOM = 64; // keep clear of the page number
const CONTENT_WIDTH = A4[0] - MARGIN * 2;
const RIGHT = A4[0] - MARGIN;

// The app's own palette, straight off the :root tokens in styles.css - the
// report should read as the same object as the thing that logged it. INK is
// the TEXT colour here (chalk on ink), not the darkest thing on the page:
// every name kept its role so the whole file did not have to be re-read.
//
// Chalk is deliberately warm off-white, never pure #fff, exactly as on screen.
const PAPER = rgb(0.047, 0.051, 0.063); // --ink-950, the page itself
const INK = rgb(0.925, 0.914, 0.882); // --chalk, primary text
const GRAY = rgb(0.604, 0.616, 0.655); // --chalk-dim, secondary text
// --chalk-faint lifted: on a backlit phone #61646e reads fine as tertiary, but
// printed as toner on a black field it sits at 3.2:1 and disappears. This is
// the same role, pulled up to ~4.9:1.
const LIGHT = rgb(0.49, 0.502, 0.545);
const RULE = rgb(0.137, 0.149, 0.184); // --line-soft, hairlines inside tables
const GOLD = rgb(0.89, 0.698, 0.29); // --brass, GOLD tags
const BAND = rgb(0.122, 0.133, 0.169); // --ink-800, take header band
const HEADBAND = rgb(0.094, 0.102, 0.129); // --ink-850, column header row
const ALT = rgb(0.071, 0.075, 0.098); // --ink-900, alternating detail row
const STICK_DARK = rgb(0.078, 0.082, 0.102); // the dark teeth of the clapper stick
const GO = rgb(0.22, 0.82, 0.47); // --go, the mark's lens dot

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

// TAKE | CLIP | MOMENT | TIME | CAMERA TC | DATE | WALL CLOCK  (sum = CONTENT_WIDTH)
// The take band writes the roll length into TIME and the clock into WALL CLOCK,
// so every value sits under its own heading. There is deliberately no separate
// LENGTH column: it was never populated, and a take's length IS its time.
// The SHOT is not a column here - it is the sub-heading above each group of
// bands, because a shot owns many takes and repeating its code on every row
// would be noise. DATE (40) is new, its width taken straight out of MOMENT
// (189.28 -> 149.28) so the row still sums to CONTENT_WIDTH exactly:
//   40 + 52 + 149.28 + 56 + 96 + 40 + 54 = 487.28.
//
// DATE SITS TO THE RIGHT OF TIME ON PURPOSE, not next to CLIP where it reads
// more naturally. The take band's identity ("Take 1 - A C0001 - B B0001") is
// drawn free-hand across the left and is truncated only at C_TIME.x, so it
// RUNS THROUGH every column between CLIP and TIME. A DATE cell parked in that
// stretch gets overprinted by it - two strings on the same baseline, glyphs
// interleaved into "B3C000101". Anything added here must land at or after
// TIME, or the band label's truncation width must shrink to meet it.
// It also reads well: "31 Jul  14:08:49" next to WALL CLOCK is one datetime.
const TAKE_COLS = layout([
  ['TAKE', 40, 'left'],
  ['CLIP', 52, 'left'],
  ['MOMENT', 149.28, 'left'],
  ['TIME', 56, 'right'],
  ['CAMERA TC', 96, 'right'],
  ['DATE', 40, 'right'],
  ['WALL CLOCK', 54, 'right'],
]);
// POSITIONAL destructure - the holes are TAKE and CLIP, which the band draws by
// hand across the left rather than through cells. Reorder the list above and
// this MUST be updated in lockstep or every value lands one column off.
const [, , C_MOMENT, C_TIME, C_CAMTC, C_DATE, C_WALL] = TAKE_COLS;

// SCENE | SHOT | TAKE | CLIP | DATE | TIME | LABEL  (GOLD summary)
// SHOT (46) is new; its width comes straight out of LABEL (235.28 -> 189.28) so
// the row still sums to CONTENT_WIDTH exactly. DATE (40) is new too, its width
// taken straight out of LABEL again (189.28 -> 149.28):
// CLIP was 56 and truncated any real multi-cam name to "A A001_C0..." - the
// one string in this table an assistant actually needs to read. It takes 44
// back out of LABEL (149.28 -> 105.28), which is a summary line and survives
// being shorter:
//   96 + 46 + 40 + 100 + 40 + 60 + 105.28 = 487.28.
const GOLD_COLS = layout([
  ['SCENE', 96, 'left'],
  ['SHOT', 46, 'left'],
  ['TAKE', 40, 'left'],
  ['CLIP', 100, 'left'],
  ['DATE', 40, 'left'],
  ['TIME', 60, 'right'],
  ['LABEL', 105.28, 'left'],
]);
// POSITIONAL destructure, seven entries to match the seven specs above.
const [G_SCENE, G_SHOT, G_TAKE, G_CLIP, G_DATE, G_TIME, G_LABEL] = GOLD_COLS;

// ------------------------------------------------------------ brand marks ---
// The clapper stick stripe is the app's signature motif (--stripe in
// styles.css: a -60deg repeating gradient, 14px chalk / 14px ink). It is the
// one thing that has to look identical on the phone and on this page, so the
// geometry below is the same angle and the same duty cycle, scaled to points.

const STRIPE_ANGLE_DX = 0.577; // tan(30deg): a -60deg stripe leans this much per unit of height
// One light + one dark tooth. The app's stripe is 14px+14px on a phone; scaled
// to a 487pt A4 measure that reads as about two dozen teeth across the page.
// Finer than this and the stick stops looking like a clapper and starts looking
// like a serrated rule.
const STRIPE_PITCH = 24;

type Pt = { x: number; y: number };

/**
 * Clip a convex polygon to a vertical slab (Sutherland-Hodgman, two planes).
 *
 * The teeth are parallelograms that overhang both ends of the bar they sit in.
 * Clipping them properly - rather than covering the overhang with a
 * page-coloured rectangle - means a stick can be drawn over ANY background,
 * including on top of another filled band, without leaving a seam.
 */
function clipToSlab(poly: Pt[], x0: number, x1: number): Pt[] {
  const pass = (pts: Pt[], keep: (p: Pt) => boolean, at: (a: Pt, b: Pt) => Pt): Pt[] => {
    const out: Pt[] = [];
    for (let i = 0; i < pts.length; i++) {
      const cur = pts[i];
      const prev = pts[(i + pts.length - 1) % pts.length];
      const curIn = keep(cur);
      if (curIn !== keep(prev)) out.push(at(prev, cur));
      if (curIn) out.push(cur);
    }
    return out;
  };
  const cross = (a: Pt, b: Pt, x: number): Pt => ({
    x,
    y: a.y + ((b.y - a.y) * (x - a.x)) / (b.x - a.x || 1),
  });
  const left = pass(poly, (p) => p.x >= x0, (a, b) => cross(a, b, x0));
  if (left.length === 0) return [];
  return pass(left, (p) => p.x <= x1, (a, b) => cross(a, b, x1));
}

/**
 * A run of clapper-stick stripe. `light` is the chalk tooth colour and `dark`
 * the gap between them; the caller fills the bar with `dark` first, so only
 * the light teeth are actually drawn.
 */
function stripeBar(
  page: PDFPage,
  x: number,
  y: number,
  w: number,
  h: number,
  opts: { light?: Color; dark?: Color; pitch?: number } = {},
): void {
  const light = opts.light ?? INK;
  const dark = opts.dark ?? STICK_DARK;
  const pitch = opts.pitch ?? STRIPE_PITCH;
  page.drawRectangle({ x, y, width: w, height: h, color: dark });
  const lean = h * STRIPE_ANGLE_DX;
  const tooth = pitch / 2;
  // Start far enough left that the first tooth's TOP edge can still overhang.
  for (let left = x - lean - pitch; left < x + w + pitch; left += pitch) {
    const quad: Pt[] = [
      { x: left, y },
      { x: left + tooth, y },
      { x: left + tooth + lean, y: y + h },
      { x: left + lean, y: y + h },
    ];
    const clipped = clipToSlab(quad, x, x + w);
    if (clipped.length < 3) continue;
    // drawSvgPath draws in SVG space - y runs DOWN from the anchor - so a point
    // written as (X, -Y) against a (0, 0) anchor lands at PDF (X, Y). Handing
    // it raw PDF coordinates puts every tooth off the top of the page, which
    // is silent: the path is emitted, it just never intersects the paper.
    page.drawSvgPath(`M ${clipped.map((p) => `${p.x} ${-p.y}`).join(' L ')} Z`, {
      x: 0,
      y: 0,
      color: light,
      borderWidth: 0,
    });
  }
}

/**
 * The Clapper mark: a slate body with three ruled lines and a lens dot, and the
 * striped stick hinged open above it. Same construction as public/favicon.svg,
 * drawn in points so it stays crisp at any size instead of riding a bitmap.
 *
 * Anchored by its BOTTOM-LEFT corner, `size` points square.
 */
function drawMark(page: PDFPage, x: number, y: number, size: number): void {
  const u = size / 1024; // the favicon's own coordinate space
  const px = (v: number) => x + v * u;
  // The SVG's y axis runs down the tile; ours runs up the page.
  const py = (v: number) => y + size - v * u;

  page.drawRectangle({ x, y, width: size, height: size, color: PAPER });
  // slate body
  page.drawRectangle({
    x: px(150),
    y: py(842),
    width: 724 * u,
    height: 372 * u,
    color: BAND,
  });
  // the three ruled lines on the slate, shortening down the body
  for (const [x2, yv] of [
    [802, 572],
    [690, 660],
    [600, 748],
  ]) {
    page.drawLine({
      start: { x: px(222), y: py(yv) },
      end: { x: px(x2), y: py(yv) },
      thickness: 18 * u,
      color: RULE,
    });
  }
  page.drawCircle({ x: px(792), y: py(748), size: 52 * u, color: GO });
  // The stick sits level here rather than at the favicon's -16deg: at this size
  // a rotated stripe reads as a printing fault, and the lean of the teeth
  // already carries the clapper idea.
  // The favicon's own pitch (128 of its 1024 units), not the page's: at this
  // size the A4 pitch would put half a tooth on the stick and it would read as
  // a smudge. Six teeth, exactly as the icon on the home screen.
  stripeBar(page, px(150), py(506), 772 * u, 176 * u, { pitch: 128 * u });
  page.drawCircle({ x: px(214), y: py(432), size: 30 * u, color: GO });
}

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

/**
 * Pack `parts` into as few lines as fit `maxWidth`, breaking only BETWEEN parts.
 *
 * The take band's identity is a list of whole clip names, and half a clip name
 * is worse than useless to whoever is relinking - so this never splits one.
 * A single part too long for a line still gets its own line and is truncated
 * there rather than silently dropped.
 */
export function packLines(
  parts: string[],
  sep: string,
  font: PDFFont,
  size: number,
  maxWidth: number,
): string[] {
  const lines: string[] = [];
  let line = '';
  for (const part of parts) {
    const candidate = line ? line + sep + part : part;
    if (!line || font.widthOfTextAtSize(candidate, size) <= maxWidth) {
      line = candidate;
      continue;
    }
    lines.push(line);
    line = part;
  }
  if (line) lines.push(line);
  return lines.map((l) => truncate(l, font, size, maxWidth));
}

function safeCameraTc(base: string | undefined, ms: number, fps: Fps): string | undefined {
  if (!base) return undefined;
  try {
    return tc.addMsToTimecode(base, ms, fps);
  } catch {
    return undefined;
  }
}

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

function formatDate(epochMs: number): string {
  const d = new Date(epochMs);
  return `${d.getDate()} ${MONTHS[d.getMonth()]} ${d.getFullYear()}`;
}

/** "1 scene" / "2 scenes" - this sheet goes to a client, so it reads like English. */
function plural(n: number, word: string): string {
  return `${n} ${word}${n === 1 ? '' : 's'}`;
}

function momentTime(m: Moment): string {
  return m.kind === 'range' && m.endMs !== undefined
    ? `${tc.msToClock(m.atMs)}-${tc.msToClock(m.endMs)}`
    : tc.msToClock(m.atMs);
}

/**
 * A take's clip(s) for a table cell. Single-cam is just the clip name; multi-cam
 * lists every camera with its unit letter, e.g. "A C0012 · B C0007 · C C0003".
 * The sound file (when the project has a Sound unit and this take recorded one)
 * rides alongside as one more entry, e.g. "... · SND SND_0042" - never its own
 * column, so a project with no sound renders byte-identical to before.
 */
function clipLabelParts(take: Take, project: Project): string[] {
  const parts: string[] =
    take.clips && take.clips.length
      ? take.clips.map((c) => `${c.unit} ${c.clipName}`)
      : [take.clipName];
  if (project.sound && take.sound) parts.push(`SND ${take.sound.fileName}`);
  return parts;
}

function clipLabel(take: Take, project: Project): string {
  return clipLabelParts(take, project).join('  ·  ');
}

export async function toPdf(bundle: ProjectBundle): Promise<Blob> {
  const { project, slates, takes, moments } = bundle;
  const fps = project.fps;

  const doc = await PDFDocument.create();
  const helv = await doc.embedFont(StandardFonts.Helvetica);
  const bold = await doc.embedFont(StandardFonts.HelveticaBold);

  /** Every page is the app's own surface: full-bleed ink, with a thin strip of
   *  clapper stick along the very top edge so a loose page still reads as ours. */
  const startPage = (first = false): PDFPage => {
    const p = doc.addPage(A4);
    p.drawRectangle({ x: 0, y: 0, width: A4[0], height: A4[1], color: PAPER });
    // Exactly ONE stick per page. Page 1 gets the hero one under the masthead,
    // so it skips this rail - two parallel sticks an inch apart fight each
    // other and neither reads as the signature.
    if (!first) stripeBar(p, 0, A4[1] - 6, A4[0], 6);
    return p;
  };

  let page: PDFPage = startPage(true);
  let y = A4[1] - MARGIN;

  // Redrawn at the top of a fresh page when a table breaks mid-flow.
  let onBreak: (() => void) | null = null;
  // The shot whose take bands are currently being drawn, so a scene that spills
  // onto the next page can re-announce it. null while drawing a scene's
  // ungrouped takes (and for every legacy project), which is why the
  // continuation block below is conditional.
  let currentShotLabel: string | null = null;

  const newPage = () => {
    page = startPage();
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

  /**
   * The light sub-heading naming the shot that owns the bands below it, e.g.
   * "5.31 · MCU · PUSH IN". Deliberately NOT a filled band - the take bands are
   * already shaded, and a second shaded row would fight them.
   *
   * Does no ensure() of its own: the caller has to reserve heading + first band
   * together BEFORE adopting the label (see the scene loop), otherwise a break
   * fired from in here would redraw the heading through onBreak and we would
   * print it twice.
   */
  const shotHeadingRow = (label: string) => {
    const h = 14;
    const bottom = y - h;
    page.drawText(truncate(sanitize(label), bold, 8.5, CONTENT_WIDTH - 4), {
      x: MARGIN,
      y: baselineOf(bottom, h, 8.5),
      size: 8.5,
      font: bold,
      color: GRAY,
    });
    y -= h;
  };

  // ---- data prep ---------------------------------------------------------
  const slatesOrdered = [...slates].sort((a, b) => a.order - b.order);
  const slateName = new Map(slates.map((s) => [s.id, s.name]));
  const shotIndex = buildShotIndex(bundle);
  const takesBySlate = new Map<string, Take[]>();
  for (const t of takes) {
    const list = takesBySlate.get(t.slateId) ?? [];
    list.push(t);
    takesBySlate.set(t.slateId, list);
  }
  // Take numbers repeat within a scene now (5.31 take 1, then 5.32 take 1), so
  // number alone would interleave setups. Shared rule: scene -> shot -> take.
  const byStoryOrder = compareTakesInStoryOrder(bundle);
  for (const list of takesBySlate.values()) list.sort(byStoryOrder);

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
  // The mark sits to the LEFT of the title on its own baseline, the same
  // relationship the app's masthead has, so the report opens the way the app
  // does rather than with a logo parked in a corner.
  y -= 18;
  const MARK = 46;
  drawMark(page, MARGIN, y - 13, MARK);
  const titleX = MARGIN + MARK + 14;
  page.drawText(sanitize(project.name), { x: titleX, y, size: 26, font: bold, color: INK });
  y -= 16;
  page.drawText(formatDate(Date.now()), { x: MARGIN, y, size: 9.5, font: helv, color: GRAY });
  y -= 16;
  page.drawText(
    sanitize(
      `${plural(slates.length, 'scene')}  -  ${plural(goodTakes.length, 'good take')}  -  ${discardedTakes.length} discarded  -  total roll ${tc.msToClock(totalRollMs)}`,
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

  // Operators: "Camera A - Rohan's cam", one per configured unit that has a
  // name, plus "Sound - <mixer>" when the project carries a Sound unit with a
  // named operator. Skipped entirely if nobody bothered to name anyone.
  const operatorParts = [
    ...(project.cameras ?? [])
      .filter((u) => u.operator && u.operator.trim())
      .map((u) => `Camera ${u.letter} - ${u.operator}`),
    ...(project.sound?.operator && project.sound.operator.trim() ? [`Sound - ${project.sound.operator}`] : []),
  ];
  const operatorLine = operatorParts.join('   ·   ');
  if (operatorLine) {
    y -= 12;
    page.drawText(sanitize(operatorLine), { x: MARGIN, y, size: 8, font: helv, color: GRAY });
  }

  // The main line under the masthead IS the clapper stick, not a hairline.
  y -= 18;
  stripeBar(page, MARGIN, y, CONTENT_WIDTH, 9);
  y -= 22;

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
      // Shot code as printed on the shotlist; '' for a take logged straight
      // against a scene, which just leaves the cell blank.
      cell(G_SHOT, shotCodeOf(take, shotIndex), base, { trunc: true });
      cell(G_TAKE, `Take ${take.number}`, base, { trunc: true });
      cell(G_CLIP, clipLabel(take, project), base, { trunc: true });
      cell(G_DATE, shortDateLabel(displayShootDay(take)), base, { trunc: true });
      cell(G_TIME, momentTime(m), base, { size: 7.5 });
      cell(G_LABEL, m.label || '-', base, { trunc: true });
      y -= h;
      i += 1;
    }
    onBreak = null;
    y -= 20;
  }

  // ---- scenes: one ruled table per scene ---------------------------------
  // Sections are the project's scenes in story order, plus - at the end - one
  // per slate id that has takes but no Slate in the bundle. Without that tail a
  // take whose scene went missing was dropped from the body while the GOLD
  // table above still listed it: an internally inconsistent document. csv.ts
  // has always had this fallback; the PDF did not.
  const sceneSections = [
    ...slatesOrdered.map((s) => ({ id: s.id, name: s.name, hasShots: (s.shots?.length ?? 0) > 0 })),
    ...[...takesBySlate.keys()]
      .filter((id) => !slateName.has(id))
      .map((id) => ({ id, name: '(scene missing)', hasShots: false })),
  ];

  for (const section of sceneSections) {
    const sceneGood = (takesBySlate.get(section.id) ?? []).filter((t) => t.status === 'good');
    if (sceneGood.length === 0) continue;

    // Keep scene heading + column header + first take band together. A scene
    // that HAS shots also has a shot sub-heading to fit, so reserve for that
    // too; a legacy scene reserves exactly what it always did.
    ensure(20 + 15 + 16 + (section.hasShots ? 14 : 0));
    heading(`Scene: ${section.name}`, 12);
    onBreak = () => {
      // A scene spanning pages must re-announce BOTH levels or page 4 is a wall
      // of take bands with no scene and no setup attached to them. The scene
      // half of this was already missing before shots existed; a 47-shot scene
      // makes it unreadable, so both are repeated here.
      heading(`Scene: ${section.name}  (cont.)`, 12);
      columnHeader(TAKE_COLS);
      if (currentShotLabel) shotHeadingRow(`${currentShotLabel}  (cont.)`);
    };
    columnHeader(TAKE_COLS);

    // `sceneGood` is already in shot-order-then-take-number order, so emitting a
    // sub-heading every time the shot CHANGES is the whole grouping - no second
    // data structure. A take with no shotId, or one whose shotId matches no shot
    // in THIS slate (an orphan: the breakdown was edited under it), resolves to
    // undefined, keys as '' and rides in the leading ungrouped run exactly as it
    // did before shots existed. It is never dropped.
    let shotKey = ''; // '' = the scene's own ungrouped takes, which sort first
    for (const take of sceneGood) {
      const shot = shotIndex.of(take);
      const key = shot?.id ?? '';
      if (key !== shotKey) {
        shotKey = key;
        // Drop the label BEFORE reserving space: if the reservation breaks the
        // page, onBreak must not redraw the PREVIOUS shot's heading, nor the new
        // one we are about to draw a line later.
        currentShotLabel = null;
        if (shot) {
          ensure(14 + 16); // heading + the first band under it
          currentShotLabel = [shot.code, shot.size ?? '', shot.move ?? '']
            .filter(Boolean)
            .join('  ·  ');
          shotHeadingRow(currentShotLabel);
        }
      }

      // take header band (shaded, full width)
      //
      // The identity runs free across the left and WRAPS rather than truncates
      // when it will not fit on one line. A three-camera take with sound is
      // already five names, and a camera that cut and rejoined adds one more
      // per file - the old single truncated line silently dropped the tail,
      // which on this page means a card nobody knows to look for. Breaks only
      // ever land between whole clip names (packLines).
      const labelWidth = C_TIME.x - (MARGIN + 4) - 6;
      // "Take 3  -  A C0193  ·  B C0097  ·  ..." - the dash still sets the take
      // number apart from the clip list, and the list still joins on the middot
      // it always did. Only the SEPARATORS between clips are break candidates,
      // so the take number can never be orphaned from its first clip.
      const clipParts = clipLabelParts(take, project).map(sanitize);
      const head = `Take ${take.number}`;
      const labelLines = packLines(
        clipParts.length ? [`${head}  -  ${clipParts[0]}`, ...clipParts.slice(1)] : [head],
        '  ·  ',
        bold,
        8.5,
        labelWidth,
      );
      const bandH = 16 + (labelLines.length - 1) * 10;
      ensure(bandH);
      const bandBottom = y - bandH;
      page.drawRectangle({ x: MARGIN, y: bandBottom, width: CONTENT_WIDTH, height: bandH, color: BAND });
      // The band is column-aligned with the moment rows below it, so a value
      // always sits under its own heading: roll length under TIME, and the
      // clock ONLY under WALL CLOCK. Those right-hand cells stay on the FIRST
      // line whatever the identity wraps to, so the columns still read down
      // the page. The shot is NOT repeated here - it is the sub-heading above
      // this group.
      const bandBase = baselineOf(bandBottom + (bandH - 16), 16, 8.5);
      labelLines.forEach((line, i) => {
        page.drawText(line, {
          x: MARGIN + 4,
          y: bandBase - i * 10,
          size: 8.5,
          font: bold,
          color: INK,
        });
      });
      cell(C_DATE, shortDateLabel(displayShootDay(take)), bandBase, { font: bold, size: 8.5 });
      cell(C_TIME, tc.msToClock(take.durationMs), bandBase, { font: bold, size: 8.5 });
      if (take.cameraTC) cell(C_CAMTC, take.cameraTC, bandBase, { font: bold, size: 8.5 });
      cell(C_WALL, wallClockTC(take.startedAt, fps), bandBase, { font: bold, size: 8.5 });
      y -= bandH;

      // optional take note (muted, spans the width)
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
    currentShotLabel = null;
    y -= 16;
  }

  // ---- discarded appendix (gray, strikethrough) --------------------------
  if (discardedTakes.length > 0) {
    heading('Discarded takes', 12, GRAY);
    y -= 2;
    rule();
    y -= 14;
    for (const take of discardedTakes) {
      const h = 13;
      ensure(h);
      const bottom = y - h;
      const base = baselineOf(bottom, h, 8);
      // Scene, then shot code ('' and so dropped by filter(Boolean) when the
      // take has no shot), then the take - the appendix is a flat line, so the
      // hierarchy has to read left to right.
      const parts = [
        'DISCARDED',
        slateName.get(take.slateId) ?? '',
        shotCodeOf(take, shotIndex),
        `Take ${take.number}`,
        shortDateLabel(displayShootDay(take)),
        clipLabel(take, project),
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
