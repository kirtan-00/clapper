#!/usr/bin/env node
// Renders the STUDIO IDENTITY sheet and its Settings row, in both themes, so
// the form that stamps every export is not shipped unlooked-at.
//
// It drives the SETTINGS entry point rather than the one-time prompt, on
// purpose: StudioRow opens the identical StudioSheet with no session needed,
// which is the only way to paint this sheet in a headless browser that cannot
// complete a Google OAuth round trip. Same component, same CSS, same two
// buttons - the only difference is the secondary button's label, and that
// difference is itself one of the things worth seeing.
//
// Usage:
//   node scripts/shoot-studio.mjs [outDir]

import { spawn } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync, existsSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const REPO_ROOT = fileURLToPath(new URL('..', import.meta.url));
const DEV_PORT = Number(process.env.PORT ?? 5419);
const CDP_PORT = Number(process.env.CDP_PORT ?? 9349);
const BASE_URL = `http://localhost:${DEV_PORT}/`;
const OUT_DIR = process.argv[2] ?? join(REPO_ROOT, '.shots-studio');

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

/** Open Settings from a cold app with the theme stamped. */
async function settings(cdp, theme, stored) {
  await cdp.navigate(BASE_URL);
  await cdp.evaluate(`
    (() => {
      localStorage.clear();
      localStorage.setItem('clapper.theme', ${JSON.stringify(theme)});
      // Onboarding out of the way: this harness is about the studio sheet.
      localStorage.setItem('clapper.onboardingDone', '1');
      localStorage.setItem('clapper.installNudgeDismissed', '1');
      ${stored ? `localStorage.setItem('clapper.studio.v1', ${JSON.stringify(JSON.stringify(stored))});` : ''}
      return true;
    })()
  `);
  // A FULL RELOAD, so the keys just written are the ones the app boots with.
  // Onboarding latches its decision in a mount effect; setting its key after
  // that first boot is setting it too late, and the harness dutifully
  // screenshotted the onboarding sheet twice before this line came back.
  //
  // And NOT a hash navigation: `cdp.navigate` waits on Page.loadEventFired,
  // which a same-document hash change never fires. That hung the run for two
  // minutes. The tab tray is the way in, and it is how a person gets there.
  await cdp.navigate(BASE_URL);
  await sleep(700);
  await cdp.evaluate(`
    (() => {
      const hit = [...document.querySelectorAll('a,button')]
        .find((b) => (b.textContent || '').trim().toLowerCase() === 'settings');
      if (hit) hit.click();
      return !!hit;
    })()
  `);
  await sleep(500);
}

const CLICK_ROW = (label) => `
  (() => {
    const hit = [...document.querySelectorAll('.row, button, li')]
      .find((b) => (b.textContent || '').includes(${JSON.stringify(label)}));
    if (!hit) return false;
    hit.click();
    return true;
  })()
`;

const SHEET_TEXT = `
  (() => {
    const el = document.querySelector('.scrim .sheet');
    return el ? (el.innerText || '').replace(/\\s+/g, ' ').trim().slice(0, 240) : null;
  })()
`;

async function main() {
  mkdirSync(OUT_DIR, { recursive: true });
  const vite = spawn('npx', ['vite', '--port', String(DEV_PORT), '--strictPort'], {
    cwd: REPO_ROOT, stdio: 'ignore',
  });
  const chromeBin = findChrome();
  const userDataDir = mkdtempSync(join(tmpdir(), 'clapper-studio-'));
  let chrome = null;
  const notes = [];

  try {
    await waitForHttp(BASE_URL, 30000);
    chrome = spawn(chromeBin, [
      '--headless=new', '--disable-gpu', `--remote-debugging-port=${CDP_PORT}`,
      `--user-data-dir=${userDataDir}`, '--no-first-run', '--disable-extensions',
      'about:blank',
    ], { stdio: 'ignore' });
    await waitForHttp(`http://localhost:${CDP_PORT}/json/version`, 20000);

    const cdp = await CDP.connectToNewPage(CDP_PORT);
    await cdp.send('Page.enable');
    await cdp.send('Runtime.enable');
    await cdp.setViewport(VIEWPORT.width, VIEWPORT.height);

    for (const theme of ['light', 'night']) {
      // 1. The Settings row, unset.
      await settings(cdp, theme, null);
      await cdp.evaluate(`
        (() => {
          const el = [...document.querySelectorAll('*')]
            .find((n) => (n.textContent || '').trim() === 'Production house');
          if (el) el.scrollIntoView({ block: 'center' });
          return !!el;
        })()
      `);
      await sleep(350);
      await cdp.shot(join(OUT_DIR, `${theme}-row-unset.png`));

      // 2. The sheet it opens.
      const opened = await cdp.evaluate(CLICK_ROW('Production house'));
      notes.push(`${theme}: row click -> ${opened}`);
      await sleep(500);
      await cdp.shot(join(OUT_DIR, `${theme}-sheet.png`));
      notes.push(`${theme}: sheet text = ${await cdp.evaluate(SHEET_TEXT)}`);

      // 3. The row with a studio already stored.
      await settings(cdp, theme, { name: 'Kirtan', studio: 'Fourside Studio' });
      await cdp.evaluate(`
        (() => {
          const el = [...document.querySelectorAll('*')]
            .find((n) => (n.textContent || '').trim() === 'Production house');
          if (el) el.scrollIntoView({ block: 'center' });
          return !!el;
        })()
      `);
      await sleep(350);
      await cdp.shot(join(OUT_DIR, `${theme}-row-set.png`));
    }
  } finally {
    if (chrome) chrome.kill();
    vite.kill();
  }
  console.log(notes.join('\n'));
  console.log('shots in', OUT_DIR);
}

main().catch((e) => { console.error(e); process.exit(1); });
