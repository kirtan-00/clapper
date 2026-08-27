#!/usr/bin/env node
// Verification shots for Studio Plus folders: the Projects screen grouped by
// folder, the entitled and locked states of the File-under sheet, and the
// folder-options (rename/delete) sheets. Same CDP-over-devtools rig as
// scripts/shoot-screens.mjs, trimmed to this one feature.
//
//   node scripts/shoot-folders.mjs [outDir]
//
// PHONE WIDTH ONLY (390x844, mobile:true) — this cannot prove the desktop
// (pointer:fine) layout, and does not try to. Navigates by full reload
// every time (never by an in-app #/route change), because Page.navigate's
// loadEventFired promise never resolves for a same-document route swap.

import { spawn } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync, existsSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const REPO_ROOT = fileURLToPath(new URL('..', import.meta.url));
const DEV_PORT = Number(process.env.PORT ?? 5200);
const CDP_PORT = Number(process.env.CDP_PORT ?? 9337);
const BASE_URL = `http://localhost:${DEV_PORT}/`;
const OUT_DIR = process.argv.slice(2).find((a) => !a.startsWith('--')) ?? join(REPO_ROOT, '.shots/folders');
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
    try { const res = await fetch(url); if (res.ok || res.status < 500) return; } catch {}
    if (Date.now() - start > timeoutMs) throw new Error(`Timed out waiting for ${url}`);
    await sleep(150);
  }
}

class CDP {
  constructor(ws) {
    this.ws = ws; this.nextId = 1; this.pending = new Map(); this.listeners = new Map();
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
      if (msg.error) reject(new Error(msg.error.message)); else resolve(msg.result);
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
      const fn = (params) => { if (!predicate(params)) return; set.delete(fn); resolve(params); };
      set.add(fn);
    });
  }
  async evaluate(expression) {
    const result = await this.send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true, timeout: 15000 });
    if (result.exceptionDetails) {
      throw new Error(result.exceptionDetails.exception?.description ?? result.exceptionDetails.text ?? 'evaluate() threw');
    }
    return result.result?.value;
  }
  async waitForExpr(exprBody, { timeout = 12000, interval = 100, desc = exprBody } = {}) {
    const start = Date.now();
    for (;;) {
      const ok = await this.evaluate(`(() => { try { return !!(${exprBody}); } catch (e) { return false; } })()`);
      if (ok) return true;
      if (Date.now() - start > timeout) throw new Error(`Timeout waiting for: ${desc}`);
      await sleep(interval);
    }
  }
  async navigate(url) { await this.send('Page.navigate', { url }); await this.once('Page.loadEventFired'); }
  async setViewport(width, height) {
    await this.send('Emulation.setDeviceMetricsOverride', { width, height, deviceScaleFactor: 2, mobile: true, screenWidth: width, screenHeight: height });
  }
  async shot(path) {
    const { data } = await this.send('Page.captureScreenshot', { format: 'png', captureBeyondViewport: false });
    writeFileSync(path, Buffer.from(data, 'base64'));
  }
}

const CLICK_BY_TEXT = (text) => `
  (() => {
    const want = ${JSON.stringify(text)};
    const els = [...document.querySelectorAll('button, [role="button"], .card, .grow, a')];
    const hit = els.find((e) => (e.textContent || '').includes(want));
    if (!hit) return false;
    (hit.closest('button') || hit).click();
    return true;
  })()
`;

const TAB = (label) => `
  (() => {
    const tabs = [...document.querySelectorAll('.mnav__tab')];
    const hit = tabs.find((t) => (t.textContent || '').trim().toLowerCase() === ${JSON.stringify(label)}.toLowerCase());
    if (!hit) return false;
    hit.click();
    return true;
  })()
`;

/** Seed three projects and a two-folder filing (one open with something in
 *  it, one empty), matching the row/section conventions the rest of the app
 *  already seeds its screenshots with (see shoot-screens.mjs's own seed). */
async function seed(cdp) {
  return await cdp.evaluate(`
    (async () => {
      localStorage.setItem('clapper.onboardingDone', '1');
      localStorage.setItem('clapper.installNudgeDismissed', '1');
      const { store } = await import('/src/store/index.ts');
      for (const p of await store.listProjects()) await store.deleteProject(p.id);

      const a = await store.createProject({ name: 'Coffee & Kismet', fps: 25, clipPrefix: 'C', nextClipNumber: 1, clipPadding: 4, tags: ['WIDE','CU'] });
      const b = await store.createProject({ name: 'The Long Wait', fps: 24, clipPrefix: 'C', nextClipNumber: 1, clipPadding: 4, tags: ['WIDE','CU'] });
      const c = await store.createProject({ name: 'Diwali Campaign', fps: 24, clipPrefix: 'C', nextClipNumber: 1, clipPadding: 4, tags: ['WIDE','CU'] });
      const d = await store.createProject({ name: 'Quiet Riot Ad', fps: 24, clipPrefix: 'C', nextClipNumber: 1, clipPadding: 4, tags: ['WIDE','CU'] });

      localStorage.setItem('clapper.folders.v1', JSON.stringify({
        folders: [
          { id: 'f-client', name: 'Client Work', order: 0 },
          { id: 'f-empty', name: 'Pitches', order: 1 },
        ],
        filed: { [a.id]: 'f-client', [b.id]: 'f-client' },
      }));

      return { a: a.id, b: b.id, c: c.id, d: d.id };
    })()
  `);
}

async function setTheme(cdp, theme) {
  await cdp.evaluate(`document.documentElement.setAttribute('data-theme', ${JSON.stringify(theme)}); true`);
  await sleep(150);
}

/** `expectFolders` defaults to true: 'Coffee & Kismet' is filed inside the
 *  (collapsed by default) Client Work folder, so it never reaches the DOM
 *  text until that folder is opened - wait on the folder header and an
 *  always-unfiled project instead, both visible the instant the list
 *  renders. The final "never subscribed" shot deletes the seeded folders
 *  first, so it passes false and waits on the unfiled project alone. */
async function toProjects(cdp, expectFolders = true) {
  await cdp.navigate(BASE_URL);
  await sleep(500);
  await cdp.waitForExpr(TAB('Projects'), { desc: 'projects tab' });
  const cond = expectFolders
    ? `document.body.textContent.includes('Client Work') && document.body.textContent.includes('Diwali Campaign')`
    : `document.body.textContent.includes('Diwali Campaign')`;
  await cdp.waitForExpr(cond, { desc: 'projects list' });
  await sleep(300);
}

async function main() {
  mkdirSync(OUT_DIR, { recursive: true });
  await waitForHttp(BASE_URL);
  const userDataDir = mkdtempSync(join(tmpdir(), 'clapper-folders-'));
  const chrome = spawn(findChrome(), [
    `--remote-debugging-port=${CDP_PORT}`, `--user-data-dir=${userDataDir}`,
    '--headless=new', '--no-first-run', '--no-default-browser-check', '--hide-scrollbars',
    '--disable-gpu', '--force-prefers-reduced-motion', 'about:blank',
  ], { stdio: 'ignore' });
  await waitForHttp(`http://localhost:${CDP_PORT}/json/version`);

  const cdp = await CDP.connectToNewPage(CDP_PORT);
  await cdp.send('Page.enable');
  await cdp.send('Runtime.enable');
  await cdp.setViewport(VIEWPORT.width, VIEWPORT.height);
  await cdp.navigate(BASE_URL);
  await sleep(600);
  const ids = await seed(cdp);
  console.log('seeded:', ids);

  const written = [];
  const take = async (name, theme) => {
    const p = join(OUT_DIR, `${theme}.${name}.png`);
    await cdp.shot(p); written.push(p); console.log(`  shot ${theme}.${name}`);
  };

  const theme = 'day';

  // ------------------------------------------------------------- ENTITLED --
  await toProjects(cdp);
  await setTheme(cdp, theme);
  await cdp.evaluate(`window.__clapperProjectsDev(true); true`);
  await sleep(300);
  await take('01-entitled-list', theme);

  // Open the folder that has something in it.
  await cdp.waitForExpr(CLICK_BY_TEXT('Client Work'), { desc: 'folder head' });
  await cdp.waitForExpr(`document.body.textContent.includes('The Long Wait')`, { desc: 'folder open' });
  await sleep(300);
  await take('02-entitled-folder-open', theme);

  // File-under sheet on an unfiled project — entitled, so New folder shows.
  await cdp.navigate(BASE_URL);
  await setTheme(cdp, theme);
  await cdp.evaluate(`window.__clapperProjectsDev(true); true`);
  await cdp.waitForExpr(TAB('Projects'), { desc: 'projects tab' });
  await cdp.waitForExpr(`document.body.textContent.includes('Diwali Campaign')`, { desc: 'projects list' });
  await sleep(300);
  await cdp.waitForExpr(`
    (() => {
      const row = [...document.querySelectorAll('.pj-row, .pj-key')].find(r => r.textContent.includes('Diwali Campaign'));
      const btn = row && row.querySelector('.pj-more');
      if (!btn) return false;
      btn.click();
      return true;
    })()
  `, { desc: 'file-under button' });
  await cdp.waitForExpr(`document.body.textContent.includes('File under')`, { desc: 'file-under sheet' });
  await sleep(300);
  await take('03-entitled-file-under', theme);

  // Folder options (rename/delete) — close the sheet, open the folder menu.
  await cdp.evaluate(`(() => { const el = document.querySelector('.scrim'); if (el) el.click(); return true; })()`);
  await sleep(300);
  await cdp.waitForExpr(`
    (() => {
      const btn = [...document.querySelectorAll('.pj-fopts')][0];
      if (!btn) return false;
      btn.click();
      return true;
    })()
  `, { desc: 'folder options button' });
  await sleep(300);
  await take('04-entitled-folder-menu', theme);

  // Delete confirm.
  await cdp.waitForExpr(CLICK_BY_TEXT('Delete folder'), { desc: 'delete folder row' });
  await sleep(300);
  await take('05-entitled-delete-confirm', theme);
  // Cancel it — this is a verification shot, not an actual delete run.
  await cdp.waitForExpr(CLICK_BY_TEXT('Cancel'), { desc: 'cancel delete' });
  await sleep(200);

  // --------------------------------------------------------------- LAPSED --
  // Same seeded folders, entitlement flipped off: grouping must render
  // identically, only the controls change.
  await toProjects(cdp);
  await setTheme(cdp, theme);
  await cdp.evaluate(`window.__clapperProjectsDev(false); true`);
  await sleep(300);
  await take('06-lapsed-list', theme);

  await cdp.waitForExpr(CLICK_BY_TEXT('Client Work'), { desc: 'folder head (lapsed)' });
  await sleep(300);
  await take('07-lapsed-folder-open', theme);

  await cdp.waitForExpr(`
    (() => {
      const row = [...document.querySelectorAll('.pj-row, .pj-key')].find(r => r.textContent.includes('Diwali Campaign'));
      const btn = row && row.querySelector('.pj-more');
      if (!btn) return false;
      btn.click();
      return true;
    })()
  `, { desc: 'file-under button (lapsed)' });
  await cdp.waitForExpr(`document.body.textContent.includes('File under')`, { desc: 'file-under sheet (lapsed)' });
  await sleep(300);
  await take('08-lapsed-file-under', theme);

  // --------------------------------------------------------- NEVER-SUBBED --
  // No dev override at all: a signed-out device reads entitlements as null,
  // so this is the true "never touched Studio Plus" baseline — no folders in
  // storage either, so the screen should look exactly like today's plain list.
  await cdp.evaluate(`
    (async () => {
      window.__clapperProjectsDev(null);
      localStorage.removeItem('clapper.folders.v1');
      return true;
    })()
  `);
  await toProjects(cdp, false);
  await setTheme(cdp, theme);
  await sleep(300);
  await take('09-free-no-folders', theme);

  console.log(`\n${written.length} shots -> ${OUT_DIR}`);
  cdp.ws.close();
  chrome.kill();
}

main().catch((err) => { console.error(err); process.exit(1); });
