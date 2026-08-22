#!/usr/bin/env node
// Walks the NEW PROJECT flow end to end and writes PNGs — and, more to the
// point, reads the project it created back OUT OF STORAGE and asserts on the
// object rather than on the screen.
//
// A screenshot of a stage that says "Camera D · Sam" proves the stage renders.
// It does not prove a fourth unit reached the record, that its letter is D, or
// that Sam survived the trim — and those are exactly the ways this can be
// wrong. So every walk ends with `store.listProjects()` read back from the
// same IndexedDB the app runs on, printed whole into notes.txt, and checked.
//
// Two walks, in both themes:
//
//   FOUR CAMERAS AND SOUND   named, 25 fps, a camera chosen off its filename,
//                            B/C/D added one tap at a time, C REMOVED and a
//                            fourth added back, four operators, a recorder.
//                            Then the project is opened and rolled, with a
//                            unit joining MID-TAKE.
//   ONE CAMERA, NO SOUND     the one-tap answers, all the way through. Proves
//                            `cameras` is ABSENT (not an array of one) and
//                            `sound` is absent too.
//
// Same CDP harness as scripts/shoot-onboarding.mjs and scripts/shoot-roll.mjs:
// no new dependency, Chromium borrowed out of Playwright's cache. It SPAWNS
// ITS OWN VITE on 5413, because 5200/5300/5320 are other checkouts of this
// repo and 5411 is the onboarding harness — shooting one of those would be
// shooting somebody else's branch.
//
// Exit code 1 if any assertion fails, so this is a check as well as a camera.
//
// Usage:
//   node scripts/shoot-newproject.mjs [outDir]
//   PORT=5417 node scripts/shoot-newproject.mjs

import { spawn } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync, existsSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const REPO_ROOT = fileURLToPath(new URL('..', import.meta.url));
const DEV_PORT = Number(process.env.PORT ?? 5413);
const CDP_PORT = Number(process.env.CDP_PORT ?? 9343);
const BASE_URL = `http://localhost:${DEV_PORT}/`;
const OUT_DIR = process.argv[2] ?? join(REPO_ROOT, '.shots-newproject');

// The same 390x844 phone the rest of this app is calibrated on.
const VIEWPORT = { width: 390, height: 844 };

function findChrome() {
  if (process.env.CHROME_BIN && existsSync(process.env.CHROME_BIN)) return process.env.CHROME_BIN;
  const base = join(process.env.HOME ?? '', 'Library/Caches/ms-playwright');
  if (existsSync(base)) {
    const dirs = readdirSync(base).filter((d) => d.startsWith('chromium-')).sort().reverse();
    for (const d of dirs) {
      for (const arch of ['chrome-mac-arm64', 'chrome-mac']) {
        const bin = join(base, d, arch, 'Google Chrome for Testing.app', 'Contents', 'MacOS', 'Google Chrome for Testing');
        if (existsSync(bin)) return bin;
      }
    }
  }
  const mac = '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
  if (existsSync(mac)) return mac;
  throw new Error('No Chromium/Chrome binary found. Set CHROME_BIN.');
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function waitForHttp(url, timeoutMs = 20000) {
  const start = Date.now();
  for (;;) {
    try {
      const res = await fetch(url);
      if (res.ok || res.status < 500) return;
    } catch { /* not up yet */ }
    if (Date.now() - start > timeoutMs) throw new Error(`Timed out waiting for ${url}`);
    await sleep(150);
  }
}

// ------------------------------------------------------------- CDP client ---

class CDP {
  constructor(ws) {
    this.ws = ws;
    this.nextId = 1;
    this.pending = new Map();
    this.listeners = new Map();
    ws.addEventListener('message', (ev) => this._onMessage(ev.data));
  }

  static async connectToNewPage(cdpPort) {
    const res = await fetch(`http://localhost:${cdpPort}/json/new?about:blank`, { method: 'PUT' });
    const target = await res.json();
    const ws = new WebSocket(target.webSocketDebuggerUrl);
    await new Promise((resolve, reject) => {
      ws.addEventListener('open', resolve, { once: true });
      ws.addEventListener('error', reject, { once: true });
    });
    return new CDP(ws);
  }

  _onMessage(raw) {
    const msg = JSON.parse(raw);
    if (msg.id !== undefined && this.pending.has(msg.id)) {
      const { resolve, reject } = this.pending.get(msg.id);
      this.pending.delete(msg.id);
      if (msg.error) reject(new Error(msg.error.message));
      else resolve(msg.result);
    } else if (msg.method) {
      const set = this.listeners.get(msg.method);
      if (set) for (const fn of set) fn(msg.params);
    }
  }

  send(method, params = {}) {
    const id = this.nextId++;
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      this.ws.send(JSON.stringify({ id, method, params }));
    });
  }

  once(method, predicate = () => true) {
    return new Promise((resolve) => {
      const set = this.listeners.get(method) ?? new Set();
      this.listeners.set(method, set);
      const fn = (params) => {
        if (!predicate(params)) return;
        set.delete(fn);
        resolve(params);
      };
      set.add(fn);
    });
  }

  async evaluate(expression) {
    const result = await this.send('Runtime.evaluate', {
      expression, awaitPromise: true, returnByValue: true, timeout: 20000,
    });
    if (result.exceptionDetails) {
      throw new Error(
        result.exceptionDetails.exception?.description ?? result.exceptionDetails.text ?? 'evaluate() threw',
      );
    }
    return result.result?.value;
  }

  async waitForExpr(exprBody, { timeout = 15000, interval = 100, desc = exprBody } = {}) {
    const start = Date.now();
    for (;;) {
      const ok = await this.evaluate(`(() => { try { return !!(${exprBody}); } catch (e) { return false; } })()`);
      if (ok) return;
      if (Date.now() - start > timeout) throw new Error(`Timeout waiting for: ${desc}`);
      await sleep(interval);
    }
  }

  async navigate(url) {
    await this.send('Page.navigate', { url });
    await this.once('Page.loadEventFired');
  }

  async setViewport(width, height) {
    await this.send('Emulation.setDeviceMetricsOverride', {
      width, height, deviceScaleFactor: 2, mobile: true, screenWidth: width, screenHeight: height,
    });
  }

  async shot(path) {
    const { data } = await this.send('Page.captureScreenshot', { format: 'png', captureBeyondViewport: false });
    writeFileSync(path, Buffer.from(data, 'base64'));
  }
}

// ------------------------------------------------------------------ drive ---

/** Click the footer button carrying this exact label. */
const CLICK_ACTION = (text) => `
  (() => {
    const want = ${JSON.stringify(text)};
    const hit = [...document.querySelectorAll('.sl-actions .btn')]
      .find((b) => (b.textContent || '').trim() === want && !b.disabled);
    if (!hit) return false;
    hit.click();
    return true;
  })()
`;

/** Click the first element matching `sel` whose text contains `text`. */
const CLICK_IN = (sel, text) => `
  (() => {
    const want = ${JSON.stringify(text)};
    const hit = [...document.querySelectorAll(${JSON.stringify(sel)})]
      .find((e) => (e.textContent || '').includes(want));
    if (!hit) return false;
    (hit.closest('button') || hit).click();
    return true;
  })()
`;

/** Type into a React-controlled field: the native setter, then an input event. */
const TYPE_INTO = (sel, text) => `
  (() => {
    const el = document.querySelector(${JSON.stringify(sel)});
    if (!el) return false;
    const set = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set;
    set.call(el, ${JSON.stringify(text)});
    el.dispatchEvent(new Event('input', { bubbles: true }));
    return true;
  })()
`;

/** The stage's rail position and its whole visible text, for notes.txt. */
const STAGE_NOTE = `
  (() => {
    const rail = document.querySelector('.sl-rail__step');
    const panel = document.querySelector('.sl-panel');
    return {
      rail: rail ? rail.textContent.trim() : null,
      text: panel ? (panel.innerText || '').replace(/\\s+/g, ' ').trim().slice(0, 180) : null,
    };
  })()
`;

/**
 * THE OBJECT, READ BACK OUT OF STORAGE.
 *
 * Straight through the app's own store module, which is the same IndexedDB the
 * running app writes to (and, on a browser where IndexedDB is refused, the
 * same localStorage fallback — either way this is the persisted record and not
 * component state). Returns the raw rows so notes.txt can carry them whole.
 */
const READ_PROJECTS = `
  (async () => {
    const { store } = await import('/src/store/index.ts');
    return await store.listProjects();
  })()
`;

/** A cold app on this theme: no projects, no first-open flow in the way. */
async function fresh(cdp, theme) {
  await cdp.navigate(BASE_URL);
  await cdp.evaluate(`
    (() => {
      localStorage.clear();
      localStorage.setItem('clapper.theme', ${JSON.stringify(theme)});
      // The first-open sheet would otherwise sit on top of the whole walk.
      localStorage.setItem('clapper.onboardingDone', '1');
      return true;
    })()
  `);
  await cdp.evaluate(`
    (async () => {
      const { store } = await import('/src/store/index.ts');
      for (const p of await store.listProjects()) await store.deleteProject(p.id);
      return true;
    })()
  `);
  await cdp.navigate(BASE_URL);
  await cdp.waitForExpr(`document.querySelector('.mnav')`, { desc: 'the app shell' });
  await sleep(200);
}

/** Projects tab -> New project -> the flow, standing on stage one. */
async function openFlow(cdp) {
  await cdp.waitForExpr(CLICK_IN('.mnav__tab', 'Projects'), { desc: 'the Projects tab' });
  await cdp.waitForExpr(`document.querySelector('.newproject--primary')`, { desc: 'the projects list' });
  await cdp.evaluate(`document.querySelector('.newproject--primary').click(); true`);
  await cdp.waitForExpr(`document.querySelector('.np')`, { desc: 'the New project flow' });
  await sleep(400); // the sheet's rise
}

// ---------------------------------------------------------------- checks ---

const failures = [];

function check(name, ok, detail) {
  if (!ok) failures.push(`${name}${detail ? `  ${detail}` : ''}`);
  return `${ok ? 'ok  ' : 'FAIL'}  ${name}${detail ? `  ${detail}` : ''}`;
}

function eq(name, actual, expected) {
  const a = JSON.stringify(actual);
  const e = JSON.stringify(expected);
  return check(name, a === e, `${a} (wanted ${e})`);
}

// ------------------------------------------------------------------ walks ---

const CREW = ['Rohan', 'Meera', 'Ali', 'Sam'];
// Deliberately not "1, 1, 1, 1": the starting clip number is a per-unit
// field now (the point of this change), so four distinct numbers are what
// proves each unit's own value reached the object, not a shared default.
const START_NUMS = ['101', '1', '44', '7'];

/** Four cameras, a recorder, and a unit taken back off along the way. */
async function walkFourPlusSound(cdp, theme, notes) {
  await fresh(cdp, theme);
  await openFlow(cdp);

  // ---- 1 NAME --------------------------------------------------------
  await cdp.evaluate(TYPE_INTO('#np-name', 'The Last Monsoon'));
  await sleep(120);
  await cdp.shot(join(OUT_DIR, `1-name.${theme}.png`));
  notes.push(`1-name.${theme}  ${JSON.stringify(await cdp.evaluate(STAGE_NOTE))}`);
  await cdp.waitForExpr(CLICK_ACTION('Continue'), { desc: 'name -> fps' });

  // ---- 2 FRAME RATE --------------------------------------------------
  await cdp.waitForExpr(`document.querySelector('.sl-grid')`, { desc: 'the frame rates' });
  await cdp.waitForExpr(CLICK_IN('.sl-opt', '25'), { desc: '25 fps' });
  await sleep(200);
  await cdp.shot(join(OUT_DIR, `2-fps.${theme}.png`));
  notes.push(`2-fps.${theme}  ${JSON.stringify(await cdp.evaluate(STAGE_NOTE))}`);
  await cdp.waitForExpr(CLICK_ACTION('Continue'), { desc: 'fps -> cameras' });

  // ---- 3 CAMERAS -----------------------------------------------------
  await cdp.waitForExpr(`document.querySelector('.np-units')`, { desc: 'the camera stage' });
  await sleep(250);
  await cdp.shot(join(OUT_DIR, `3-cameras-one.${theme}.png`));
  notes.push(
    `3-cameras-one.${theme}  units=${await cdp.evaluate(`document.querySelectorAll('.np-unit').length`)}  ` +
      `${JSON.stringify(await cdp.evaluate(STAGE_NOTE))}`,
  );

  // A's camera, chosen off the filename it writes.
  await cdp.evaluate(`document.querySelector('.np-pick').click(); true`);
  await cdp.waitForExpr(`document.querySelector('.sl-cams')`, { desc: 'the preset picker' });
  await sleep(250);
  await cdp.shot(join(OUT_DIR, `3-pick.${theme}.png`));
  notes.push(`3-pick.${theme}  ${JSON.stringify(await cdp.evaluate(STAGE_NOTE))}`);
  await cdp.waitForExpr(CLICK_IN('.sl-cam', 'A001_C001_*'), { desc: 'the RED card' });
  await cdp.waitForExpr(`document.querySelector('.np-units')`, { desc: 'back on the rig' });

  // B, C, D — one tap each.
  for (const letter of ['B', 'C', 'D']) {
    await cdp.waitForExpr(CLICK_IN('.np-add', `Add camera ${letter}`), { desc: `add ${letter}` });
    await sleep(150);
  }
  for (let i = 0; i < 4; i++) {
    await cdp.evaluate(TYPE_INTO(`#np-op-${'ABCD'[i]}`, CREW[i]));
    await cdp.evaluate(TYPE_INTO(`#np-start-${'ABCD'[i]}`, START_NUMS[i]));
  }
  await sleep(250);
  await cdp.shot(join(OUT_DIR, `3-cameras-four.${theme}.png`));
  const four = await cdp.evaluate(`document.querySelectorAll('.np-unit').length`);
  const previewA = await cdp.evaluate(`document.querySelector('.np-unit__eg')?.textContent || ''`);
  notes.push(`3-cameras-four.${theme}  previewA=${previewA}`);
  notes.push(
    check(
      `the starting clip number feeds the filename preview live (${theme})`,
      previewA.includes('C101'),
      previewA,
    ),
  );
  notes.push(`3-cameras-four.${theme}  units=${four}  addShown=${await cdp.evaluate(`!!document.querySelector('.np-add')`)}`);
  notes.push(check(`cap holds at four (${theme})`, four === 4, `units=${four}`));
  notes.push(
    check(
      `the add button is gone at four (${theme})`,
      (await cdp.evaluate(`!!document.querySelector('.np-add')`)) === false,
    ),
  );

  // A UNIT BEING REMOVED. C goes; what was D closes up into C.
  await cdp.waitForExpr(
    `(() => {
       const b = [...document.querySelectorAll('.np-unit__drop')]
         .find((x) => (x.getAttribute('aria-label') || '') === 'Remove camera C');
       if (!b) return false; b.click(); return true;
     })()`,
    { desc: 'remove camera C' },
  );
  await sleep(300);
  await cdp.shot(join(OUT_DIR, `3-cameras-removed.${theme}.png`));
  const three = await cdp.evaluate(`document.querySelectorAll('.np-unit').length`);
  const afterLetters = await cdp.evaluate(
    `[...document.querySelectorAll('.np-unit__letter')].map((e) => e.textContent.trim())`,
  );
  notes.push(`3-cameras-removed.${theme}  units=${three}  letters=${JSON.stringify(afterLetters)}`);
  notes.push(eq(`removing C closes the gap (${theme})`, afterLetters, ['A', 'B', 'C']));

  // Put a fourth back and re-state every operator, so the object under test is
  // exactly four named units whatever the removal shuffled.
  await cdp.waitForExpr(CLICK_IN('.np-add', 'Add camera D'), { desc: 're-add D' });
  await sleep(150);
  for (let i = 0; i < 4; i++) {
    await cdp.evaluate(TYPE_INTO(`#np-op-${'ABCD'[i]}`, CREW[i]));
    await cdp.evaluate(TYPE_INTO(`#np-start-${'ABCD'[i]}`, START_NUMS[i]));
  }
  await sleep(200);
  await cdp.waitForExpr(CLICK_ACTION('Continue'), { desc: 'cameras -> sound' });

  // ---- 4 SOUND -------------------------------------------------------
  await cdp.waitForExpr(`document.body.innerText.includes('No sound')`, { desc: 'the sound stage' });
  await sleep(250);
  await cdp.shot(join(OUT_DIR, `4-sound-off.${theme}.png`));
  notes.push(`4-sound-off.${theme}  ${JSON.stringify(await cdp.evaluate(STAGE_NOTE))}`);

  await cdp.waitForExpr(
    `(() => {
       const b = [...document.querySelectorAll('.sl-opt')].find((x) => x.querySelector('b') && x.querySelector('b').textContent.trim() === 'Sound');
       if (!b) return false; b.click(); return true;
     })()`,
    { desc: 'sound on' },
  );
  await cdp.waitForExpr(`document.querySelector('.np-unit--sound')`, { desc: 'the recorder card' });
  await cdp.evaluate(TYPE_INTO('#np-sound-op', 'Priya'));
  await cdp.evaluate(TYPE_INTO('#np-sound-rec', 'MixPre-6'));
  await cdp.evaluate(TYPE_INTO('#np-sound-prefix', 'ZOOM_'));
  await sleep(250);
  await cdp.shot(join(OUT_DIR, `4-sound-on.${theme}.png`));
  notes.push(`4-sound-on.${theme}  ${JSON.stringify(await cdp.evaluate(STAGE_NOTE))}`);
  await cdp.waitForExpr(CLICK_ACTION('Continue'), { desc: 'sound -> shot list' });

  // ---- 4a SHOT LIST ---------------------------------------------------
  // The stage the shot-division diagram calls out: a fifth stage now, not a
  // gate. Skipped here; shotlistFooters below (and the Home-driven walks)
  // cover the upload half through the same DocumentStage this stage mounts.
  await cdp.waitForExpr(`document.body.innerText.includes('Skip')`, { desc: 'the shot list stage' });
  await sleep(250);
  await cdp.shot(join(OUT_DIR, `4a-shotlist.${theme}.png`));
  notes.push(`4a-shotlist.${theme}  ${JSON.stringify(await cdp.evaluate(STAGE_NOTE))}`);
  await cdp.waitForExpr(CLICK_ACTION('Skip'), { desc: 'shot list -> ready' });

  // ---- 5 READY -------------------------------------------------------
  await cdp.waitForExpr(`document.querySelector('.sl-receipt')`, { desc: 'the receipt' });
  await sleep(300);
  await cdp.shot(join(OUT_DIR, `5-ready.${theme}.png`));
  notes.push(`5-ready.${theme}  ${JSON.stringify(await cdp.evaluate(STAGE_NOTE))}`);
  notes.push(
    check(
      `the receipt says the shot list was skipped (${theme})`,
      (await cdp.evaluate(`document.querySelector('.sl-receipt').textContent`)).includes('Skipped'),
    ),
  );

  await cdp.waitForExpr(CLICK_ACTION('Create project'), { desc: 'the one confirm' });
  await cdp.waitForExpr(`!document.querySelector('.np')`, { desc: 'the flow closing' });
  await sleep(600);
  await cdp.shot(join(OUT_DIR, `6-project.${theme}.png`));

  // ---- THE OBJECT ----------------------------------------------------
  const projects = await cdp.evaluate(READ_PROJECTS);
  notes.push(`OBJECT (${theme}, four + sound): ${JSON.stringify(projects)}`);
  notes.push(check(`exactly one project was created (${theme})`, projects.length === 1, `got ${projects.length}`));
  const p = projects[0] ?? {};
  notes.push(eq(`name persisted (${theme})`, p.name, 'The Last Monsoon'));
  notes.push(eq(`fps persisted (${theme})`, p.fps, 25));
  notes.push(check(`cameras.length === 4 (${theme})`, (p.cameras ?? []).length === 4, `got ${(p.cameras ?? []).length}`));
  const letters = (p.cameras ?? []).map((c) => c.letter);
  notes.push(eq(`letters are A B C D, in order (${theme})`, letters, ['A', 'B', 'C', 'D']));
  notes.push(
    check(`every letter is distinct (${theme})`, new Set(letters).size === letters.length, JSON.stringify(letters)),
  );
  notes.push(eq(`operators persisted (${theme})`, (p.cameras ?? []).map((c) => c.operator), CREW));
  notes.push(
    eq(
      `each unit's own typed starting clip number persisted (${theme})`,
      (p.cameras ?? []).map((c) => c.nextClipNumber),
      START_NUMS.map(Number),
    ),
  );
  notes.push(
    check(
      `unit A carries the RED pattern it was given (${theme})`,
      p.cameras?.[0]?.clipPrefix === 'A001_C' && p.cameras[0].clipSuffix === '_*' && p.cameras[0].clipExt === '.R3D',
      JSON.stringify(p.cameras?.[0]),
    ),
  );
  notes.push(
    check(
      `the top level still mirrors unit A (${theme})`,
      p.clipPrefix === p.cameras?.[0]?.clipPrefix && p.clipPadding === p.cameras?.[0]?.clipPadding,
      `${p.clipPrefix}/${p.clipPadding}`,
    ),
  );
  notes.push(check(`sound is PRESENT (${theme})`, !!p.sound, JSON.stringify(p.sound)));
  notes.push(eq(`the mixer persisted (${theme})`, p.sound?.operator, 'Priya'));
  notes.push(eq(`the recorder persisted (${theme})`, p.sound?.recorder, 'MixPre-6'));
  notes.push(eq(`the sound prefix persisted (${theme})`, p.sound?.filePrefix, 'ZOOM_'));
  notes.push(
    check(
      `sound is NOT a camera unit (${theme})`,
      !(p.cameras ?? []).some((c) => c.letter === 'S'),
      JSON.stringify(letters),
    ),
  );

  return p;
}

/** One camera, no sound: the one-tap answers all the way through. */
async function walkOneNoSound(cdp, theme, notes) {
  await fresh(cdp, theme);
  await openFlow(cdp);

  await cdp.evaluate(TYPE_INTO('#np-name', 'Doc Day'));
  await sleep(120);
  await cdp.waitForExpr(CLICK_ACTION('Continue'), { desc: 'name -> fps' });
  await cdp.waitForExpr(`document.querySelector('.sl-grid')`, { desc: 'the frame rates' });
  await cdp.waitForExpr(CLICK_ACTION('Continue'), { desc: 'fps -> cameras' });
  await cdp.waitForExpr(`document.querySelector('.np-units')`, { desc: 'the camera stage' });
  await cdp.evaluate(TYPE_INTO('#np-op-A', 'Kirtan'));
  await sleep(150);
  await cdp.waitForExpr(CLICK_ACTION('Continue'), { desc: 'cameras -> sound' });
  await cdp.waitForExpr(`document.body.innerText.includes('No sound')`, { desc: 'the sound stage' });
  // OFF IS ALREADY THE ANSWER. Nothing is tapped here on purpose.
  await cdp.waitForExpr(CLICK_ACTION('Continue'), { desc: 'sound -> shot list' });
  await cdp.waitForExpr(`document.body.innerText.includes('Skip')`, { desc: 'the shot list stage' });
  // SKIP IS ALSO ALREADY THE ANSWER. The stage that used to be the whole gate
  // is one tap of "nothing happened" now.
  await cdp.waitForExpr(CLICK_ACTION('Skip'), { desc: 'shot list -> ready' });
  await cdp.waitForExpr(`document.querySelector('.sl-receipt')`, { desc: 'the receipt' });
  await sleep(300);
  await cdp.shot(join(OUT_DIR, `7-ready-single.${theme}.png`));
  notes.push(`7-ready-single.${theme}  ${JSON.stringify(await cdp.evaluate(STAGE_NOTE))}`);
  await cdp.waitForExpr(CLICK_ACTION('Create project'), { desc: 'the one confirm' });
  await cdp.waitForExpr(`!document.querySelector('.np')`, { desc: 'the flow closing' });
  await sleep(500);

  const projects = await cdp.evaluate(READ_PROJECTS);
  notes.push(`OBJECT (${theme}, one, no sound): ${JSON.stringify(projects)}`);
  const p = projects[0] ?? {};
  notes.push(eq(`the single-cam name persisted (${theme})`, p.name, 'Doc Day'));
  notes.push(check(`NO cameras array on a single-cam project (${theme})`, p.cameras === undefined, JSON.stringify(p.cameras)));
  notes.push(check(`sound is ABSENT when it was never turned on (${theme})`, p.sound === undefined, JSON.stringify(p.sound)));
  notes.push(eq(`the default preset landed on the top level (${theme})`, p.clipPrefix, 'C'));
  notes.push(eq(`fps defaulted to 24 (${theme})`, p.fps, 24));
  notes.push(eq(`an untouched starting clip number still defaults to 1 (${theme})`, p.nextClipNumber, 1));
}

/**
 * The point of the whole exercise: the project the flow made, actually rolling.
 * Four camera pills plus the sound slot, and a unit joining MID-TAKE.
 */
async function rollIt(cdp, theme, project, notes) {
  await cdp.evaluate(`
    (async () => {
      const { store } = await import('/src/store/index.ts');
      await store.createSlate(${JSON.stringify(project.id)}, 'Scene 1');
      return true;
    })()
  `);
  await cdp.navigate(BASE_URL);
  await cdp.waitForExpr(CLICK_IN('.mnav__tab', 'Projects'), { desc: 'the Projects tab' });
  await cdp.waitForExpr(CLICK_IN('button, .card, .grow', 'The Last Monsoon'), { desc: 'the project row' });
  await cdp.waitForExpr(`document.body.textContent.includes('Scene 1')`, { desc: 'the project screen' });
  await cdp.waitForExpr(CLICK_IN('button, .card, .grow', 'Scene 1'), { desc: 'the scene row' });
  await cdp.waitForExpr(`document.querySelector('.roll') && document.querySelector('.bigbtn')`, { desc: 'the rolling screen' });
  await sleep(400);
  await cdp.shot(join(OUT_DIR, `8-roll-idle.${theme}.png`));

  const slots = await cdp.evaluate(`document.querySelectorAll('.camslot').length`);
  const badges = await cdp.evaluate(
    `[...document.querySelectorAll('.camslot__badge')].map((e) => e.textContent.trim() || 'SOUND')`,
  );
  const ops = await cdp.evaluate(`[...document.querySelectorAll('.camslot__operator')].map((e) => e.textContent.trim())`);
  notes.push(`8-roll-idle.${theme}  slots=${slots}  badges=${JSON.stringify(badges)}  operators=${JSON.stringify(ops)}`);
  notes.push(check(`the roll screen shows four cameras plus sound (${theme})`, slots === 5, `slots=${slots}`));
  notes.push(
    check(
      `every operator reached the slate (${theme})`,
      CREW.every((n) => ops.includes(n)) && ops.includes('Priya'),
      JSON.stringify(ops),
    ),
  );

  // Roll camera A alone, then bring B in MID-TAKE.
  await cdp.evaluate(`document.querySelector('.camslot--edit .camslot__main').click(); true`);
  await cdp.waitForExpr(`document.querySelector('.roll--live')`, { desc: 'live' });
  await sleep(600);
  const joined = await cdp.evaluate(`
    (() => {
      const j = [...document.querySelectorAll('.camslot--join')]
        .find((b) => (b.textContent || '').includes('B'));
      if (!j) return false;
      j.click();
      return true;
    })()
  `);
  await sleep(1400);
  await cdp.shot(join(OUT_DIR, `9-roll-joined.${theme}.png`));
  const rolling = await cdp.evaluate(`document.querySelectorAll('.camslot--rolling').length`);
  notes.push(`9-roll-joined.${theme}  joinedB=${joined}  rollingSlots=${rolling}`);
  notes.push(check(`a unit still joins mid-take (${theme})`, joined === true && rolling >= 2, `rolling=${rolling}`));

  // CUT, and the take is written with both units on it.
  const cut = await cdp.evaluate(`
    (() => { const b = document.querySelector('.bigbtn'); if (!b) return false; b.click(); return true; })()
  `);
  await sleep(900);
  await cdp.shot(join(OUT_DIR, `10-postcut.${theme}.png`));
  const take = await cdp.evaluate(`
    (async () => {
      const { store } = await import('/src/store/index.ts');
      const slates = await store.listSlates(${JSON.stringify(project.id)});
      const takes = await store.listTakes(slates[0].id);
      return takes.map((t) => ({ clipName: t.clipName, clips: t.clips, sound: t.sound }));
    })()
  `);
  notes.push(`10-postcut.${theme}  cut=${cut}  takes=${JSON.stringify(take)}`);
}

/**
 * THE OTHER TWO FOOTERS. The weighting fix is app-wide, so it is not proven by
 * the flow that motivated it: the shot-division flow used to split Back and
 * Continue 50/50, and its FIRST stage carries a lone Close that must still be
 * full width. Both are shot here rather than in a fourth harness.
 */
async function shotlistFooters(cdp, theme, notes) {
  await fresh(cdp, theme);
  await cdp.waitForExpr(CLICK_IN('.mnav__tab', 'Projects'), { desc: 'the Projects tab' });
  await cdp.waitForExpr(CLICK_IN('.newproject--ghost', 'Shotlist'), { desc: 'the shotlist button' });
  await cdp.waitForExpr(`document.querySelector('.sl-actions')`, { desc: 'the shotlist flow' });
  await sleep(450);
  await cdp.shot(join(OUT_DIR, `11-shotlist-stage1.${theme}.png`));
  const lone = await cdp.evaluate(`
    (() => {
      const bs = [...document.querySelectorAll('.sl-actions .btn')];
      return { n: bs.length, widths: bs.map((b) => Math.round(b.getBoundingClientRect().width)) };
    })()
  `);
  notes.push(`11-shotlist-stage1.${theme}  footer=${JSON.stringify(lone)}`);
  notes.push(
    check(`a lone backout is full width (${theme})`, lone.n === 1 && lone.widths[0] > 300, JSON.stringify(lone)),
  );

  // An example pack needs no account, and lands on stage two.
  await cdp.waitForExpr(CLICK_IN('.sp-example', 'Keep'), { desc: 'an example pack', timeout: 20000 });
  await cdp.waitForExpr(`document.body.innerText.includes('Looks right')`, { desc: 'what we read' });
  await sleep(350);
  const pair = await cdp.evaluate(`
    (() => {
      const bs = [...document.querySelectorAll('.sl-actions .btn')];
      return bs.map((b) => ({ t: b.textContent.trim(), w: Math.round(b.getBoundingClientRect().width) }));
    })()
  `);
  await cdp.shot(join(OUT_DIR, `12-shotlist-stage2.${theme}.png`));
  notes.push(`12-shotlist-stage2.${theme}  footer=${JSON.stringify(pair)}`);
  notes.push(
    check(
      `the shot-division footer is weighted, not 50/50 (${theme})`,
      pair.length === 2 && pair[1].w > pair[0].w * 1.5,
      JSON.stringify(pair),
    ),
  );
}

/** Home tab, hero tapped, the New roll picker sheet up. */
async function openHomePicker(cdp) {
  await cdp.waitForExpr(CLICK_IN('.mnav__tab', 'Home'), { desc: 'the Home tab' });
  await cdp.waitForExpr(`document.querySelector('.home-hero')`, { desc: 'the New roll hero' });
  await cdp.evaluate(`document.querySelector('.home-hero').click(); true`);
  await cdp.waitForExpr(`document.querySelector('.modepick')`, { desc: 'the mode picker' });
  await sleep(200);
}

/**
 * HOME'S DIRECTOR ROW, walked end to end. This is the wiring change itself:
 * Home's Director row now opens NewProjectSheet on its six-stage road
 * (flow="director"), not ShotlistSheet directly. Stage mechanics (four
 * cameras, sound, the starting clip number) are already proven by
 * walkFourPlusSound above (which walks the SAME six-stage road, entered from
 * the Projects tab instead), so this walk is deliberately thin: one camera,
 * no sound, shot list skipped. What it checks is what only THIS wiring can
 * get wrong: the rail says 6 stages, and completion lands where
 * ShotlistSheet's own onImported always has: the Projects tab, project open.
 */
async function walkHomeDirector(cdp, theme, notes) {
  await fresh(cdp, theme);
  await openHomePicker(cdp);
  await cdp.waitForExpr(CLICK_IN('.modepick', 'Director mode'), { desc: 'Director mode row' });
  await cdp.waitForExpr(`document.querySelector('.np')`, { desc: 'the staged sheet, director road' });
  await sleep(300);
  const rail = await cdp.evaluate(`document.querySelector('.sl-rail__step')?.textContent.trim()`);
  notes.push(`13-home-director.${theme}  rail=${rail}`);
  notes.push(check(`Home's Director row opens the six-stage road (${theme})`, rail === '1 of 6', rail));
  await cdp.shot(join(OUT_DIR, `13-home-director.${theme}.png`));

  await cdp.evaluate(TYPE_INTO('#np-name', 'Field Report'));
  await cdp.waitForExpr(CLICK_ACTION('Continue'), { desc: 'name -> fps' });
  await cdp.waitForExpr(`document.querySelector('.sl-grid')`, { desc: 'the frame rates' });
  await cdp.waitForExpr(CLICK_ACTION('Continue'), { desc: 'fps -> cameras' });
  await cdp.waitForExpr(`document.querySelector('.np-units')`, { desc: 'the camera stage' });
  await cdp.waitForExpr(CLICK_ACTION('Continue'), { desc: 'cameras -> sound' });
  await cdp.waitForExpr(`document.body.innerText.includes('No sound')`, { desc: 'the sound stage' });
  await cdp.waitForExpr(CLICK_ACTION('Continue'), { desc: 'sound -> shot list' });
  await cdp.waitForExpr(`document.body.innerText.includes('Skip')`, { desc: 'the shot list stage' });
  await cdp.waitForExpr(CLICK_ACTION('Skip'), { desc: 'shot list -> ready' });
  await cdp.waitForExpr(`document.querySelector('.sl-receipt')`, { desc: 'the receipt' });
  await cdp.waitForExpr(CLICK_ACTION('Create project'), { desc: 'the one confirm' });
  await cdp.waitForExpr(`!document.querySelector('.np')`, { desc: 'the flow closing' });
  await sleep(500);
  await cdp.shot(join(OUT_DIR, `14-home-director-landed.${theme}.png`));

  const onProjectScreen = await cdp.evaluate(`document.body.textContent.includes('Field Report')`);
  notes.push(`14-home-director-landed.${theme}  showsProject=${onProjectScreen}`);
  notes.push(check(`completing Director mode from Home lands on the project (${theme})`, onProjectScreen === true));

  const projects = await cdp.evaluate(READ_PROJECTS);
  const p = projects.find((x) => x.name === 'Field Report');
  notes.push(
    check(`Home's Director road created exactly the project it walked (${theme})`, !!p, JSON.stringify(projects)),
  );
  notes.push(check(`it carries no podcast mode marker (${theme})`, p?.mode === undefined, JSON.stringify(p?.mode)));
}

/**
 * HOME'S PODCAST ROW, walked end to end, twice per theme: once cold (no
 * prior podcast project on the phone, fps must FALL BACK to 24) and once with
 * a podcast project seeded at 25fps (fps must be INHERITED, which is the only
 * way to prove the lookup actually reads the phone rather than always landing
 * on the fallback and looking "correct" by coincidence). Also checks what is
 * unique to this road: no frame rate stage, no shot list stage, the starting
 * clip number field present on Cameras same as Director's, sound defaulting
 * ON, the name prefilled with a scratch name, and completion landing straight
 * on the rolling screen with mode: 'podcast' and a slate literally named
 * "Recording", no Projects tab detour.
 */
async function walkHomePodcast(cdp, theme, notes, seedFps) {
  await fresh(cdp, theme);
  if (seedFps) {
    await cdp.evaluate(`
      (async () => {
        const { store } = await import('/src/store/index.ts');
        await store.createProject({
          name: 'Old Session', fps: ${seedFps}, camera: 'custom', clipPrefix: 'C',
          clipSuffix: '', clipExt: '.MP4', nextClipNumber: 1, clipPadding: 4,
          tags: [], mode: 'podcast',
        });
        return true;
      })()
    `);
  }
  const tag = seedFps ? 'inherited' : 'fallback';

  await openHomePicker(cdp);
  await cdp.waitForExpr(CLICK_IN('.modepick', 'Podcast mode'), { desc: 'Podcast mode row' });
  await cdp.waitForExpr(`document.querySelector('.np')`, { desc: 'the staged sheet, podcast road' });
  await sleep(400); // the fps-inheritance effect's own store round trip

  const rail = await cdp.evaluate(`document.querySelector('.sl-rail__step')?.textContent.trim()`);
  const nameVal = await cdp.evaluate(`document.querySelector('#np-name')?.value`);
  notes.push(`15-home-podcast-name.${theme}.${tag}  rail=${rail}  name=${JSON.stringify(nameVal)}`);
  notes.push(check(`Home's Podcast row opens the four-stage road (${theme}, ${tag})`, rail === '1 of 4', rail));
  notes.push(
    check(`the name is prefilled with a scratch name (${theme}, ${tag})`, /^Podcast /.test(nameVal || ''), nameVal),
  );
  await cdp.shot(join(OUT_DIR, `15-home-podcast-name.${theme}.${tag}.png`));

  await cdp.waitForExpr(CLICK_ACTION('Continue'), { desc: 'name -> cameras (fps skipped)' });
  await cdp.waitForExpr(`document.querySelector('.np-units')`, { desc: 'the camera stage' });
  const hasStartField = await cdp.evaluate(`!!document.querySelector('#np-start-A')`);
  notes.push(check(`the starting clip number field is on the podcast road too (${theme}, ${tag})`, hasStartField));
  await cdp.evaluate(TYPE_INTO('#np-start-A', '5'));
  await cdp.waitForExpr(CLICK_ACTION('Continue'), { desc: 'cameras -> sound' });

  await cdp.waitForExpr(`document.body.innerText.includes('No sound')`, { desc: 'the sound stage' });
  const soundOnByDefault = await cdp.evaluate(`!!document.querySelector('.np-unit--sound')`);
  notes.push(check(`sound defaults ON for a podcast (${theme}, ${tag})`, soundOnByDefault));
  await cdp.shot(join(OUT_DIR, `16-home-podcast-sound.${theme}.${tag}.png`));
  await cdp.waitForExpr(CLICK_ACTION('Continue'), { desc: 'sound -> ready (shot list skipped)' });

  await cdp.waitForExpr(`document.querySelector('.sl-receipt')`, { desc: 'the receipt' });
  const receiptText = await cdp.evaluate(`document.querySelector('.sl-receipt').textContent`);
  notes.push(`17-home-podcast-ready.${theme}.${tag}  ${receiptText}`);
  notes.push(
    check(
      `the podcast receipt carries no Shot list row (${theme}, ${tag})`,
      !receiptText.includes('Shot list'),
      receiptText,
    ),
  );
  await cdp.shot(join(OUT_DIR, `17-home-podcast-ready.${theme}.${tag}.png`));

  await cdp.waitForExpr(CLICK_ACTION('Create project'), { desc: 'the one confirm' });
  await cdp.waitForExpr(`!document.querySelector('.np')`, { desc: 'the flow closing' });
  await sleep(700);
  await cdp.waitForExpr(`document.querySelector('.roll')`, { desc: 'landing straight on the rolling screen' });
  await cdp.shot(join(OUT_DIR, `18-home-podcast-rolling.${theme}.${tag}.png`));

  const projects = await cdp.evaluate(READ_PROJECTS);
  const podcastProjects = projects.filter((p) => p.mode === 'podcast' && p.name !== 'Old Session');
  notes.push(`OBJECT (${theme}, podcast, ${tag}): ${JSON.stringify(podcastProjects)}`);
  notes.push(
    check(
      `exactly one new podcast project was created (${theme}, ${tag})`,
      podcastProjects.length === 1,
      `got ${podcastProjects.length}`,
    ),
  );
  const p = podcastProjects[0];
  if (p) {
    notes.push(eq(`mode is podcast (${theme}, ${tag})`, p.mode, 'podcast'));
    notes.push(
      eq(
        `fps ${tag === 'inherited' ? 'inherited from the seeded project' : 'fell back to 24'} (${theme}, ${tag})`,
        p.fps,
        seedFps ?? 24,
      ),
    );
    notes.push(eq(`the starting clip number reached the object (${theme}, ${tag})`, p.nextClipNumber, 5));

    const slates = await cdp.evaluate(`
      (async () => {
        const { store } = await import('/src/store/index.ts');
        return await store.listSlates(${JSON.stringify(p.id)});
      })()
    `);
    notes.push(`home-podcast-slates.${theme}.${tag}  ${JSON.stringify(slates)}`);
    notes.push(
      check(
        `exactly one slate, named Recording (${theme}, ${tag})`,
        slates.length === 1 && slates[0].name === 'Recording',
        JSON.stringify(slates),
      ),
    );
  } else {
    notes.push(check(`slate check skipped: no podcast project came back (${theme}, ${tag})`, false));
  }
}

// ------------------------------------------------------------------- main ---

async function main() {
  mkdirSync(OUT_DIR, { recursive: true });

  // Our own dev server. 5200/5300/5320 are other checkouts; 5411 is onboarding.
  const vite = spawn('npx', ['vite', '--port', String(DEV_PORT), '--strictPort'], {
    cwd: REPO_ROOT, stdio: 'ignore',
  });
  const chromeBin = findChrome();
  const userDataDir = mkdtempSync(join(tmpdir(), 'clapper-newproject-'));
  let chrome = null;
  const notes = [];

  try {
    await waitForHttp(BASE_URL, 30000);
    chrome = spawn(chromeBin, [
      '--headless=new', '--disable-gpu', `--remote-debugging-port=${CDP_PORT}`,
      `--user-data-dir=${userDataDir}`, '--no-first-run', '--disable-extensions',
      ...(process.env.REDUCE ? ['--force-prefers-reduced-motion'] : []),
      'about:blank',
    ], { stdio: 'ignore' });
    await waitForHttp(`http://localhost:${CDP_PORT}/json/version`, 20000);

    const cdp = await CDP.connectToNewPage(CDP_PORT);
    await cdp.send('Page.enable');
    await cdp.send('Runtime.enable');
    await cdp.setViewport(VIEWPORT.width, VIEWPORT.height);

    for (const theme of ['light', 'night']) {
      notes.push(`\n===== ${theme} =====`);
      const project = await walkFourPlusSound(cdp, theme, notes);
      if (project?.id) await rollIt(cdp, theme, project, notes);
      else notes.push(check(`something to roll (${theme})`, false, 'no project came back'));
      await walkOneNoSound(cdp, theme, notes);
      await shotlistFooters(cdp, theme, notes);
      // THE WIRING CHANGE ITSELF: Home's two picker rows, each opening the
      // staged sheet on its own road.
      await walkHomeDirector(cdp, theme, notes);
      await walkHomePodcast(cdp, theme, notes, null); // cold phone: falls back to 24
      await walkHomePodcast(cdp, theme, notes, 25); // seeded: inherits 25
    }
  } finally {
    chrome?.kill();
    vite.kill();
  }

  notes.push('');
  notes.push(failures.length === 0 ? 'ALL CHECKS PASSED' : `FAILURES (${failures.length}):`);
  for (const f of failures) notes.push(`  !! ${f}`);
  const report = notes.join('\n');
  writeFileSync(join(OUT_DIR, 'notes.txt'), report + '\n');
  console.log(report);
  console.log(`\nPNGs in ${OUT_DIR}`);
  if (failures.length) process.exit(1);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
