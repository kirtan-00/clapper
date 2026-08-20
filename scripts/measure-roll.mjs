#!/usr/bin/env node
// Acceptance test for the "per-camera strip unreachable while rolling" bug.
//
// WHY THIS EXISTS: on set, once the first camera rolls, RollingScreen's
// keypad (.roll__deck) grows and .roll__stage (flex-basis 0, shrinks first)
// collapses toward 0px — taking the per-camera strip (.camstack) and the
// Sound slot off screen with it. The operator can start camera A but can't
// physically reach B/C/D or the big CUT button. This script proves that,
// then (after the fix) proves it's gone, across viewports / camera counts /
// sound on-off / quick-tag vs Script Mode / idle vs rolling.
//
// NO NEW DEPENDENCY: puppeteer/playwright are not in package.json's
// devDependencies. Rather than add one, this drives the existing Vite dev
// server with a raw Chrome DevTools Protocol client over Node's built-in
// `fetch`/`WebSocket` (Node 20+), launching the Chromium binary Playwright
// already cached on this machine (~/Library/Caches/ms-playwright) as a
// disposable headless browser. If that cache is absent, point CHROME_BIN at
// any Chromium/Chrome executable.

import { spawn } from 'node:child_process';
import { mkdtempSync, rmSync, existsSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const REPO_ROOT = fileURLToPath(new URL('..', import.meta.url));
const DEV_PORT = 5183;
const CDP_PORT = 9333;
const BASE_URL = `http://localhost:${DEV_PORT}/`;

function findChrome() {
  if (process.env.CHROME_BIN && existsSync(process.env.CHROME_BIN)) return process.env.CHROME_BIN;
  const candidates = [
    join(
      process.env.HOME ?? '',
      'Library/Caches/ms-playwright',
    ),
  ];
  for (const base of candidates) {
    if (!existsSync(base)) continue;
    const dirs = readdirSync(base).filter((d) => d.startsWith('chromium-')).sort().reverse();
    for (const d of dirs) {
      const mac = join(base, d, 'chrome-mac-arm64', 'Google Chrome for Testing.app', 'Contents', 'MacOS', 'Google Chrome for Testing');
      const macIntel = join(base, d, 'chrome-mac', 'Google Chrome for Testing.app', 'Contents', 'MacOS', 'Google Chrome for Testing');
      if (existsSync(mac)) return mac;
      if (existsSync(macIntel)) return macIntel;
    }
  }
  const mac = '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
  if (existsSync(mac)) return mac;
  throw new Error('No Chromium/Chrome binary found. Set CHROME_BIN to point at one.');
}

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

async function waitForHttp(url, timeoutMs = 20000) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    try {
      const res = await fetch(url);
      if (res.ok || res.status < 500) return;
    } catch {
      /* not up yet */
    }
    await sleep(150);
  }
  throw new Error(`Timed out waiting for ${url}`);
}

// ------------------------------------------------------------- CDP client ---

class CDP {
  constructor(ws) {
    this.ws = ws;
    this.nextId = 1;
    this.pending = new Map();
    this.listeners = new Map(); // method -> Set<fn>
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
      expression,
      awaitPromise: true,
      returnByValue: true,
      timeout: 15000,
    });
    if (result.exceptionDetails) {
      const desc =
        result.exceptionDetails.exception?.description ??
        result.exceptionDetails.text ??
        'evaluate() threw';
      throw new Error(desc);
    }
    return result.result?.value;
  }

  async waitForExpr(exprBody, { timeout = 10000, interval = 100, desc = exprBody } = {}) {
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
      width,
      height,
      deviceScaleFactor: 2,
      mobile: true,
      screenWidth: width,
      screenHeight: height,
    });
  }
}

// ------------------------------------------------------------ scenarios ----

const VIEWPORTS = [
  { name: '360x640', width: 360, height: 640 },
  { name: '390x750', width: 390, height: 750 },
];
const CAMERA_COUNTS = [1, 2, 3, 4];
const SOUND_OPTIONS = [false, true];
const MODES = ['quick', 'script'];

const SCRIPT_TAGS = [
  { id: 't1', label: 'WIDE', tier: 'coverage', order: 0 },
  { id: 't2', label: 'CU', tier: 'coverage', order: 1 },
  { id: 't3', label: 'OTS', tier: 'coverage', order: 2 },
  { id: 't4', label: 'She turns to camera', tier: 'keyMoment', order: 0 },
  { id: 't5', label: 'Door slams shut', tier: 'keyMoment', order: 1 },
  { id: 't6', label: 'Big reveal', tier: 'keyMoment', order: 2 },
];

/** Click the first row/card whose visible text contains `text`. */
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

async function seed(cdp, { cameraCount, soundOn, mode }) {
  const cameras =
    cameraCount >= 2
      ? Array.from({ length: cameraCount }, (_, i) => ({
          letter: ['A', 'B', 'C', 'D'][i],
          clipPrefix: 'C',
          nextClipNumber: 1,
          clipPadding: 4,
        }))
      : undefined;
  const sound = soundOn ? { filePrefix: 'SND_', nextFileNumber: 1, filePadding: 4 } : undefined;
  const tags = mode === 'script' ? SCRIPT_TAGS : undefined;

  const expr = `
    (async () => {
      const mod = await import('/src/store/index.ts');
      const store = mod.store;
      const existing = await store.listProjects();
      for (const p of existing) await store.deleteProject(p.id);
      const project = await store.createProject({
        name: 'Measure Test',
        fps: 24,
        clipPrefix: 'C',
        nextClipNumber: 1,
        clipPadding: 4,
        tags: ['WIDE','MID','CU','OTS','INSERT','GOLD','PICKUP','NOISE'],
        ${cameras ? `cameras: ${JSON.stringify(cameras)},` : ''}
        ${sound ? `sound: ${JSON.stringify(sound)},` : ''}
      });
      const slate = await store.createSlate(project.id, 'Scene 1');
      ${tags ? `await store.updateSlate(slate.id, { tags: ${JSON.stringify(tags)} });` : ''}
      return true;
    })()
  `;
  await cdp.evaluate(expr);
}

/** In-page measurement: every reachable-or-not tap target on the rolling screen. */
const MEASURE_EXPR = `
  (() => {
    const vw = window.innerWidth, vh = window.innerHeight;
    const els = Array.from(document.querySelectorAll('.camslot, .bigbtn'));
    return els.map((el) => {
      const r = el.getBoundingClientRect();
      const cx = r.left + r.width / 2;
      const cy = r.top + r.height / 2;
      const hit = document.elementFromPoint(cx, cy);
      const reachable = !!hit && (el.contains(hit) || hit.contains(el));
      const inView = r.top >= -0.5 && r.left >= -0.5 && r.right <= vw + 0.5 && r.bottom <= vh + 0.5 && r.width > 1 && r.height > 1;
      return {
        label: el.classList.contains('bigbtn') ? 'bigbtn' : (el.getAttribute('aria-label') || '(camslot)'),
        top: Math.round(r.top), bottom: Math.round(r.bottom), left: Math.round(r.left), right: Math.round(r.right),
        inView, reachable, ok: inView && reachable,
      };
    });
  })()
`;

function expectedTargetCount({ cameraCount, soundOn }) {
  return (cameraCount >= 2 ? cameraCount : 0) + (soundOn ? 1 : 0) + 1; // +1 = bigbtn
}

async function measure(cdp) {
  return cdp.evaluate(MEASURE_EXPR);
}

function judge(records, expectedCount) {
  if (records.length < expectedCount) {
    return { pass: false, reason: `only ${records.length}/${expectedCount} targets found (strip missing)` };
  }
  const bad = records.filter((r) => !r.ok);
  if (bad.length > 0) {
    const worst = bad[0];
    const why = !worst.inView ? 'off-screen' : 'occluded/clipped';
    return {
      pass: false,
      reason: `${bad.length}/${records.length} unreachable — e.g. "${worst.label}" ${why} (top=${worst.top} bottom=${worst.bottom} left=${worst.left} right=${worst.right})`,
    };
  }
  return { pass: true, reason: 'all targets fully in view and hit-testable' };
}

async function runMatrix(cdp) {
  const rows = [];
  for (const vp of VIEWPORTS) {
    await cdp.setViewport(vp.width, vp.height);
    for (const cameraCount of CAMERA_COUNTS) {
      for (const soundOn of SOUND_OPTIONS) {
        for (const mode of MODES) {
          const cfg = { cameraCount, soundOn, mode };
          await seed(cdp, cfg);
          await cdp.navigate(BASE_URL);
          // MATCH ON THE WORDS, NOT THE CLASS. This used to click `.card`,
          // and the shell has since moved its lists onto grouped `.grow` rows -
          // so the whole matrix timed out on the first navigation and reported
          // nothing at all. A name is the one thing about these two rows that
          // is not going to be renamed by a repaint.
          await cdp.waitForExpr(
            `document.body.textContent.includes('Measure Test')`,
            { desc: 'projects list showing seeded project' },
          );
          await cdp.waitForExpr(CLICK_BY_TEXT('Measure Test'), { desc: 'project row clickable' });
          await cdp.waitForExpr(
            `document.body.textContent.includes('Scene 1')`,
            { desc: 'project screen showing seeded scene' },
          );
          await cdp.waitForExpr(CLICK_BY_TEXT('Scene 1'), { desc: 'scene row clickable' });
          await cdp.waitForExpr(`document.querySelector('.roll') && document.querySelector('.bigbtn')`, {
            desc: 'rolling screen mounted',
          });

          const expected = expectedTargetCount(cfg);

          // ---- idle ----
          const idleRecords = await measure(cdp);
          const idleVerdict = judge(idleRecords, expected);
          rows.push({
            viewport: vp.name,
            cams: cameraCount,
            sound: soundOn ? 'on' : 'off',
            mode,
            state: 'idle',
            pass: idleVerdict.pass,
            detail: idleVerdict.reason,
          });

          // ---- start rolling: camera A alone if multi, sound alone if
          // single-cam+sound, else the big ROLL (single-cam, no sound —
          // nothing else to leave unjoined). This is the exact shape of the
          // reported bug: ONE thing rolling, everything else still needing
          // to be reached. ----
          const clickedStart = await cdp.evaluate(`
            (() => {
              const solo = document.querySelector('.camslot--edit .camslot__main');
              if (solo) { solo.click(); return 'solo'; }
              const big = document.querySelector('.bigbtn');
              if (big) { big.click(); return 'big'; }
              return null;
            })()
          `);
          if (!clickedStart) throw new Error('no start control found on rolling screen');
          await cdp.waitForExpr(`document.querySelector('.roll--live')`, { desc: 'roll entered live state' });

          // ---- rolling ----
          const rollingRecords = await measure(cdp);
          const rollingVerdict = judge(rollingRecords, expected);
          rows.push({
            viewport: vp.name,
            cams: cameraCount,
            sound: soundOn ? 'on' : 'off',
            mode,
            state: 'rolling',
            pass: rollingVerdict.pass,
            detail: rollingVerdict.reason,
          });
        }
      }
    }
  }
  return rows;
}

function printTable(rows) {
  const cols = ['viewport', 'cams', 'sound', 'mode', 'state', 'pass', 'detail'];
  const widths = cols.map((c) => Math.max(c.length, ...rows.map((r) => String(r[c]).length)));
  const line = (vals) => vals.map((v, i) => String(v).padEnd(widths[i])).join('  ');
  console.log(line(cols));
  console.log(widths.map((w) => '-'.repeat(w)).join('  '));
  for (const r of rows) {
    console.log(line(cols.map((c) => (c === 'pass' ? (r[c] ? 'PASS' : 'FAIL') : r[c]))));
  }
}

// ------------------------------------------------------------------ main ---

async function main() {
  const chromeBin = findChrome();
  const userDataDir = mkdtempSync(join(tmpdir(), 'clapper-measure-'));

  console.log(`Starting Vite dev server on :${DEV_PORT} ...`);
  const viteBin = join(REPO_ROOT, 'node_modules', '.bin', 'vite');
  const vite = spawn(viteBin, ['--port', String(DEV_PORT), '--strictPort'], {
    cwd: REPO_ROOT,
    stdio: 'ignore',
  });
  await waitForHttp(BASE_URL, 25000);

  console.log(`Launching headless Chromium: ${chromeBin}`);
  const chrome = spawn(
    chromeBin,
    [
      '--headless=new',
      '--disable-gpu',
      `--remote-debugging-port=${CDP_PORT}`,
      `--user-data-dir=${userDataDir}`,
      '--no-first-run',
      '--disable-extensions',
      'about:blank',
    ],
    { stdio: 'ignore' },
  );
  await waitForHttp(`http://localhost:${CDP_PORT}/json/version`, 15000);

  let exitCode = 0;
  try {
    const cdp = await CDP.connectToNewPage(CDP_PORT);
    await cdp.send('Page.enable');
    await cdp.send('Runtime.enable');
    await cdp.navigate(BASE_URL);

    const rows = await runMatrix(cdp);
    printTable(rows);

    const failures = rows.filter((r) => !r.pass);
    console.log(`\n${rows.length - failures.length}/${rows.length} cases passed.`);
    if (failures.length > 0) {
      console.log(`${failures.length} FAILING case(s) — see table above.`);
      exitCode = 1;
    }
  } catch (err) {
    console.error('measure-roll.mjs crashed:', err);
    exitCode = 1;
  } finally {
    chrome.kill();
    vite.kill();
    try {
      rmSync(userDataDir, { recursive: true, force: true });
    } catch {
      /* best effort cleanup */
    }
  }
  process.exit(exitCode);
}

main();
