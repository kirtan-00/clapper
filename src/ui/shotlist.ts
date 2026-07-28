// Shotlist parsing — how a shotlist PDF becomes scenes and shots.
//
// A SHOTLIST is already a structured document: a table of numbered setups,
// "1.1 XWS STATIC, low <action> <dialogue> <notes>". Paying a language model to
// retype 137 such rows is where truncation and hallucination come from, so we
// don't. This module reads the table directly: free, instant, offline, exact,
// and it consumes none of the user's quota.
//
// The model never sees the document. Once this has the structure, `breakdown.ts`
// asks it for the one thing that isn't transcription: the tappable key moments
// inside each shot.

import type { ScriptPack, ScriptPackScene, ScriptPackShot } from './scriptpack';

// Function words that legitimately follow a word-final ligature ("off the",
// "if it"). Used to decide which side an orphaned ligature belongs to.
const FOLLOWERS = new Set([
  'the', 'a', 'an', 'to', 'of', 'and', 'in', 'on', 'at', 'it', 'is', 'as', 'by',
  'for', 'or', 'his', 'her', 'him', 'she', 'he', 'this', 'that', 'with', 'from',
  'up', 'out', 'into', 'over', 'was', 'are', 'be', 'not', 'so', 'no', 'if',
]);

/**
 * pdf.js emits each ligature as its own text item, so joining items with a
 * space splits words: "traffic" -> "tra ffi c", "flat" -> "fl at",
 * "deflecting" -> "de fl ecting", "off the" -> "o ff the".
 *
 * A bare "ff"/"fi"/"fl" is never an English word, so it always glues to
 * something — the only question is which side. Two signals settle it:
 * punctuation before the ligature means the word STARTS there (so glue
 * forward), and a common function word after it means the word ENDED there
 * (so glue backward only). Everything else is mid-word and glues both ways.
 */
export function repairLigatures(text: string): string {
  return text.replace(
    /(\S+)\s(ffi|ffl|ff|fi|fl)\s(\S+)/g,
    (whole, prev: string, lig: string, next: string) => {
      const startsWord = /[.,;:!?"“”)\]]$/.test(prev);
      const nextWord = next.replace(/[^A-Za-z].*$/, '').toLowerCase();
      if (startsWord) return `${prev} ${lig}${next}`;
      if (FOLLOWERS.has(nextWord)) return `${prev}${lig} ${next}`;
      return `${prev}${lig}${next}`;
    },
  );
}

/**
 * A letter-spaced heading (CSS `letter-spacing` on a title) reaches us as one
 * item per character — "L E T ' S  M E E T" — and the word gaps are already
 * lost by the time we see it, so it cannot be reconstructed. Detect it so the
 * caller can fall back to the filename instead of naming the project with
 * mangled text.
 */
export function isLetterSpaced(text: string): boolean {
  const tokens = text.trim().split(/\s+/);
  if (tokens.length < 6) return false;
  const singles = tokens.filter((t) => t.length === 1).length;
  return singles / tokens.length > 0.6;
}

const SIZES = ['XWS', 'MWS', 'ECU', 'MCU', 'OTS', 'POV', 'WS', 'MS', 'CU'];
const SIZE_ALT = SIZES.join('|');
// A size cell: a size, optionally with a parenthetical ("OTS (over Ansh)") or a
// transition to another size ("WS->XWS"), or an em dash for shots with no size
// (title cards, superimpositions).
const SIZE_CELL = `(?:(?:${SIZE_ALT})(?:\\s*\\(over[^)]{0,24}\\))?(?:\\s*(?:—|->|→)\\s*(?:${SIZE_ALT}))?|—)`;

/** Capitalised words that legitimately open a MOVE cell rather than the action. */
const MOVE_LEAD = new Set([
  'Slow', 'Slight', 'Low', 'High', 'Wide', 'Superimpose', 'Match', 'Static',
  'Handheld', 'Track', 'Push', 'Pull', 'Crane', 'Drone', 'Tilt', 'Pan', 'Quick',
]);

/**
 * The upper-case vocabulary of a MOVE cell. This list is what stops the move
 * from eating into the action: an ACTION cell routinely opens with a character
 * name in caps ("RUHI turns to him"), which is indistinguishable from a move
 * keyword by shape alone. Anything upper-case and NOT in here ends the move.
 */
const MOVE_VOCAB = new Set([
  'STATIC', 'PAN', 'TILT', 'PUSH', 'PULL', 'TRACK', 'HANDHELD', 'CRANE',
  'DRONE', 'SLO-MO', 'SLOW', 'MOTION', 'MATCH', 'CUT', 'IN', 'OUT', 'UP',
  'DOWN', 'BACK', 'OVER', 'WITH', 'TO', 'ON', 'LOW', 'HIGH', 'WIDE', 'RISE',
]);
const MAX_MOVE_LEN = 30;

/**
 * Split a row body into its MOVE cell and everything after it. The move is
 * short and made of upper-case keywords plus lower-case modifiers ("STATIC,
 * eyeline L", "HANDHELD, drifting", "Slow PUSH IN"); the action starts at the
 * first ordinary capitalised word. Falls back to "no move, all action" rather
 * than guessing, so a shotlist we read badly still shows readable text.
 */
function splitMove(body: string): { move?: string; rest: string } {
  const tokens = body.split(/\s+/);
  const move: string[] = [];
  let i = 0;
  for (; i < tokens.length; i++) {
    const t = tokens[i];
    const bare = t.replace(/^[(]+|[.,/)]+$/g, '');
    // An ordinary Capitalised word starts the action ("Empty rooftop…").
    if (/^[A-Z][a-z]/.test(bare) && !MOVE_LEAD.has(bare)) break;
    // So does an UPPER-CASE word that isn't move vocabulary — that's a
    // character name opening the action ("MEERA turns to him"). Single letters
    // are eyeline marks ("eyeline L") and stay in the move.
    if (bare.length > 1 && /^[A-Z][A-Z-]+$/.test(bare) && !MOVE_VOCAB.has(bare)) break;
    if (move.join(' ').length + t.length + 1 > MAX_MOVE_LEN) break;
    move.push(t);
  }
  const rest = tokens.slice(i).join(' ').trim();
  if (!move.length || !rest) return { rest: body.trim() };
  return { move: move.join(' ').replace(/[,/]+$/, '').trim(), rest };
}

/** First quoted span in a row body — the DIALOGUE cell, when there is one. */
function extractDialogue(text: string): string | undefined {
  const m = text.match(/["“]([^"”]{2,200})["”]/);
  return m ? m[1].trim() : undefined;
}

/**
 * Everything that appears between the last row of one page and the first row of
 * the next: the repeated column header, an episode/act title, a new slugline,
 * or a "Look:" art direction note. A row body must stop at the first of these.
 */
const PAGE_FURNITURE = /(#\s+SIZE\b|\bEPISODE\s+\d|\bACT\s+[IVX\d]|\bSC\s*\d{1,3}\s*[·:.\-–—]\s*(?:INT|EXT)|\bLook:)/;

/**
 * A "Look:" note often runs on into blocking ("...empty city. Ruhi on the car
 * hood, Ansh leaning against..."). The first sentence is the look; the rest is
 * staging the operator can read off the shot rows. Keep the first sentence when
 * the note is long, the whole thing when it is already short.
 */
function firstSentence(text: string): string {
  const stop = text.search(/[.;](?:\s|$)/);
  const head = text.length > 90 && stop > 20 ? text.slice(0, stop) : text.slice(0, 140);
  // Always drop the trailing stop so a short note and a trimmed one look the
  // same on the card.
  return head.trim().replace(/[.;,]+$/, '');
}

function trimAtPageFurniture(body: string): string {
  const m = body.match(PAGE_FURNITURE);
  return m && m.index !== undefined ? body.slice(0, m.index) : body;
}

export interface ParsedShot {
  code: string;
  scene: number;
  index: number;
  size?: string;
  move?: string;
  action?: string;
  dialogue?: string;
}

export interface ParsedScene {
  number: number;
  name: string;
  /** The shotlist's own "Look:" note — the scene's mood/lighting in one line. */
  look?: string;
  shots: ParsedShot[];
}

export interface ParsedShotlist {
  title?: string;
  scenes: ParsedScene[];
}

/**
 * Read a shotlist out of extracted PDF text. Returns `null` when the document
 * does not look like a shotlist (too few rows, or no consistent numbering), so
 * the caller can say so plainly rather than import a breakdown we misread.
 */
export function parseShotlist(raw: string): ParsedShotlist | null {
  const text = repairLigatures(raw);

  // Scene headings: "SC 1 · EXT. GIFT CITY — LATE NIGHT". Tolerate the various
  // separators productions use between the number and the slugline.
  const headings: { no: number; name: string; look?: string }[] = [];
  const sceneRe = /\bSC\s*(\d{1,3})\s*[·:.\-–—]?\s*((?:INT|EXT)[^\n]{0,90}?)(?=\s+Look:|\s+#\s+SIZE|\s+\(|\s{2}|$)/g;
  let m: RegExpExecArray | null;
  while ((m = sceneRe.exec(text))) {
    const no = Number(m[1]);
    if (headings.some((h) => h.no === no)) continue;
    // A shotlist usually prints a "Look:" note under the slugline — the scene's
    // mood and lighting in one line. That is a far better recogniser for the
    // operator than the first shot's action, so take it when it is there.
    const after = text.slice(m.index + m[0].length, m.index + m[0].length + 400);
    const look = after.match(/^\s*(?:\(|Look:)\s*([^\n]{4,320}?)\s*(?:\)|(?=\s+#\s+SIZE)|(?=\s+\d{1,3}\.\d))/);
    headings.push({
      no,
      name: `SC ${no} · ${m[2].trim().replace(/\s+/g, ' ')}`,
      look: look ? firstSentence(look[1].trim().replace(/\s+/g, ' ')) : undefined,
    });
  }

  // Shot rows, anchored on "<scene>.<shot> <SIZE>" at a row boundary.
  const rowRe = new RegExp(`(?:^|\\s)(\\d{1,3})\\.(\\d{1,3})\\s+(${SIZE_CELL})\\s+`, 'g');
  const hits: { scene: number; index: number; size: string; bodyFrom: number; tokenAt: number }[] = [];
  while ((m = rowRe.exec(text))) {
    hits.push({
      scene: Number(m[1]),
      index: Number(m[2]),
      size: m[3].trim(),
      bodyFrom: m.index + m[0].length,
      tokenAt: m.index,
    });
  }
  if (hits.length < 4) return null;

  // A row's body runs until the next row begins. Cross-references inside a
  // NOTES cell ("Reverse for 1.3", "Superimpose over 1.20") look like row
  // starts, so drop any hit that repeats or goes backwards within a scene.
  const scenes = new Map<number, ParsedScene>();
  const seen = new Set<string>();
  let lastScene = -1;
  let lastIndex = 0;
  hits.forEach((h, i) => {
    const code = `${h.scene}.${h.index}`;
    if (seen.has(code)) return;
    if (h.scene === lastScene && h.index <= lastIndex) return;
    seen.add(code);
    lastScene = h.scene;
    lastIndex = h.index;

    const end = i + 1 < hits.length ? hits[i + 1].tokenAt : text.length;
    // The last row on a page runs into whatever the next page starts with —
    // the repeated column header, the next EPISODE title, the next slugline.
    // Cut the body at the first of those so a shot doesn't inherit the header
    // row's text or the next episode's name as its dialogue.
    const body = trimAtPageFurniture(text.slice(h.bodyFrom, end)).trim().replace(/\s+/g, ' ');
    const { move, rest } = splitMove(body);
    const dialogue = extractDialogue(rest);
    // The action is the prose before the dialogue; the NOTES column trails it
    // with no delimiter we can trust, so keep the action tight rather than
    // swallowing the note.
    const action = (dialogue ? rest.split(/["“]/)[0] : rest).trim().slice(0, 160) || undefined;

    let scene = scenes.get(h.scene);
    if (!scene) {
      const heading = headings.find((x) => x.no === h.scene);
      scene = {
        number: h.scene,
        name: heading ? heading.name : `SC ${h.scene}`,
        look: heading?.look,
        shots: [],
      };
      scenes.set(h.scene, scene);
    }
    scene.shots.push({
      code,
      scene: h.scene,
      index: h.index,
      size: h.size === '—' ? undefined : h.size,
      move,
      action,
      dialogue,
    });
  });

  const ordered = [...scenes.values()].sort((a, b) => a.number - b.number);
  if (!ordered.length) return null;

  // Sanity: a real shotlist numbers its shots contiguously from 1. If most
  // scenes don't, we misread the table — hand it to the model instead of
  // importing a broken breakdown.
  const contiguous = ordered.filter((s) => {
    const idx = s.shots.map((x) => x.index);
    return idx[0] === 1 && idx.every((n, i) => n === i + 1);
  });
  if (contiguous.length < Math.ceil(ordered.length / 2)) return null;

  // The document title, when it's usable. A letter-spaced title arrives with
  // its word gaps already destroyed, so we reject it rather than name the
  // project something like "L E T ' SMEETDOBAARA" — the caller falls back to
  // the filename, which is always readable.
  const titleLine = text.slice(0, 400).match(/^\s*([^\n·]{4,80}?)\s*(?:—|--|\|)/);
  const title = titleLine && !isLetterSpaced(titleLine[1]) ? titleLine[1].trim() : undefined;
  return { title, scenes: ordered };
}

/**
 * Shot sizes spelled out. The shotlist prints "MCU" because paper is narrow,
 * but a chip you tap at 5am under a work light should say what it means —
 * "medium closeup" reads at a glance where "MCU" has to be decoded, and the
 * two are one keystroke apart from each other on a bad night. Longest prefixes
 * first so MWS/MCU never match as MS/CU.
 */
const SIZE_WORDS: [string, string][] = [
  ['XWS', 'extreme wide'],
  ['MWS', 'medium wide'],
  ['MCU', 'medium closeup'],
  ['ECU', 'extreme closeup'],
  ['OTS', 'over shoulder'],
  ['POV', 'point of view'],
  ['WS', 'wide'],
  ['MS', 'medium'],
  ['CU', 'closeup'],
];

/** Spell a printed size out, or return it unchanged if we don't know it. */
export function sizeInWords(size: string | undefined): string | undefined {
  if (!size) return undefined;
  const hit = SIZE_WORDS.find(([abbr]) => size.toUpperCase().startsWith(abbr));
  return hit ? hit[1] : size;
}

/**
 * Coverage chips for a scene, derived from the sizes its shots actually use —
 * so a scene with no over-shoulders is never offered one. Ordered widest to
 * tightest, which is the order a crew shoots them in.
 */
/* The coverage keypad is deliberately THREE keys, the same three on every scene
   of every project.

   Deriving them from the shotlist's own sizes looked clever and shot itself in
   the foot: a scene using nine sizes produced a nine-key pad that pushed the
   rest of the deck down, and the keys moved scene to scene so there was no
   muscle memory to build. Worse, the distinctions are ones nobody makes at
   speed — mid-take, at arm's length, "extreme closeup" versus "medium closeup"
   is a decision, and a decision is the one thing an operator does not have time
   for. Wide, mid, closeup is the split people actually call out loud.

   The precise framing is not lost: it is printed on the shot itself, spelled
   out, on the shot strip and the shot list. This pad is for tapping, not for
   describing. Everything specific to the scene arrives as key-moment chips
   underneath, which is where per-shot detail belongs. */
const COVERAGE_KEYS: string[] = ['WIDE', 'MID', 'CLOSEUP'];

/** Turn a parsed shotlist into the pack shape the importer consumes. */
export function shotlistToPack(doc: ParsedShotlist, docName: string): ScriptPack {
  const scenes: ScriptPackScene[] = doc.scenes.map((scene, i) => {
    const shots: ScriptPackShot[] = scene.shots.map((s, j) => ({
      code: s.code,
      order: j + 1,
      size: s.size,
      move: s.move,
      action: s.action,
      dialogue: s.dialogue,
    }));
    return {
      scriptRef: `S${scene.number}`,
      name: scene.name,
      // The scene's own one-liner: what happens across its shots.
      // The shot count is already on the card, so don't repeat it here.
      summary: (scene.look ?? '').slice(0, 140),
      order: i + 1,
      coverageTags: COVERAGE_KEYS,
      keyMomentTags: [],
      shots,
    };
  });

  const fromFile = docName.replace(/\.pdf$/i, '').replace(/[_-]+/g, ' ').trim();
  const name = doc.title || fromFile || 'Imported shotlist';
  return {
    clapperScriptPack: 1,
    project: { name, coverageTags: COVERAGE_KEYS },
    scenes,
  };
}
