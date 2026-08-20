#!/usr/bin/env node
// Renders the rolling screen and writes PNGs, so nobody has to build it blind.
//
// The house rule on this app is: view the reference, render the output, look at
// the image. This is the "render the output" half. It drives the SAME CDP
// harness scripts/measure-roll.mjs already uses (no new dependency, Chromium
// borrowed out of Playwright's cache) and shoots the five states that actually
// exercise the rolling screen, in both themes:
//
//   idle            nothing rolling, the camera report
//   rolling         single camera, no sound
//   multi           three cameras + sound, one camera rolling, others JOINable
//   tagedit         long-press on a tag key, the vocabulary editor in the deck
//   falsestart      CUT inside 2000ms, the discard sheet
//
// It also measures .bigbtn's box, because that geometry is thumb-calibrated
// (x16 y714 358x104 at 390x844) and a skin change is not allowed to move it.
//
// Usage:
//   node scripts/shoot-roll.mjs [outDir]           # reuse dev server on :5200
//   PORT=5183 node scripts/shoot-roll.mjs          # or point it elsewhere
//
// The dev server is NOT spawned: this repo normally has one running already on
// 5200, and a second Vite on the same source is just a slower way to get the
// same bytes. If nothing answers, start one first.

import { spawn } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync, existsSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const REPO_ROOT = fileURLToPath(new URL('..', import.meta.url));
const DEV_PORT = Number(process.env.PORT ?? 5200);
const CDP_PORT = Number(process.env.CDP_PORT ?? 9334);
const BASE_URL = `http://localhost:${DEV_PORT}/`;
// argv[2] is the out dir, but only if it is a PATH: `--assert` is a flag and
// naming a directory after it is how a run ends up writing into `./--assert`.
const ASSERT = process.argv.includes('--assert');
const OUT_DIR =
  process.argv.slice(2).find((a) => !a.startsWith('--')) ??
  join(REPO_ROOT, ASSERT ? '.shots/rollfix' : '.shots');

// A 390x844 phone is the calibration device for .bigbtn's box; every shot is
// taken there so the measured rect means something.
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
      expression, awaitPromise: true, returnByValue: true, timeout: 15000,
    });
    if (result.exceptionDetails) {
      throw new Error(
        result.exceptionDetails.exception?.description ?? result.exceptionDetails.text ?? 'evaluate() threw',
      );
    }
    return result.result?.value;
  }

  async waitForExpr(exprBody, { timeout = 12000, interval = 100, desc = exprBody } = {}) {
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

  /** A REAL press. dispatchEvent('pointerdown') does not start a roll and does
   *  not begin a tag long-press; Chromium synthesises the pointer stream from
   *  Input.dispatchMouseEvent, which does. */
  async mouseDown(x, y) {
    await this.send('Input.dispatchMouseEvent', {
      type: 'mousePressed', x, y, button: 'left', clickCount: 1, buttons: 1, pointerType: 'mouse',
    });
  }
  async mouseUp(x, y) {
    await this.send('Input.dispatchMouseEvent', {
      type: 'mouseReleased', x, y, button: 'left', clickCount: 1, buttons: 0, pointerType: 'mouse',
    });
  }
  async centreOf(selector) {
    return this.evaluate(`
      (() => {
        const el = document.querySelector(${JSON.stringify(selector)});
        if (!el) return null;
        const r = el.getBoundingClientRect();
        return { x: Math.round(r.left + r.width / 2), y: Math.round(r.top + r.height / 2) };
      })()
    `);
  }

  async shot(path) {
    const { data } = await this.send('Page.captureScreenshot', { format: 'png', captureBeyondViewport: false });
    writeFileSync(path, Buffer.from(data, 'base64'));
  }
}

// ------------------------------------------------------------------ seed ----

const SCRIPT_TAGS = [
  { id: 't1', label: 'WIDE', tier: 'coverage', order: 0 },
  { id: 't2', label: 'CU', tier: 'coverage', order: 1 },
  { id: 't3', label: 'OTS', tier: 'coverage', order: 2 },
  { id: 't4', label: 'She turns to camera', tier: 'keyMoment', order: 0 },
  { id: 't5', label: 'Door slams shut', tier: 'keyMoment', order: 1 },
];

/** A shot breakdown, i.e. Script Mode's tallest case: the ShotDeck wheel only
 *  renders when the scene carries `shots`, and the wheel is the single biggest
 *  block on the screen (172px card + a 128px peek). The action line is
 *  deliberately far longer than fits, because "long content must never change
 *  the geometry of a control surface" is the thing being tested. */
const SCRIPT_SHOTS = [
  {
    id: 's1', code: 'S1−01', order: 0, size: 'MCU', move: 'Slow PUSH IN',
    action: 'She crosses the kitchen, stops at the window, and watches the street for a long beat before she finally turns back to the table and picks the letter up again.',
    dialogue: 'You were never going to tell me, were you.',
  },
  { id: 's2', code: 'S1−02', order: 1, size: 'OTS (over Dev)', move: 'STATIC, low', action: 'His reply, flat.' },
  { id: 's3', code: 'S1−03', order: 2, size: 'XWS', move: 'HANDHELD', action: 'The street, empty.' },
];

async function seed(cdp, { cameraCount, soundOn, scriptMode, shots }) {
  const cameras = cameraCount >= 2
    ? Array.from({ length: cameraCount }, (_, i) => ({
        letter: ['A', 'B', 'C', 'D'][i], clipPrefix: 'C', nextClipNumber: 1, clipPadding: 4, operator: undefined,
      }))
    : undefined;
  const sound = soundOn ? { filePrefix: 'SND_', nextFileNumber: 1, filePadding: 4 } : undefined;
  await cdp.evaluate(`
    (async () => {
      const { store } = await import('/src/store/index.ts');
      for (const p of await store.listProjects()) await store.deleteProject(p.id);
      const project = await store.createProject({
        name: 'Shoot Test', fps: 24, clipPrefix: 'C', nextClipNumber: 1, clipPadding: 4,
        tags: ['WIDE','MID','CU','OTS','INSERT','GOLD','PICKUP','NOISE'],
        ${cameras ? `cameras: ${JSON.stringify(cameras)},` : ''}
        ${sound ? `sound: ${JSON.stringify(sound)},` : ''}
      });
      const slate = await store.createSlate(project.id, 'Scene 1');
      ${scriptMode ? `await store.updateSlate(slate.id, { tags: ${JSON.stringify(SCRIPT_TAGS)} });` : ''}
      ${shots ? `await store.updateSlate(slate.id, { shots: ${JSON.stringify(SCRIPT_SHOTS)}, summary: 'Kitchen, night. She reads the letter and he does not look up from the table, which is the whole scene and also the reason it runs long enough to wrap.' });` : ''}
      return true;
    })()
  `);
}

/** Click the first row/card whose visible text contains `text`. The shell has
 *  been reskinned more than once (cards -> grouped `.grow` rows), so this
 *  matches on the words rather than on a class that keeps moving. */
const CLICK_BY_TEXT = (text) => `
  (() => {
    const want = ${JSON.stringify(text)};
    const els = [...document.querySelectorAll('button, [role="button"], .card, .grow')];
    const hit = els.find((e) => (e.textContent || '').includes(want));
    if (!hit) return false;
    (hit.closest('button') || hit).click();
    return true;
  })()
`;

async function openRoll(cdp, theme) {
  await cdp.navigate(BASE_URL);
  await cdp.evaluate(`document.documentElement.setAttribute('data-theme', ${JSON.stringify(theme)}); true`);
  await cdp.waitForExpr(`document.body.textContent.includes('Shoot Test')`, { desc: 'home listing the project' });
  await cdp.waitForExpr(CLICK_BY_TEXT('Shoot Test'), { desc: 'project row clickable' });
  await cdp.waitForExpr(`document.body.textContent.includes('Scene 1')`, { desc: 'project screen' });
  await cdp.waitForExpr(CLICK_BY_TEXT('Scene 1'), { desc: 'scene row clickable' });
  // A scene WITH a breakdown opens its shot list first (App.tsx routes
  // scene -> ShotsScreen -> rolling), so one more tap is needed to reach the
  // screen this script is about. Clicked by CLASS, never by text: shot codes
  // carry U+2212 MINUS SIGN and a hyphen typed here would match nothing.
  await cdp.waitForExpr(
    // Only TRUE once a card was really clicked: the shot list renders its
    // header ("Loading shots") before the rows exist, and a wait that returns
    // true for a click that never landed just moves the timeout one line down.
    `(!!document.querySelector('.roll') || (document.querySelector('.stack .card') ? (document.querySelector('.stack .card').click(), true) : false))`,
    { desc: 'rolling screen, or the shot list on the way to it' },
  );
  await cdp.waitForExpr(`document.querySelector('.roll') && document.querySelector('.bigbtn')`, { desc: 'rolling screen' });
  // The toggle is re-applied after the route change: theme lives on <html> and
  // survives, but a fresh navigate resets it, so state it once more and settle.
  await cdp.evaluate(`document.documentElement.setAttribute('data-theme', ${JSON.stringify(theme)}); true`);
  await sleep(250);
}

/** The measured box of the one control this whole screen is calibrated around. */
async function bigbtnBox(cdp) {
  return cdp.evaluate(`
    (() => {
      const el = document.querySelector('.bigbtn');
      if (!el) return null;
      const r = el.getBoundingClientRect();
      return { x: Math.round(r.left), y: Math.round(r.top), w: Math.round(r.width), h: Math.round(r.height) };
    })()
  `);
}

// -------------------------------------------------------------- assertions --
// `node scripts/shoot-roll.mjs --assert` — the geometry half of this harness.
//
// WHY IT EXISTS: screenshots have missed this class of bug on this screen
// twice. A page that scrolls by 40px under a thumb looks identical in a still;
// what tells you is a NUMBER — scrollHeight against clientHeight, and the same
// rect measured before and after a scroll that must do nothing. So this mode
// prints numbers and nothing else, at five phone heights, in both themes,
// idle and rolling, single-cam / multi-cam+sound / a Script Mode breakdown.
//
// The seven, from the brief:
//   1  documentElement.scrollHeight === clientHeight
//   2  body.scrollHeight === body.clientHeight
//   3  the roll root's scrollHeight === its clientHeight
//   4  CUT's box is identical before and after a 400px page scroll
//   5  the REC pill is still visible after that scroll
//   6  the take bar's height is the SAME at every viewport height
//   7  .bigbtn measures x16 y714 358x104 at 390x844
//
// One caveat stated rather than buried: desktop Chrome resolves svh, lvh and
// dvh IDENTICALLY, so no harness on a Mac can reproduce the "100vh is taller
// than the visible area" half of this bug. Assertions 1-3 are still the right
// tripwire — they catch any layout that genuinely overflows — but the unit
// choice has to be argued in the CSS, not proved here.

const HEIGHTS = [932, 844, 780, 740, 667];
const RIGS = [
  { key: 'single', cameraCount: 1, soundOn: false, scriptMode: false, shots: false },
  { key: 'multi', cameraCount: 3, soundOn: true, scriptMode: true, shots: false },
  { key: 'script', cameraCount: 1, soundOn: false, scriptMode: true, shots: true },
];

const MEASURE = `
  (() => {
    const doc = document.documentElement;
    const body = document.body;
    const q = (s) => document.querySelector(s);
    const box = (el) => {
      if (!el) return null;
      const r = el.getBoundingClientRect();
      return { x: Math.round(r.left), y: Math.round(r.top), w: Math.round(r.width), h: Math.round(r.height) };
    };
    const roll = q('.roll');
    const pill = q('.recpill');
    let pillSeen = false;
    if (pill) {
      const r = pill.getBoundingClientRect();
      const onGlass = r.width > 0 && r.height > 0 && r.top >= 0 && r.bottom <= window.innerHeight;
      // Not merely in the box - actually the topmost thing at its own centre,
      // so a pill scrolled under the ring or covered by the deck fails too.
      const hit = document.elementFromPoint(r.left + r.width / 2, r.top + r.height / 2);
      pillSeen = onGlass && !!hit && (pill === hit || pill.contains(hit));
    }
    return {
      innerH: window.innerHeight,
      scrollY: Math.round(window.scrollY),
      docScroll: doc.scrollHeight, docClient: doc.clientHeight,
      bodyScroll: body.scrollHeight, bodyClient: body.clientHeight,
      rollScroll: roll ? roll.scrollHeight : null,
      rollClient: roll ? roll.clientHeight : null,
      // Every inner scroller, named, because "the page moved" on a phone is
      // usually one of these three and not the page at all.
      innerScroll: ['.roll__body', '.roll__stage', '.roll__deck', '.roll__pads']
        .map((s) => { const e = q(s); return e ? s + ' ' + e.scrollHeight + '/' + e.clientHeight + ' top' + Math.round(e.scrollTop) : s + ' -'; })
        .join('  '),
      // The height budget, band by band. When a layout does not fit, the
      // question is never "does it overflow" (assertion 3 answers that) but
      // "by how much, and which band is spending it".
      zones: ['.roll__head', '.roll__line', '.roll__summary', '.scenestrip', '.roll__rail',
        '.roll__stage', '.shotdeck', '.roll__reach', '.camstack', '.roll__pads',
        '.roll__markrow', '.roll__deck > .bigbtn']
        .map((s) => { const e = q(s); return e ? s.replace('.roll__', '').replace('.roll__deck > ', '') + ':' + Math.round(e.getBoundingClientRect().height) : null; })
        .filter(Boolean).join(' '),
      cut: box(q('.roll__deck > .bigbtn') || q('.bigbtn')),
      pill: box(pill),
      pillSeen,
      takebar: box(q('.takebar')),
      shotdeck: box(q('.shotdeck')),
      live: !!q('.roll--live'),
    };
  })()
`;

/** Try, hard, to move the screen. The literal assertion is a 400px page
 *  scroll; the wheel gestures are the honest version of the same question,
 *  because on a phone the thumb lands on whatever is under it and an inner
 *  scroller moving the pill out of view is exactly the reported bug. */
async function tryToScroll(cdp, h) {
  await cdp.evaluate(`window.scrollTo(0, 400); true`);
  await sleep(80);
  const afterPage = await cdp.evaluate(MEASURE);
  for (const y of [Math.round(h * 0.16), Math.round(h * 0.5), Math.round(h * 0.8)]) {
    await cdp.send('Input.dispatchMouseEvent', {
      type: 'mouseWheel', x: 195, y, deltaX: 0, deltaY: 400, pointerType: 'mouse',
    });
    await sleep(90);
  }
  const afterWheel = await cdp.evaluate(MEASURE);
  return { afterPage, afterWheel };
}

const sameBox = (a, b) => !!a && !!b && a.x === b.x && a.y === b.y && a.w === b.w && a.h === b.h;
const fmt = (b) => (b ? `x${b.x} y${b.y} ${b.w}x${b.h}` : 'none');

async function assertMain(cdp) {
  mkdirSync(OUT_DIR, { recursive: true });
  const rows = [];
  const fails = [];
  const takebarByState = new Map();

  // `--only=night/script/667` narrows the sweep while iterating on the CSS.
  // The full run is 60 states and takes minutes; a single one takes seconds.
  const only = (process.argv.find((a) => a.startsWith('--only=')) ?? '').slice(7);
  const wanted = (parts) => !only || only.split('/').every((p) => parts.includes(p));

  for (const theme of ['day', 'night']) {
    for (const rig of RIGS) {
      for (const h of HEIGHTS) {
        if (!wanted([theme, rig.key, String(h)])) continue;
        await cdp.setViewport(VIEWPORT.width, h);
        await seed(cdp, rig);
        try {
          await openRoll(cdp, theme);
        } catch (err) {
          // A navigation that stalls is worth a page dump, not a bare stack:
          // this harness clicks through three screens and the useful question
          // is always "which one is it stuck on".
          const where = await cdp.evaluate(
            `location.href + ' :: ' + (document.body.textContent || '').slice(0, 400)`,
          );
          throw new Error(`${err.message}\n  at ${theme}/${rig.key}/${h}\n  page: ${where}`);
        }

        for (const mode of ['idle', 'rolling']) {
          if (mode === 'rolling') {
            const p = await cdp.centreOf('.bigbtn');
            await cdp.mouseDown(p.x, p.y);
            await cdp.mouseUp(p.x, p.y);
            await cdp.waitForExpr(`document.querySelector('.roll--live')`, { desc: `live ${theme}/${rig.key}/${h}` });
            await sleep(1200);
          }
          const before = await cdp.evaluate(MEASURE);
          const { afterPage, afterWheel } = await tryToScroll(cdp, h);
          await cdp.evaluate(`window.scrollTo(0, 0); true`);

          const id = `${theme}/${rig.key}/${mode}/${h}`;
          const a1 = before.docScroll === before.docClient;
          const a2 = before.bodyScroll === before.bodyClient;
          const a3 = before.rollScroll === before.rollClient;
          const a4 = sameBox(before.cut, afterPage.cut);
          const a4w = sameBox(before.cut, afterWheel.cut);
          const a5 = mode === 'rolling' ? afterPage.pillSeen : null;
          const a5w = mode === 'rolling' ? afterWheel.pillSeen : null;
          if (mode === 'rolling') {
            const k = `${theme}/${rig.key}`;
            if (!takebarByState.has(k)) takebarByState.set(k, []);
            takebarByState.get(k).push({ h, box: before.takebar });
          }
          const a7 = h === 844
            ? sameBox(before.cut, { x: 16, y: 714, w: 358, h: 104 })
            : null;

          const mark = (v) => (v === null ? ' -- ' : v ? ' ok ' : 'FAIL');
          rows.push(
            `${id.padEnd(26)} ` +
              `1:${mark(a1)} doc ${before.docScroll}/${before.docClient}  ` +
              `2:${mark(a2)} body ${before.bodyScroll}/${before.bodyClient}  ` +
              `3:${mark(a3)} roll ${before.rollScroll}/${before.rollClient}  ` +
              `4:${mark(a4)} cut ${fmt(before.cut)} -> ${fmt(afterPage.cut)}  ` +
              `4w:${mark(a4w)} -> ${fmt(afterWheel.cut)}  ` +
              `5:${mark(a5)} 5w:${mark(a5w)} pill ${fmt(before.pill)} -> ${fmt(afterWheel.pill)}  ` +
              `6: takebar ${fmt(before.takebar)}  ` +
              `7:${mark(a7)}  ` +
              `shotdeck ${fmt(before.shotdeck)}  scrollY ${afterPage.scrollY}\n` +
              `${' '.repeat(27)}inner  ${before.innerScroll}\n` +
              `${' '.repeat(27)}wheel  ${afterWheel.innerScroll}\n` +
              `${' '.repeat(27)}bands  ${before.zones}`,
          );
          for (const [n, v] of [['1', a1], ['2', a2], ['3', a3], ['4', a4], ['4w', a4w], ['5', a5], ['5w', a5w], ['7', a7]]) {
            if (v === false) fails.push(`${id} assertion ${n}`);
          }
          // A picture of every state that was measured, so the numbers and the
          // image are of the same frame - and so headless Chrome keeps
          // painting (see the drum note above).
          await cdp.shot(join(OUT_DIR, `assert.${theme}.${rig.key}.${mode}.${h}.png`));
        }
      }
    }
  }

  // 6 is a cross-viewport assertion: one number, five heights.
  const bar = [];
  for (const [k, list] of takebarByState) {
    const hs = list.map((e) => (e.box ? e.box.h : null));
    const same = hs.every((v) => v !== null && v === hs[0]);
    bar.push(`6: ${same ? ' ok ' : 'FAIL'} ${k}  takebar heights by viewport ${list.map((e) => `${e.h}:${e.box ? e.box.h : 'none'}`).join(' ')}`);
    if (!same) fails.push(`${k} assertion 6 (take bar height varies: ${hs.join(',')})`);
  }

  console.log(rows.join('\n'));
  console.log('\n' + bar.join('\n'));
  console.log(`\nPNGs in ${OUT_DIR}`);
  console.log(fails.length === 0 ? '\nALL SEVEN PASS, every state.' : `\n${fails.length} FAILURES:\n  ${fails.join('\n  ')}`);
  if (fails.length) process.exitCode = 1;
}

// ------------------------------------------------------------------ main ----

async function main() {
  mkdirSync(OUT_DIR, { recursive: true });
  await waitForHttp(BASE_URL, 8000).catch(() => {
    throw new Error(`Nothing answering on ${BASE_URL}. Start the dev server (npx vite --port ${DEV_PORT}) first.`);
  });

  const chromeBin = findChrome();
  const userDataDir = mkdtempSync(join(tmpdir(), 'clapper-shoot-'));
  // REDUCED MOTION is a BOOLEAN SWITCH. `--force-prefers-reduced-motion=false`
  // does not mean "off", it means the switch is present, and Chrome forces
  // reduce ON - which silently turns every transition in the app into an
  // instant jump and makes a working drum look like a number being swapped.
  // Set REDUCE=1 to shoot the still forms on purpose.
  const chrome = spawn(chromeBin, [
    '--headless=new', '--disable-gpu', `--remote-debugging-port=${CDP_PORT}`,
    `--user-data-dir=${userDataDir}`, '--no-first-run', '--disable-extensions',
    ...(process.env.REDUCE ? ['--force-prefers-reduced-motion'] : []),
    'about:blank',
  ], { stdio: 'ignore' });
  await waitForHttp(`http://localhost:${CDP_PORT}/json/version`, 15000);

  const notes = [];
  try {
    const cdp = await CDP.connectToNewPage(CDP_PORT);
    await cdp.send('Page.enable');
    await cdp.send('Runtime.enable');
    await cdp.setViewport(VIEWPORT.width, VIEWPORT.height);
    await cdp.navigate(BASE_URL);

    if (ASSERT) {
      await assertMain(cdp);
      return;
    }

    for (const theme of ['day', 'night']) {
      const tag = theme === 'night' ? 'night' : 'day';

      // ---- idle + rolling, single camera, no sound -------------------------
      await seed(cdp, { cameraCount: 1, soundOn: false, scriptMode: false });
      await openRoll(cdp, theme);
      await cdp.shot(join(OUT_DIR, `idle.${tag}.png`));
      notes.push(`idle.${tag}  bigbtn=${JSON.stringify(await bigbtnBox(cdp))}`);

      // A real press on ROLL: pointerdown is what fires it.
      let p = await cdp.centreOf('.bigbtn');
      await cdp.mouseDown(p.x, p.y);
      await sleep(120);
      await cdp.shot(join(OUT_DIR, `press.${tag}.png`));   // the lamp, lit
      await cdp.mouseUp(p.x, p.y);
      await cdp.waitForExpr(`document.querySelector('.roll--live')`, { desc: 'live' });
      await sleep(2600);                                    // past the false-start window
      await cdp.shot(join(OUT_DIR, `rolling.${tag}.png`));
      notes.push(`rolling.${tag}  bigbtn=${JSON.stringify(await bigbtnBox(cdp))}`);

      // DOES THE SECONDS DIGIT ACTUALLY ROLL? The user has said twice that he
      // has never seen this, so asserting it is not good enough. A drum that
      // rolls passes through positions BETWEEN two digits; a drum that swaps
      // never does. So sample the hero clock's last column every ~25ms across a
      // second boundary and look for a translate that is not a whole multiple
      // of the glyph box - a fraction of a digit is a frame of the animation
      // and cannot be produced any other way. A screenshot is taken at the
      // first such sample, so there is a picture of it too.
      //
      // TWO HARNESS TRAPS, BOTH OF WHICH REPORT A WORKING DRUM AS A DEAD ONE,
      // and both of which cost a turn. Written down so they cost no more.
      //
      // 1. The polling has to happen OUT HERE, one CDP round trip per sample.
      //    An in-page loop inside a single awaited Runtime.evaluate reads the
      //    same frozen value for its whole run.
      // 2. Headless Chrome stops running the page about three seconds after
      //    its last compositor frame, so a clock driven by setInterval simply
      //    stops - measured, it froze at exactly 3.001 digits every time. A
      //    screenshot forces a frame, so one is taken every sample. On a real
      //    phone there is always a frame and none of this applies.
      const SAMPLE = `
        (() => {
          const d = [...document.querySelectorAll('.readout .drum__digit')].pop();
          if (!d) return null;
          const c = d.querySelector('.drum__col');
          const m = getComputedStyle(c).transform;
          const step = c.getBoundingClientRect().height / 10;  // ten glyph boxes
          const y = m === 'none' ? 0 : Number(m.split(',').pop().replace(')', ''));
          return -y / step;
        })()
      `;
      let mid = null;
      const seen = [];
      for (let i = 0; i < 40 && mid === null; i++) {
        const v = await cdp.evaluate(SAMPLE);
        if (v === null) break;
        seen.push(Number(v.toFixed(3)));
        // Keeps the page alive (see trap 2) AND is the picture, when it lands
        // on a frame of the roll.
        await cdp.shot(join(OUT_DIR, `drum-mid-roll.${tag}.png`));
        if (Math.abs(v - Math.round(v)) > 0.05) mid = v;
        await sleep(45);
      }
      notes.push(
        `drum.${tag}  rolling=${mid !== null} ` +
          (mid !== null
            ? `caught the seconds column at ${mid.toFixed(3)} digits - a whole number is a swap, a fraction is a roll`
            : `never left a whole digit: ${JSON.stringify(seen.slice(0, 12))}`),
      );

      // ---- the post-cut sheet, and a lamp on a sheet button ---------------
      p = await cdp.centreOf('.bigbtn');
      await cdp.mouseDown(p.x, p.y);
      await cdp.mouseUp(p.x, p.y);
      await sleep(700);
      await cdp.shot(join(OUT_DIR, `postcut.${tag}.png`));
      const prim = await cdp.centreOf('.sheet .btn--go');
      if (prim) {
        await cdp.mouseDown(prim.x, prim.y);
        await sleep(140);
        await cdp.shot(join(OUT_DIR, `postcut-press.${tag}.png`));
        await cdp.mouseUp(prim.x, prim.y);
      }
      notes.push(`postcut.${tag}  sheet=${await cdp.evaluate(`!!document.querySelector('.sheet')`)} primary=${!!prim}`);

      // ---- false-start sheet: CUT inside 2000ms ---------------------------
      await seed(cdp, { cameraCount: 1, soundOn: false, scriptMode: false });
      await openRoll(cdp, theme);
      p = await cdp.centreOf('.bigbtn');
      await cdp.mouseDown(p.x, p.y);
      await cdp.mouseUp(p.x, p.y);
      await cdp.waitForExpr(`document.querySelector('.roll--live')`, { desc: 'live for false start' });
      await sleep(500);
      p = await cdp.centreOf('.bigbtn');
      await cdp.mouseDown(p.x, p.y);
      await cdp.mouseUp(p.x, p.y);
      await sleep(700);
      await cdp.shot(join(OUT_DIR, `falsestart.${tag}.png`));
      notes.push(`falsestart.${tag}  sheet=${await cdp.evaluate(`!!document.querySelector('.sheet')`)}`);

      // ---- multi-cam + sound, rolling, plus the tag editor -----------------
      await seed(cdp, { cameraCount: 3, soundOn: true, scriptMode: true });
      await openRoll(cdp, theme);
      await cdp.shot(join(OUT_DIR, `multi-idle.${tag}.png`));
      // Roll camera A alone, then join sound: the mid-take join path.
      await cdp.evaluate(`document.querySelector('.camslot--edit .camslot__main').click(); true`);
      await cdp.waitForExpr(`document.querySelector('.roll--live')`, { desc: 'multi live' });
      await sleep(400);
      await cdp.evaluate(`
        (() => {
          const j = [...document.querySelectorAll('.camslot--join')]
            .find(b => (b.getAttribute('aria-label') || '').toLowerCase().includes('sound'));
          if (j) j.click();
          return !!j;
        })()
      `);
      await sleep(2400);
      await cdp.shot(join(OUT_DIR, `multi-rolling.${tag}.png`));
      notes.push(`multi-rolling.${tag}  bigbtn=${JSON.stringify(await bigbtnBox(cdp))}`);

      // ---- tag edit: a real long-press on a tag key ------------------------
      const key = await cdp.centreOf('.keypad--list .keycap');
      if (key) {
        await cdp.mouseDown(key.x, key.y);
        await sleep(750);
        await cdp.mouseUp(key.x, key.y);
        await sleep(350);
        const open = await cdp.evaluate(`!!document.querySelector('.rolltagsdeck')`);
        notes.push(`tagedit.${tag}  open=${open}`);
        await cdp.shot(join(OUT_DIR, `tagedit.${tag}.png`));
      } else {
        notes.push(`tagedit.${tag}  SKIPPED - no .keypad--list .keycap found`);
      }
    }

    console.log(notes.join('\n'));
    console.log(`\nWrote PNGs to ${OUT_DIR}`);
  } finally {
    chrome.kill();
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
