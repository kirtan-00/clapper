#!/usr/bin/env node
// Renders the FIRST-OPEN flow and writes PNGs, so nobody has to ship it blind.
//
// Same CDP harness as scripts/shoot-roll.mjs (no new dependency, Chromium
// borrowed out of Playwright's cache). Where that one drives the rolling
// screen, this one drives src/ui/Onboarding.tsx through every face it has and
// every way out of it, in both themes:
//
//   stage1            the account ask, rail at 1 of 2
//   stage1-press      the same, thumb on the primary, so the lamp is lit
//   stage2-menu       the generic browser-menu wording
//   stage2-ios        the iOS Safari Share-sheet wording
//   stage2-prompt     Chromium's own install prompt is available
//   home-after-skip   both stages skipped: the app, with nothing over it
//   reload-clean      RELOADED after that. The proof it does not come back.
//
// The last two are the point of the whole exercise. This flow ASKS; a screenshot
// of it asking is not evidence of anything until there is a screenshot of it
// having stopped.
//
// Two of the stage-2 faces are forced through `__clapperOnboardingFace`, a
// DEV-ONLY seam (see Onboarding.tsx) - headless Chromium on a laptop is neither
// an iPhone nor a phone Chromium has decided qualifies for installation, and a
// wording nobody has looked at is a wording nobody designed.
//
// It SPAWNS ITS OWN VITE, unlike shoot-roll.mjs, because ports 5200/5300/5320
// are other checkouts of this repo and shooting one of those would be shooting
// somebody else's branch.
//
// Usage:
//   node scripts/shoot-onboarding.mjs [outDir]
//   PORT=5412 node scripts/shoot-onboarding.mjs

import { spawn } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync, existsSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const REPO_ROOT = fileURLToPath(new URL('..', import.meta.url));
const DEV_PORT = Number(process.env.PORT ?? 5411);
const CDP_PORT = Number(process.env.CDP_PORT ?? 9341);
const BASE_URL = `http://localhost:${DEV_PORT}/`;
const OUT_DIR = process.argv[2] ?? join(REPO_ROOT, '.shots-onboarding');

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
      expression, awaitPromise: true, returnByValue: true, timeout: 15000,
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

// ------------------------------------------------------------------ drive ---

/** Click the footer button carrying this exact label. */
const CLICK_ACTION = (text) => `
  (() => {
    const want = ${JSON.stringify(text)};
    const hit = [...document.querySelectorAll('.sl-actions .btn')]
      .find((b) => (b.textContent || '').trim() === want);
    if (!hit) return false;
    hit.click();
    return true;
  })()
`;

/** The whole sheet's visible text, so a wording change shows up in the log too. */
const SHEET_TEXT = `
  (() => {
    const el = document.querySelector('.scrim .sheet');
    return el ? (el.innerText || '').replace(/\\s+/g, ' ').trim().slice(0, 200) : null;
  })()
`;

/** A cold app: every clapper key gone, the theme stamped, reloaded. */
async function fresh(cdp, theme) {
  await cdp.navigate(BASE_URL);
  await cdp.evaluate(`
    (() => {
      localStorage.clear();
      localStorage.setItem('clapper.theme', ${JSON.stringify(theme)});
      return true;
    })()
  `);
  await cdp.navigate(BASE_URL);
  await cdp.waitForExpr(`document.querySelector('.scrim .sheet')`, { desc: 'the first-open sheet' });
  await sleep(450); // the sheet's 240ms rise, plus a beat
}

async function main() {
  mkdirSync(OUT_DIR, { recursive: true });

  // Our own dev server. 5200/5300/5320 are other checkouts.
  const vite = spawn('npx', ['vite', '--port', String(DEV_PORT), '--strictPort'], {
    cwd: REPO_ROOT, stdio: 'ignore',
  });
  const chromeBin = findChrome();
  const userDataDir = mkdtempSync(join(tmpdir(), 'clapper-onboard-'));
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
      // ---- stage 1: the account ask ------------------------------------
      await fresh(cdp, theme);
      await cdp.shot(join(OUT_DIR, `stage1.${theme}.png`));
      notes.push(`stage1.${theme}  rail="${await cdp.evaluate(`document.querySelector('.sl-rail__step')?.textContent ?? null`)}"  ${await cdp.evaluate(SHEET_TEXT)}`);

      // The lamp under a thumb. A primary that burns at rest has to be seen
      // burning brighter, or the whole button system is a claim.
      const prim = await cdp.centreOf('.sl-actions .btn--go');
      if (prim) {
        await cdp.mouseDown(prim.x, prim.y);
        await sleep(140);
        await cdp.shot(join(OUT_DIR, `stage1-press.${theme}.png`));
        await cdp.mouseUp(prim.x, prim.y);
        await sleep(60);
      }

      // ---- stage 2, three faces ----------------------------------------
      for (const face of ['menu', 'ios', 'prompt']) {
        await fresh(cdp, theme);
        await cdp.evaluate(`window.__clapperOnboardingFace(${JSON.stringify(face)}); true`);
        // THE SKIP PATH: leaving stage 1 by its "Not now" is what puts us here.
        await cdp.waitForExpr(CLICK_ACTION('Not now'), { desc: 'stage 1 Not now' });
        await cdp.waitForExpr(`document.body.innerText.includes('Add to Home Screen')`, { desc: 'stage 2' });
        await sleep(350);
        await cdp.shot(join(OUT_DIR, `stage2-${face}.${theme}.png`));
        notes.push(`stage2-${face}.${theme}  rail="${await cdp.evaluate(`document.querySelector('.sl-rail__step')?.textContent ?? null`)}"  ${await cdp.evaluate(SHEET_TEXT)}`);
      }

      // ---- the whole escape hatch, end to end --------------------------
      await fresh(cdp, theme);
      await cdp.waitForExpr(CLICK_ACTION('Not now'), { desc: 'stage 1 Not now' });
      await cdp.waitForExpr(`document.body.innerText.includes('Add to Home Screen')`, { desc: 'stage 2' });
      await sleep(200);
      await cdp.waitForExpr(CLICK_ACTION('Not now'), { desc: 'stage 2 Not now' });
      await sleep(600); // the sheet's exit, plus its unmount
      await cdp.shot(join(OUT_DIR, `home-after-skip.${theme}.png`));
      const gone = await cdp.evaluate(`!document.querySelector('.scrim')`);
      const key = await cdp.evaluate(`localStorage.getItem('clapper.onboardingDone')`);
      const legacy = await cdp.evaluate(`localStorage.getItem('clapper.installNudgeDismissed')`);
      notes.push(`home-after-skip.${theme}  scrimGone=${gone}  onboardingDone=${key}  installDismissed=${legacy}`);

      // ---- AND IT STAYS GONE -------------------------------------------
      await cdp.navigate(BASE_URL);
      await cdp.waitForExpr(`document.body.innerText.includes('Home')`, { desc: 'home after reload' });
      await sleep(900); // well past the session latch and any late sheet
      await cdp.shot(join(OUT_DIR, `reload-clean.${theme}.png`));
      const stillGone = await cdp.evaluate(`!document.querySelector('.scrim')`);
      notes.push(`reload-clean.${theme}  scrimGone=${stillGone}`);
      if (!stillGone) notes.push(`  !! FAIL: the flow came back after a reload`);
    }
  } finally {
    chrome?.kill();
    vite.kill();
  }

  const report = notes.join('\n');
  writeFileSync(join(OUT_DIR, 'notes.txt'), report + '\n');
  console.log(report);
  console.log(`\nPNGs in ${OUT_DIR}`);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
