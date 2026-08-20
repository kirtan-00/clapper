#!/usr/bin/env node
// Shoots EVERY screen of the app at phone size, both themes, so a UI pass is
// argued from images rather than from memory. Companion to shoot-roll.mjs,
// which only ever covered the rolling screen.
//
//   node scripts/shoot-screens.mjs [outDir]
//
// Reuses the dev server already listening on :5200 and borrows Chromium out of
// Playwright's cache, same as its sibling. No new dependency.

import { spawn } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync, existsSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const REPO_ROOT = fileURLToPath(new URL('..', import.meta.url));
const DEV_PORT = Number(process.env.PORT ?? 5200);
const CDP_PORT = Number(process.env.CDP_PORT ?? 9336);
const BASE_URL = `http://localhost:${DEV_PORT}/`;
const OUT_DIR = process.argv.slice(2).find((a) => !a.startsWith('--')) ?? join(REPO_ROOT, '.shots/screens');
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

const CLICK_SEL = (sel) => `
  (() => { const el = document.querySelector(${JSON.stringify(sel)}); if (!el) return false; el.click(); return true; })()
`;

/** The app keeps navigation in memory, not in the URL, so a tab is reached by
 *  tapping its key in the tray. Matched on the visible label. */
const TAB = (label) => `
  (() => {
    const tabs = [...document.querySelectorAll('.mnav__tab')];
    const hit = tabs.find((t) => (t.textContent || '').trim().toLowerCase() === ${JSON.stringify(label)}.toLowerCase());
    if (!hit) return false;
    hit.click();
    return true;
  })()
`;

const SHOTS = [
  { id: 's1', code: 'S1−01', order: 0, size: 'MCU', move: 'Slow PUSH IN',
    action: 'She crosses the kitchen, stops at the window, and watches the street for a long beat before she finally turns back to the table.',
    dialogue: 'You were never going to tell me, were you.' },
  { id: 's2', code: 'S1−02', order: 1, size: 'OTS (over Dev)', move: 'STATIC, low', action: 'His reply, flat.' },
  { id: 's3', code: 'S1−03', order: 2, size: 'XWS', move: 'HANDHELD', action: 'The street, empty.' },
];

async function seed(cdp) {
  return await cdp.evaluate(`
    (async () => {
      const { store } = await import('/src/store/index.ts');
      for (const p of await store.listProjects()) await store.deleteProject(p.id);
      const a = await store.createProject({
        name: 'No Mans Hero', fps: 24, clipPrefix: 'C', nextClipNumber: 1, clipPadding: 4,
        tags: ['WIDE','MID','CU','OTS','INSERT','GOLD','PICKUP','NOISE'],
        cameras: [
          { letter:'A', clipPrefix:'C', nextClipNumber:1, clipPadding:4, operator:'Chirag' },
          { letter:'B', clipPrefix:'C', nextClipNumber:1, clipPadding:4, operator:'Manthan' },
        ],
        sound: { filePrefix:'SND_', nextFileNumber:1, filePadding:4 },
      });
      const s1 = await store.createSlate(a.id, 'Scene 1');
      await store.updateSlate(s1.id, { shots: ${JSON.stringify(SHOTS)}, summary: 'Kitchen, night. She reads the letter and he does not look up from the table.' });
      await store.createSlate(a.id, 'Scene 2');
      await store.createProject({ name: 'Okkai Hero Film', fps: 25, clipPrefix: 'C', nextClipNumber: 1, clipPadding: 4, tags: ['WIDE','CU','GOLD'] });
      await store.createProject({ name: 'Palladium Spot', fps: 24, clipPrefix: 'C', nextClipNumber: 1, clipPadding: 4, tags: ['WIDE','CU'] });
      return true;
    })()
  `);
}

async function setTheme(cdp, theme) {
  await cdp.evaluate(`document.documentElement.setAttribute('data-theme', ${JSON.stringify(theme)}); true`);
  await sleep(180);
}

async function main() {
  mkdirSync(OUT_DIR, { recursive: true });
  await waitForHttp(BASE_URL);
  const userDataDir = mkdtempSync(join(tmpdir(), 'clapper-screens-'));
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
  await sleep(800);
  const seeded = await seed(cdp);
  console.log('seeded:', seeded);
  console.log('body:', (await cdp.evaluate('document.body.innerText.slice(0,400)')));

  const written = [];
  const take = async (name, theme) => {
    const p = join(OUT_DIR, `${theme}.${name}.png`);
    await cdp.shot(p); written.push(p); console.log(`  shot ${theme}.${name}`);
  };

  for (const theme of ['day', 'night']) {
    // HOME
    await cdp.navigate(BASE_URL);
    await setTheme(cdp, theme);
    await cdp.waitForExpr(`document.body.textContent.includes("New roll")`, { desc: 'home' });
    await sleep(400);
    await take('01-home', theme);

    // PROJECTS LIST
    await cdp.waitForExpr(TAB('Projects'), { desc: 'projects tab' });
    await setTheme(cdp, theme);
    await cdp.waitForExpr(`document.body.textContent.includes("No Mans Hero")`, { desc: 'projects list' });
    await sleep(400);
    await take('01b-projects', theme);

    // PROJECT
    await cdp.waitForExpr(CLICK_BY_TEXT("No Mans Hero"), { desc: 'project row' });
    await cdp.waitForExpr(`document.body.textContent.includes('Scene 1')`, { desc: 'project screen' });
    await sleep(400);
    await take('02-project', theme);

    // SHOTS (breakdown)
    await cdp.waitForExpr(CLICK_BY_TEXT('Scene 1'), { desc: 'scene row' });
    await sleep(700);
    await take('03-shots', theme);

    // ROLLING (idle)
    await cdp.evaluate(`(!!document.querySelector('.roll') || (document.querySelector('.stack .card') ? (document.querySelector('.stack .card').click(), true) : false))`);
    await cdp.waitForExpr(`document.querySelector('.roll') && document.querySelector('.bigbtn')`, { desc: 'rolling' });
    await setTheme(cdp, theme);
    await sleep(500);
    await take('04-roll-idle', theme);

    // SETTINGS
    await cdp.navigate(BASE_URL);
    await setTheme(cdp, theme);
    await cdp.waitForExpr(TAB('Settings'), { desc: 'settings tab' });
    await sleep(700);
    await take('05-settings', theme);

    // ACCOUNT
    await cdp.waitForExpr(TAB('Account'), { desc: 'account tab' });
    await sleep(700);
    await take('06-account', theme);
  }

  console.log(`\n${written.length} shots -> ${OUT_DIR}`);
  cdp.ws.close();
  chrome.kill();
}

main().catch((err) => { console.error(err); process.exit(1); });
