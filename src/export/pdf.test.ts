// Smoke test for the DATE column added to the PDF's take bands / GOLD
// summary / discarded appendix. The column layout is exact-width-sum
// arithmetic (see the comments in pdf.ts) — this pins that it still renders
// without throwing for legacy takes (no shootDay), shootDay-stamped takes,
// GOLD moments and discarded takes all in the same document.
//
// Below that: the shot description, which has to appear exactly ONCE per shot,
// so those tests read the rendered page back rather than smoke-testing it.

import { describe, expect, it } from 'vitest';
import { packLines, shotHeadingBlock, shotHeadingHeight, toPdf } from './pdf';
import { PDFArray, PDFDocument, PDFRawStream, StandardFonts, decodePDFRawStream, type PDFFont } from 'pdf-lib';
import type { Moment, Project, ProjectBundle, Slate, Take } from '../types';

function project(): Project {
  return {
    id: 'p1',
    name: 'Bhoot',
    fps: 24,
    clipPrefix: 'C',
    nextClipNumber: 1,
    clipPadding: 4,
    clipExt: '.MP4',
    tags: [],
    createdAt: 0,
    updatedAt: 0,
  };
}

function slate(): Slate {
  return { id: 's1', projectId: 'p1', name: 'Scene 1', order: 0, createdAt: 0, updatedAt: 0 };
}

describe('pdf.ts — DATE column does not break layout', () => {
  it('renders a legacy take, a shootDay-stamped take, a GOLD moment and a discarded take without throwing', async () => {
    const takes: Take[] = [
      {
        id: 't1', slateId: 's1', projectId: 'p1', number: 1, clipName: 'C0001',
        status: 'good', startedAt: 0, durationMs: 5000, createdAt: 0, updatedAt: 0,
      },
      {
        id: 't2', slateId: 's1', projectId: 'p1', number: 2, clipName: 'C0002',
        shootDay: '2026-07-31', status: 'good', startedAt: 0, durationMs: 5000,
        createdAt: 0, updatedAt: 0,
      },
      {
        id: 't3', slateId: 's1', projectId: 'p1', number: 3, clipName: 'C0003',
        shootDay: '2026-08-01', status: 'discarded', startedAt: 0, durationMs: 5000,
        createdAt: 0, updatedAt: 0,
      },
    ];
    const moments: Moment[] = [
      { id: 'm1', takeId: 't2', kind: 'point', atMs: 500, label: 'the look', tag: 'GOLD', createdAt: 0, updatedAt: 0 },
    ];
    const bundle: ProjectBundle = { project: project(), slates: [slate()], takes, moments };
    const blob = await toPdf(bundle);
    expect(blob.size).toBeGreaterThan(0);
    expect(blob.type).toBe('application/pdf');
  });
});

describe('pdf.ts — the take band wraps its clip list instead of truncating it', () => {
  // A stand-in for a PDF font: every character is exactly 1 unit wide at size
  // 1, so the arithmetic below is readable rather than dependent on Helvetica's
  // real metrics. packLines only ever asks a font how wide a string is.
  const font = { widthOfTextAtSize: (s: string, size: number) => s.length * size } as PDFFont;

  it('breaks between clip names, never inside one', () => {
    const lines = packLines(['A C0191', 'B C0097', 'B C0098', 'C C0012'], ' | ', font, 1, 20);
    // Every original name survives somewhere, whole.
    for (const name of ['A C0191', 'B C0097', 'B C0098', 'C C0012']) {
      expect(lines.join(' ')).toContain(name);
    }
    // And no line got an ellipsis, which is what truncation would leave.
    expect(lines.some((l) => l.endsWith('...'))).toBe(false);
  });

  it('packs greedily, so a list that fits stays on one line', () => {
    expect(packLines(['A C0191', 'B C0097'], ' | ', font, 1, 100)).toEqual(['A C0191 | B C0097']);
  });

  it('still truncates a single name too wide for any line, rather than dropping it', () => {
    const [line] = packLines(['A_VERY_LONG_CLIP_NAME'], ' | ', font, 1, 10);
    expect(line).toHaveLength(10);
    expect(line.endsWith('...')).toBe(true);
  });

  it('renders a three-camera take where one camera rejoined, without throwing', async () => {
    const multi: Project = {
      ...project(),
      cameras: [
        { letter: 'A', clipPrefix: 'A001_C', nextClipNumber: 195, clipPadding: 4, clipExt: '.MP4' },
        { letter: 'B', clipPrefix: 'B', nextClipNumber: 99, clipPadding: 4, clipExt: '.MP4' },
        { letter: 'C', clipPrefix: 'C', nextClipNumber: 13, clipPadding: 4, clipExt: '.MP4' },
      ],
      sound: { filePrefix: 'SND_', nextFileNumber: 50, filePadding: 4, fileExt: '.WAV' },
    };
    const take: Take = {
      id: 't1', slateId: 's1', projectId: 'p1', number: 1, clipName: 'A001_C0191',
      clips: [
        { unit: 'A', clipName: 'A001_C0191', startOffsetMs: 0, durationMs: 10000 },
        { unit: 'B', clipName: 'B0097', startOffsetMs: 0, durationMs: 3000 },
        { unit: 'B', clipName: 'B0098', startOffsetMs: 5000, durationMs: 5000 },
        { unit: 'C', clipName: 'C0012', startOffsetMs: 0, durationMs: 10000 },
      ],
      sound: { fileName: 'SND_0049', startOffsetMs: 0, durationMs: 10000 },
      shootDay: '2026-08-01', status: 'good', startedAt: 0, durationMs: 10000, createdAt: 0, updatedAt: 0,
    };
    const blob = await toPdf({ project: multi, slates: [slate()], takes: [take], moments: [] });
    expect(blob.size).toBeGreaterThan(0);
  });
});

// ---------------------------------------------------------------------------
// The shot description, printed once per shot above that shot's takes.
//
// These assert against the RENDERED page, not just the helpers: pdf-lib writes
// every drawText as one hex string operand in the page's content stream, so
// loading the document back and decoding those operands gives exactly what
// landed on the paper, in draw order, one array per page. That is the only way
// "appears exactly once" can be checked rather than assumed. pdf-lib does the
// decompression itself (decodePDFRawStream) - no zlib, no new dependency.

/** Bytes to a string one char per byte. NOT TextDecoder: its 'latin1' is an
 *  alias for windows-1252, which rewrites 0x80-0x9F into other codepoints. */
const latin1 = (bytes: Uint8Array): string => {
  let out = '';
  for (const b of bytes) out += String.fromCharCode(b);
  return out;
};

/** "48656c6c6f" -> "Hello" - how pdf-lib writes a drawn string's operand. */
const unhex = (hex: string): string =>
  (hex.match(/../g) ?? []).map((h) => String.fromCharCode(parseInt(h, 16))).join('');

/** Text drawn on each page, in draw order. One array per page. */
function drawnTextByPage(doc: PDFDocument): string[][] {
  return doc.getPages().map((page) => {
    const contents = page.node.Contents();
    // A page's /Contents is an array of stream refs (pdf-lib appends a new one
    // per drawing pass, which is why the page numbers land in a second stream).
    const refs = contents instanceof PDFArray ? contents.asArray() : [contents];
    let content = '';
    for (const ref of refs) {
      const stream = ref && doc.context.lookup(ref);
      if (stream instanceof PDFRawStream) content += latin1(decodePDFRawStream(stream).decode());
    }
    return [...content.matchAll(/<([0-9A-Fa-f]+)>\s*Tj/g)].map(([, hex]) => unhex(hex));
  });
}

/** Everything drawn in a rendered bundle, page by page and then flattened. */
async function renderedPages(bundle: ProjectBundle): Promise<string[][]> {
  const bytes = new Uint8Array(await (await toPdf(bundle)).arrayBuffer());
  return drawnTextByPage(await PDFDocument.load(bytes));
}

const renderedText = async (bundle: ProjectBundle): Promise<string[]> =>
  (await renderedPages(bundle)).flat();
const countOf = (lines: string[], needle: string): number =>
  lines.filter((l) => l.includes(needle)).length;

/** A scene whose takes are scoped to one shot carrying `action` as its description. */
function slateWithShot(action?: string): Slate {
  return {
    ...slate(),
    shots: [{ id: 'sh1', code: '5.31', order: 1, size: 'MCU', move: 'Slow PUSH IN', action }],
  };
}

function shotTake(id: string, number: number, extra: Partial<Take> = {}): Take {
  return {
    id, slateId: 's1', projectId: 'p1', number, clipName: `C000${number}`, shotId: 'sh1',
    status: 'good', startedAt: 0, durationMs: 5000, createdAt: 0, updatedAt: 0, ...extra,
  };
}

describe('pdf.ts — the shot description prints once per shot', () => {
  const DESC = 'RUHI turns to the window and waits';

  it('prints it once above four takes of the same shot, not once per take', async () => {
    const takes = [1, 2, 3, 4].map((n) => shotTake(`t${n}`, n));
    const lines = await renderedText({
      project: project(), slates: [slateWithShot(DESC)], takes, moments: [],
    });
    expect(countOf(lines, DESC)).toBe(1);
    // All four takes really are in the document, so the single description is
    // grouping them rather than three of them having gone missing.
    for (const n of [1, 2, 3, 4]) expect(countOf(lines, `Take ${n}`)).toBeGreaterThan(0);
    // And it sits ABOVE them: the shot's code line comes first, then the
    // description, then the bands.
    expect(lines.indexOf('5.31  ·  MCU  ·  Slow PUSH IN')).toBeLessThan(
      lines.findIndex((l) => l.includes(DESC)),
    );
    expect(lines.findIndex((l) => l.includes(DESC))).toBeLessThan(
      lines.findIndex((l) => l.includes('Take 1')),
    );
  });

  it('prints it once when the same shot is covered across two shoot days', async () => {
    // The body groups scene -> shot -> take number and never by day, so a shot
    // picked up again on day two is ONE contiguous group; the DATE column is
    // what tells the two days apart. The description must not repeat per day.
    const takes = [
      shotTake('t1', 1, { shootDay: '2026-07-31' }),
      shotTake('t2', 2, { shootDay: '2026-07-31' }),
      shotTake('t3', 3, { shootDay: '2026-08-01' }),
      shotTake('t4', 4, { shootDay: '2026-08-01' }),
    ];
    const lines = await renderedText({
      project: project(), slates: [slateWithShot(DESC)], takes, moments: [],
    });
    expect(countOf(lines, DESC)).toBe(1);
    // Both days are still distinguishable on the page.
    expect(countOf(lines, '31 Jul')).toBeGreaterThan(0);
    expect(countOf(lines, '1 Aug')).toBeGreaterThan(0);
  });

  it('leaves no blank heading band when the shot carries no description', async () => {
    const takes = [shotTake('t1', 1), shotTake('t2', 2)];
    const without = { project: project(), slates: [slateWithShot(undefined)], takes, moments: [] };
    const lines = await renderedText(without);
    // The code line is still there; nothing empty follows it.
    expect(countOf(lines, '5.31')).toBeGreaterThan(0);
    expect(lines.some((l) => l.trim() === '')).toBe(false);
    // A whitespace-only description degrades to the same thing as none at all.
    const blank = { ...without, slates: [slateWithShot('   ')] };
    expect(await renderedText(blank)).toEqual(lines);
  });

  it('renders takes logged straight against a scene, with no shot at all', async () => {
    // Legacy project: no shots on the slate, no shotId on the takes. There is
    // no heading to print and nothing to describe, and it must not throw.
    const takes: Take[] = [
      { id: 't1', slateId: 's1', projectId: 'p1', number: 1, clipName: 'C0001', status: 'good', startedAt: 0, durationMs: 5000, createdAt: 0, updatedAt: 0 },
      { id: 't2', slateId: 's1', projectId: 'p1', number: 2, clipName: 'C0002', status: 'good', startedAt: 0, durationMs: 5000, createdAt: 0, updatedAt: 0 },
    ];
    const lines = await renderedText({ project: project(), slates: [slate()], takes, moments: [] });
    expect(countOf(lines, 'Take 1')).toBeGreaterThan(0);
    expect(countOf(lines, 'Take 2')).toBeGreaterThan(0);
    expect(countOf(lines, '5.31')).toBe(0);
  });

  it('mixes a no-shot take and a shot-scoped one in the same scene', async () => {
    // Half-migrated scene: the loose take sorts first and gets no heading, the
    // shot-scoped one below it gets exactly one.
    const takes: Take[] = [
      { id: 't0', slateId: 's1', projectId: 'p1', number: 1, clipName: 'C0000', status: 'good', startedAt: 0, durationMs: 5000, createdAt: 0, updatedAt: 0 },
      shotTake('t1', 1),
    ];
    const lines = await renderedText({
      project: project(), slates: [slateWithShot(DESC)], takes, moments: [],
    });
    expect(countOf(lines, DESC)).toBe(1);
    expect(countOf(lines, 'Take 1')).toBe(2); // the loose take and the shot's take
  });
});

describe('pdf.ts — a long shot description wraps instead of overflowing', () => {
  // Straight off pdf.ts: A4 width less both margins, less the 4pt text inset on
  // each side of the description. If that arithmetic changes there, this test
  // is meant to be updated in lockstep.
  const DESC_WIDTH = 595.28 - 54 * 2 - 8;
  const LONG =
    'RUHI walks the length of the empty rooftop while the city lights come up behind her, ' +
    'stops at the parapet, looks down at the traffic and then back over her shoulder at ANSH';

  async function helvetica(): Promise<PDFFont> {
    const doc = await PDFDocument.create();
    return doc.embedFont(StandardFonts.Helvetica);
  }

  it('breaks a long description across lines, none of them wider than the measure', async () => {
    const font = await helvetica();
    const block = shotHeadingBlock(
      { id: 'sh1', code: '5.31', order: 1, size: 'MCU', action: LONG },
      font,
    );
    expect(block.desc.length).toBeGreaterThan(1);
    for (const line of block.desc) {
      expect(font.widthOfTextAtSize(line, 8)).toBeLessThanOrEqual(DESC_WIDTH);
    }
    // Wrapped, not cut: no line was truncated away with an ellipsis, and the
    // last word of the description still survives on the page.
    expect(block.desc.some((l) => l.endsWith('...'))).toBe(false);
    expect(block.desc.join(' ')).toContain('ANSH');
  });

  it('measures taller for a wrapped description and exactly the bare line without one', async () => {
    const font = await helvetica();
    const bare = shotHeadingBlock({ id: 'sh1', code: '5.31', order: 1 }, font);
    const long = shotHeadingBlock({ id: 'sh1', code: '5.31', order: 1, action: LONG }, font);
    expect(shotHeadingHeight(bare)).toBe(14); // the code line alone, as it always was
    expect(shotHeadingHeight(long)).toBeGreaterThan(shotHeadingHeight(bare));
  });

  it('never strands a heading or a description at the foot of a page', () => {
    // A single fixture cannot prove this: whether a heading orphans depends on
    // exactly where the page break falls, so one layout just happens to miss
    // the window. This walks the whole tail of the document DOWN the page a
    // take band at a time (each loose take is a fixed 16pt) until every
    // announcement has occupied every offset a break could catch it at.
    //
    // Two shots, deliberately in different positions, because they are guarded
    // by DIFFERENT reservations: ALPHA is a shot change part way through a
    // scene (the reservation in the take loop), BRAVO is the first shot of a
    // scene and so rides the scene's own up-front reservation together with the
    // scene heading and the column header.
    // Take bands step 16pt and moment rows 14pt, so sweeping BOTH walks the
    // tail of the document past every even offset rather than only every 16th
    // one - a reservation that is short by a couple of points has a two-point
    // window to be caught in, and a band-only sweep steps straight over it.
    // 16a + 14b is 2(8a + 7b), and 7b covers every residue mod 8, so these two
    // ranges between them hit every even offset across a full page of content.
    const LEAD_IN = 44;
    const MOMENTS = 8;
    const alpha = `${LONG} ALPHA`;
    const bravo = `${LONG} BRAVO`;
    const shot = (id: string, code: string, action: string) => ({
      id, code, order: 1, size: 'MCU', action,
    });
    // Three cameras, so the band's identity WRAPS to a second line - that is
    // what makes the first-band height in each reservation load-bearing rather
    // than always the one-line minimum.
    const takeOn = (id: string, slateId: string, shotId: string, n: number): Take => ({
      id, slateId, projectId: 'p1', number: n, clipName: `A001_C019${n}`, shotId,
      clips: [
        { unit: 'A' as const, clipName: `A001_C019${n}`, startOffsetMs: 0, durationMs: 5000 },
        { unit: 'B' as const, clipName: `B001_C007${n}`, startOffsetMs: 0, durationMs: 5000 },
        { unit: 'C' as const, clipName: `C001_C003${n}`, startOffsetMs: 0, durationMs: 5000 },
      ],
      status: 'good', startedAt: 0, durationMs: 5000, createdAt: 0, updatedAt: 0,
    });

    const cases: { loose: number; marks: number }[] = [];
    for (let loose = 1; loose <= LEAD_IN; loose++) {
      for (let marks = 0; marks < MOMENTS; marks++) cases.push({ loose, marks });
    }

    return Promise.all(
      cases.map(async ({ loose, marks }) => {
        const takes: Take[] = Array.from({ length: loose }, (_, i) => ({
          id: `l${i}`, slateId: 's0', projectId: 'p1', number: i + 1, clipName: `L000${i}`,
          status: 'good', startedAt: 0, durationMs: 5000, createdAt: 0, updatedAt: 0,
        }));
        for (let n = 1; n <= 3; n++) takes.push(takeOn(`a${n}`, 's0', 'shA', n));
        for (let n = 1; n <= 3; n++) takes.push(takeOn(`b${n}`, 's1', 'shB', n));

        const pages = await renderedPages({
          project: project(),
          slates: [
            { ...slate(), id: 's0', name: 'Scene 0', order: 0, shots: [shot('shA', '5.31', alpha)] },
            { ...slate(), id: 's1', name: 'Scene 1', order: 1, shots: [shot('shB', '5.32', bravo)] },
          ],
          takes,
          // Hung on the FIRST loose take so they push everything after them
          // down the page, headings included.
          moments: Array.from({ length: marks }, (_, i) => ({
            id: `mk${i}`, takeId: 'l0', kind: 'point' as const, atMs: i * 100,
            label: `mark ${i}`, createdAt: 0, updatedAt: 0,
          })),
        });

        const at = `loose=${loose} marks=${marks}`;
        const lines = pages.flat();
        // Still exactly once each, wherever the breaks land.
        expect(countOf(lines, 'ALPHA'), at).toBe(1);
        expect(countOf(lines, 'BRAVO'), at).toBe(1);

        // Nothing that ANNOUNCES take bands may be the last thing on its page.
        for (const page of pages) {
          for (const announcer of ['ALPHA', 'BRAVO', 'Scene: Scene 1']) {
            let last = -1;
            page.forEach((l, i) => { if (l.includes(announcer)) last = i; });
            if (last < 0) continue;
            expect(
              page.slice(last).some((l) => l.startsWith('Take ')),
              `"${announcer}" stranded at the foot of a page, ${at}`,
            ).toBe(true);
          }
        }
      }),
    );
  });
});
