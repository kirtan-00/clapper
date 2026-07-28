import { describe, it, expect } from 'vitest';
import { parseShotlist, repairLigatures, isLetterSpaced, shotlistToPack } from './shotlist';

// A shotlist PDF as pdf.js actually hands it to us: table rows flattened into
// one long line per page, ligatures split into their own items, and the column
// header repeated at the top of every page. Synthetic, but shaped exactly like
// the real thing — including the traps that broke earlier versions of this
// parser (a cross-reference in a NOTES cell, a row whose body runs off the end
// of the page, a shot with no size).
const PAGE_1 = [
  'SC 1 · EXT. ROOFTOP — DAWN',
  'Look: cold blue light, city waking up.',
  '# SIZE ANGLE / MOVE ACTION DIALOGUE / AUDIO NOTES',
  '1.1 XWS STATIC, low Empty rooftop, the city behind it. Wind, distant tra ffi c Establisher',
  '1.2 MWS Slow PUSH IN Two-shot: Meera sitting on the ledge, Dev standing. — Master. Sets geography',
  '1.3 CU STATIC, eyeline L MEERA turns to him, fl at. "Tum late ho." Reverse for 1.2',
  '1.4 OTS (over Dev) STATIC Meera holds her ground. "Hamesha."',
  '1.5 — Superimpose over 1.4 Title Card: THE LONG WAY HOME FADE OUT',
].join(' ');

const PAGE_2 = [
  'SC 2 · INT. STAIRWELL — CONTINUOUS',
  '# SIZE ANGLE / MOVE ACTION DIALOGUE / AUDIO NOTES',
  '2.1 MS HANDHELD, drifting Dev takes the stairs two at a time, de fl ecting her question.',
  '2.2 ECU STATIC Insert: his hand on the rail. — Cutaway for pace',
  '2.3 WS → XWS DRONE PULL BACK / rise Camera lifts up o ff the building. Score swells Closing image',
].join(' ');

const DOC = `${PAGE_1}\n${PAGE_2}`;

describe('repairLigatures', () => {
  it('rejoins a ligature split out of the middle of a word', () => {
    expect(repairLigatures('Wind, distant tra ffi c stops')).toContain('traffic');
    expect(repairLigatures('he was de fl ecting hard')).toContain('deflecting');
  });

  it('glues forward when punctuation shows the word starts at the ligature', () => {
    expect(repairLigatures('MEERA turns, fl at again')).toContain(', flat');
  });

  it('does not swallow the space before a following function word', () => {
    // "off the" must survive; an earlier version produced "offthe".
    expect(repairLigatures('lifts up o ff the building')).toContain('off the');
  });
});

describe('isLetterSpaced', () => {
  it('detects a letter-spaced title, whose word gaps are unrecoverable', () => {
    expect(isLetterSpaced("L E T ' S  M E E T")).toBe(true);
  });
  it('leaves an ordinary title alone', () => {
    expect(isLetterSpaced('THE LONG WAY HOME — SHOTLIST')).toBe(false);
  });
});

describe('parseShotlist', () => {
  it('finds every scene and every shot, contiguously numbered', () => {
    const doc = parseShotlist(DOC);
    expect(doc).not.toBeNull();
    expect(doc!.scenes.map((s) => s.shots.length)).toEqual([5, 3]);
    expect(doc!.scenes[0].name).toBe('SC 1 · EXT. ROOFTOP — DAWN');
    expect(doc!.scenes[0].shots.map((s) => s.code)).toEqual(['1.1', '1.2', '1.3', '1.4', '1.5']);
  });

  it('reads the size and move cells off the table', () => {
    const shots = parseShotlist(DOC)!.scenes[0].shots;
    expect(shots[0]).toMatchObject({ size: 'XWS', move: 'STATIC, low' });
    expect(shots[1]).toMatchObject({ size: 'MWS', move: 'Slow PUSH IN' });
    expect(shots[3].size).toBe('OTS (over Dev)');
    // An em-dash size cell means "no size" (a title card), not a literal dash.
    expect(shots[4].size).toBeUndefined();
  });

  it('pulls the spoken line out of the dialogue column', () => {
    const shots = parseShotlist(DOC)!.scenes[0].shots;
    expect(shots[2].dialogue).toBe('Tum late ho.');
    expect(shots[2].action).toContain('MEERA turns');
    // The action must not swallow the dialogue that follows it.
    expect(shots[2].action).not.toContain('Tum late ho');
  });

  it('is not fooled by a cross-reference inside a NOTES cell', () => {
    // "Reverse for 1.2" and "Superimpose over 1.4" both look like row starts.
    const codes = parseShotlist(DOC)!.scenes[0].shots.map((s) => s.code);
    expect(codes).toHaveLength(5);
    expect(new Set(codes).size).toBe(5);
  });

  it('stops a row body at the next page\'s repeated column header', () => {
    // 1.5 is the last row on page 1; its body must not inherit page 2's header
    // or scene heading.
    const last = parseShotlist(DOC)!.scenes[0].shots[4];
    expect(last.action ?? '').not.toMatch(/SIZE|ANGLE|SC 2|INT\. STAIRWELL/);
  });

  it('takes the scene\'s Look note, trimmed to the look itself', () => {
    const doc = parseShotlist(DOC)!;
    // Scene 1 prints "Look: cold blue light, city waking up." under the slugline.
    expect(doc.scenes[0].look).toBe('cold blue light, city waking up');
    // Scene 2 prints none — do not invent one from the first shot's action.
    expect(doc.scenes[1].look).toBeUndefined();
  });

  it('repairs ligatures inside the parsed rows', () => {
    const json = JSON.stringify(parseShotlist(DOC));
    expect(json).not.toMatch(/tra ffi c|fl at|de fl ecting/);
    expect(json).toContain('traffic');
  });

  it('returns null for a prose screenplay — that is not a shotlist', () => {
    const screenplay =
      'INT. KITCHEN — DAY Meera pours coffee. She does not look up. ' +
      'DEV enters, stops in the doorway. He waits. She keeps pouring. ' +
      'EXT. STREET — LATER They walk apart, half a pace between them.';
    expect(parseShotlist(screenplay)).toBeNull();
  });

  it('returns null rather than importing a table it misread', () => {
    // Rows that do not number contiguously from 1 mean we read the wrong thing.
    const garbled = '7.3 CU STATIC something 9.1 MS STATIC other 2.8 WS STATIC more 4.4 CU STATIC last';
    expect(parseShotlist(garbled)).toBeNull();
  });
});

describe('shotlistToPack', () => {
  it('produces a pack the importer consumes, one scene per scene', () => {
    const pack = shotlistToPack(parseShotlist(DOC)!, 'The_Long_Way_Home.pdf');
    expect(pack.clapperScriptPack).toBe(1);
    expect(pack.scenes).toHaveLength(2);
    expect(pack.scenes[0].shots).toHaveLength(5);
    expect(pack.scenes[0].shots![0].code).toBe('1.1');
    expect(pack.scenes[0].order).toBe(1);
  });

  it('derives coverage chips from the sizes the scene actually uses', () => {
    const pack = shotlistToPack(parseShotlist(DOC)!, 'x.pdf');
    expect(pack.scenes[0].coverageTags).toEqual(['XWS', 'MWS', 'CU', 'OTS']);
    // No OTS anywhere in scene 2, so it must not be offered there.
    expect(pack.scenes[1].coverageTags).not.toContain('OTS');
  });

  it('names the project from the filename when the title is unusable', () => {
    const pack = shotlistToPack(parseShotlist(DOC)!, 'The_Long_Way_Home.pdf');
    expect(pack.project.name).toBe('The Long Way Home');
  });
});
