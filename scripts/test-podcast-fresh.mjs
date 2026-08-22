#!/usr/bin/env node
// Regression check for the Home "Podcast mode" tile: it must ALWAYS scratch a
// new project, never resume an existing one. Before the fix in newRoll.ts,
// startPodcastRoll() ran a resume-or-create ladder scoped to podcast
// projects, so a second tap on the same day quietly reopened whatever
// podcast project was touched most recently instead of starting a fresh
// recording — on a real set that means today's takes get logged into
// yesterday's project.
//
//   node scripts/test-podcast-fresh.mjs
//
// CDP plumbing borrowed from scripts/shoot-screens.mjs (same file, trimmed to
// what a headless proof needs: no screenshots, just DOM taps and store reads).
// Reuses the dev server already listening on :5200.

import { spawn } from 'node:child_process';
import { mkdtempSync, existsSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const REPO_ROOT = fileURLToPath(new URL('..', import.meta.url));
const DEV_PORT = Number(process.env.PORT ?? 5200);
const CDP_PORT = Number(process.env.CDP_PORT ?? 9337);
const BASE_URL = `http://localhost:${DEV_PORT}/`;
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

/** Wipes the store and stands up ONE pre-existing podcast project with a take
 *  on it — the project a buggy resume ladder would adopt. Named and dated so
 *  a wrong adoption is unmistakable in the assertions below. */
async function seed(cdp) {
  return await cdp.evaluate(`
    (async () => {
      const { store } = await import('/src/store/index.ts');
      for (const p of await store.listProjects()) await store.deleteProject(p.id);
      const pre = await store.createProject({
        name: 'Pilot Ep 12', fps: 24, clipPrefix: 'C', nextClipNumber: 1, clipPadding: 4,
        tags: ['GOLD'], mode: 'podcast',
      });
      const s = await store.createSlate(pre.id, 'Recording');
      // startedAt is REQUIRED on TakeInput.
      await store.createTake({ projectId: pre.id, slateId: s.id, durationMs: 900000, startedAt: Date.now() - 86400000 });
      return pre.id;
    })()
  `);
}

/** Every podcast-mode project on the phone right now, id + name + take count. */
async function podcastProjects(cdp) {
  return await cdp.evaluate(`
    (async () => {
      const { store } = await import('/src/store/index.ts');
      const all = await store.listProjects();
      const pods = all.filter((p) => p.mode === 'podcast');
      const out = [];
      for (const p of pods) {
        const bundle = await store.getBundle(p.id);
        out.push({ id: p.id, name: p.name, takes: bundle.takes.length });
      }
      return out;
    })()
  `);
}

/** Taps Home's hero, then the Podcast mode tile, and waits for the rolling
 *  screen — the exact path a hand on a real set takes. Starts from a fresh
 *  navigation each time (not a SPA route change) so no leftover component
 *  state from the previous tap can influence this one. */
async function startPodcastFromHome(cdp) {
  await cdp.navigate(BASE_URL);
  await cdp.waitForExpr(`document.body.textContent.includes("New roll")`, { desc: 'home' });
  await sleep(300);
  await cdp.waitForExpr(CLICK_BY_TEXT('New roll'), { desc: 'hero tap' });
  await cdp.waitForExpr(`document.body.textContent.includes('Podcast mode')`, { desc: 'picker sheet' });
  await sleep(150);
  await cdp.waitForExpr(CLICK_BY_TEXT('Podcast mode'), { desc: 'podcast tile tap' });
  await cdp.waitForExpr(`document.querySelector('.roll')`, { desc: 'rolling screen' });
  await sleep(300);
}

let failed = false;
function assert(cond, msg) {
  if (cond) { console.log(`  PASS  ${msg}`); }
  else { failed = true; console.log(`  FAIL  ${msg}`); }
}

async function main() {
  await waitForHttp(BASE_URL);
  const userDataDir = mkdtempSync(join(tmpdir(), 'clapper-podcast-'));
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
  await sleep(500);

  const preId = await seed(cdp);
  console.log(`seeded pre-existing podcast project: ${preId}`);

  console.log('\nfirst podcast tap from Home...');
  await startPodcastFromHome(cdp);
  const afterFirst = await podcastProjects(cdp);
  const firstNew = afterFirst.find((p) => p.id !== preId);

  console.log('second podcast tap from Home...');
  await startPodcastFromHome(cdp);
  const afterSecond = await podcastProjects(cdp);
  const secondNew = afterSecond.filter((p) => p.id !== preId).find((p) => p.id !== firstNew?.id);

  const pre = afterSecond.find((p) => p.id === preId);

  console.log('\npodcast projects on the phone after both taps:');
  for (const p of afterSecond) console.log(`  ${p.id}  "${p.name}"  ${p.takes} take(s)`);

  console.log('\nassertions:');
  assert(!!firstNew, 'first tap created a project distinct from the seeded one');
  assert(!!secondNew, 'second tap created a project distinct from the seeded one AND the first tap\'s');
  assert(firstNew && secondNew && firstNew.id !== secondNew.id, 'the two taps produced two distinct project ids');
  assert(!!pre, 'the pre-existing podcast project still exists (nothing deleted it)');
  assert(pre && pre.takes === 1, `the pre-existing project's take survives untouched (has ${pre?.takes ?? 'MISSING'}, want 1)`);
  assert(afterSecond.length === 3, `exactly 3 podcast projects exist now: seeded + 2 fresh (found ${afterSecond.length})`);

  cdp.ws.close();
  chrome.kill();

  if (failed) {
    console.log('\nFAILED');
    process.exit(1);
  }
  console.log('\nALL PASS');
}

main().catch((err) => { console.error(err); process.exit(1); });
