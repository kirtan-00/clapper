#!/usr/bin/env node
// THE SCROLLER PROBE.
//
// The owner's own words, asked twice: "the rolling screen is divided into
// multiple scrollables". He measured it on a real phone - night theme, 2
// cameras + sound + a 3-shot breakdown, 10 tags, while rolling - and found
// .roll__pads (every height 844 down to 664) and .roll__deck (620 only)
// scrolling. This script asks the same question the same way: for every
// element on the rolling screen, is overflow-y auto/scroll AND does
// scrollHeight - clientHeight exceed 2px? That is a real scroller, not a
// rounding error - same 2px floor slice-check.mjs settled on for the same
// reason (sub-pixel layout noise on a tabular-numeral box).
//
// Matches the owner's rig by default (2 cams, sound, 3-shot breakdown, 10
// tags) and sweeps cams 1-4 on request (--cams=all) because the hard
// constraint is clip-number visibility at every camera count, not just two.
//
//   node scripts/scroller-check.mjs             # owner's rig, cams=2
//   node scripts/scroller-check.mjs --cams=all  # cams 1,2,3,4

import { spawn } from 'node:child_process';
import { mkdtempSync, existsSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const REPO_ROOT = fileURLToPath(new URL('..', import.meta.url));
const DEV_PORT = Number(process.env.PORT ?? 5210);
const CDP_PORT = Number(process.env.CDP_PORT ?? 9360);
const BASE_URL = `http://localhost:${DEV_PORT}/`;

const HEIGHTS = [932, 844, 780, 740, 700, 664, 620];
const CAMS = process.argv.includes('--cams=all') ? [1, 2, 3, 4] : [2];

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function findChrome() {
  if (process.env.CHROME_BIN && existsSync(process.env.CHROME_BIN)) return process.env.CHROME_BIN;
  const base = join(process.env.HOME ?? '', 'Library/Caches/ms-playwright');
  if (existsSync(base)) {
    for (const d of readdirSync(base).filter((x) => x.startsWith('chromium-')).sort().reverse()) {
      for (const a of ['chrome-mac-arm64', 'chrome-mac']) {
        const p = join(base, d, a, 'Google Chrome for Testing.app', 'Contents', 'MacOS', 'Google Chrome for Testing');
        if (existsSync(p)) return p;
      }
    }
  }
  const mac = '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
  if (existsSync(mac)) return mac;
  throw new Error('No Chromium found. Set CHROME_BIN.');
}

async function waitHttp(url, timeoutMs = 20000) {
  const start = Date.now();
  for (;;) {
    try { const r = await fetch(url); if (r.status < 500) return; } catch { /* not up */ }
    if (Date.now() - start > timeoutMs) throw new Error(`Timed out waiting for ${url}`);
    await sleep(150);
  }
}

class CDP {
  constructor(ws) {
    this.ws = ws; this.nextId = 1; this.pending = new Map(); this.listeners = new Map();
    ws.addEventListener('message', (ev) => {
      const m = JSON.parse(ev.data);
      if (m.id !== undefined && this.pending.has(m.id)) {
        const { resolve, reject } = this.pending.get(m.id); this.pending.delete(m.id);
        m.error ? reject(new Error(m.error.message)) : resolve(m.result);
      } else if (m.method) { const s = this.listeners.get(m.method); if (s) for (const f of s) f(m.params); }
    });
  }
  static async connect(port) {
    const r = await fetch(`http://localhost:${port}/json/new?about:blank`, { method: 'PUT' });
    const t = await r.json();
    const ws = new WebSocket(t.webSocketDebuggerUrl);
    await new Promise((res, rej) => { ws.addEventListener('open', res, { once: true }); ws.addEventListener('error', rej, { once: true }); });
    return new CDP(ws);
  }
  send(method, params = {}) {
    const id = this.nextId++;
    return new Promise((resolve, reject) => { this.pending.set(id, { resolve, reject }); this.ws.send(JSON.stringify({ id, method, params })); });
  }
  once(method) { return new Promise((r) => { const s = this.listeners.get(method) ?? new Set(); this.listeners.set(method, s); const f = (p) => { s.delete(f); r(p); }; s.add(f); }); }
  async evaluate(expr) {
    const r = await this.send('Runtime.evaluate', { expression: expr, awaitPromise: true, returnByValue: true, timeout: 20000 });
    if (r.exceptionDetails) throw new Error(r.exceptionDetails.exception?.description ?? 'evaluate threw');
    return r.result?.value;
  }
  async waitFor(expr, desc = expr, timeout = 12000) {
    const st = Date.now();
    for (;;) {
      if (await this.evaluate(`(()=>{try{return !!(${expr})}catch(e){return false}})()`)) return true;
      if (Date.now() - st > timeout) throw new Error(`Timeout waiting for: ${desc}`);
      await sleep(100);
    }
  }
  async navigate(u) { await this.send('Page.navigate', { url: u }); await this.once('Page.loadEventFired'); }
  async viewport(w, h) { await this.send('Emulation.setDeviceMetricsOverride', { width: w, height: h, deviceScaleFactor: 2, mobile: true, screenWidth: w, screenHeight: h }); }
}

// The owner's own repro: a 3-shot breakdown (Script Mode), 10 tags on the
// project (flat fallback is never exercised when a breakdown exists, but the
// project tag list is still what Script Mode's OWN tags sit alongside in the
// same seed shape slice-check.mjs already uses), sound on.
const SHOTS = [
  { id: 's1', code: 'S3-01', order: 0, size: 'WS', move: 'STATIC', action: 'Wide of the gate.' },
  { id: 's2', code: 'S3-02', order: 1, size: 'MCU', move: 'PUSH IN', action: 'Knock on the door.' },
  { id: 's3', code: 'S3-03', order: 2, size: 'OTS', move: 'HANDHELD', action: 'Door opens, lantern.' },
];
const TAGS_10 = ['WIDE', 'MID', 'CU', 'OTS', 'INSERT', 'GOLD', 'PICKUP', 'NOISE', 'alarm stops', 'stretch / wake'];
// The REAL shape, not a stand-in: WIDE/MID/CU is much easier to fit than
// production data. src/ui/packs/no-mans-hero.json's own first scene -
// exactly what the coordinator flagged after Kirtan's own phone recording
// showed the same pattern ("alarm stops", "face in photo reflection").
const SCRIPT_TAGS = [
  { id: 't1', label: 'WIDE', tier: 'coverage', order: 0 },
  { id: 't2', label: 'MID', tier: 'coverage', order: 1 },
  { id: 't3', label: 'CLOSEUP', tier: 'coverage', order: 2 },
  { id: 't4', label: 'Phone rings', tier: 'keyMoment', order: 0 },
  { id: 't5', label: 'Address given', tier: 'keyMoment', order: 1 },
  { id: 't6', label: 'Packs kit', tier: 'keyMoment', order: 2 },
  { id: 't7', label: 'Locks up', tier: 'keyMoment', order: 3 },
  { id: 't8', label: 'Scooter starts', tier: 'keyMoment', order: 4 },
  { id: 't9', label: 'Rides into night', tier: 'keyMoment', order: 5 },
];

async function seed(cdp, cams) {
  const cameras = Array.from({ length: cams }, (_, i) => ({
    letter: 'ABCD'[i], clipPrefix: 'C', nextClipNumber: 1, clipPadding: 4,
  }));
  await cdp.evaluate(`
    (async () => {
      const { store } = await import('/src/store/index.ts');
      for (const p of await store.listProjects()) await store.deleteProject(p.id);
      const proj = await store.createProject({
        name: 'Scroller Test', fps: 24, clipPrefix: 'C', nextClipNumber: 1, clipPadding: 4,
        tags: ${JSON.stringify(TAGS_10)},
        cameras: ${JSON.stringify(cameras)},
        sound: { filePrefix: 'SND_', nextFileNumber: 1, filePadding: 4 },
      });
      const slate = await store.createSlate(proj.id, 'Scene 1');
      await store.updateSlate(slate.id, { shots: ${JSON.stringify(SHOTS)}, tags: ${JSON.stringify(SCRIPT_TAGS)} });
      return true;
    })()`);
}

const CLICK_TEXT = (t) => `
  (() => {
    const e=[...document.querySelectorAll('button,[role="button"],.card,.grow')].find(x=>(x.textContent||'').includes(${JSON.stringify(t)}));
    if(!e) return false; (e.closest('button')||e).click(); return true;
  })()`;

async function openRoll(cdp, theme) {
  await cdp.navigate(BASE_URL);
  await cdp.evaluate(`document.documentElement.setAttribute('data-theme',${JSON.stringify(theme)});true`);
  await cdp.waitFor(`document.body.textContent.includes('Scroller Test')`, 'home');
  await cdp.waitFor(CLICK_TEXT('Scroller Test'), 'project row');
  await cdp.waitFor(`document.body.textContent.includes('Scene 1')`, 'project screen');
  await cdp.waitFor(CLICK_TEXT('Scene 1'), 'scene row');
  // Script Mode with a breakdown lands on the shot wheel first - open the
  // first shot card to reach the rolling screen, same fallback slice-check
  // already relies on.
  await cdp.waitFor(
    `(!!document.querySelector('.roll') || (document.querySelector('.stack .card') ? (document.querySelector('.stack .card').click(), true) : false))`,
    'roll, or the shot list on the way',
  );
  await cdp.waitFor(`document.querySelector('.roll') && document.querySelector('.bigbtn')`, 'rolling screen');
  await cdp.evaluate(`document.documentElement.setAttribute('data-theme',${JSON.stringify(theme)});true`);
  await sleep(200);
}

// Every scrollable region on the page: overflow-y auto/scroll AND a real
// content deficit past 2px (the same tolerance slice-check.mjs settled on).
const SCROLLER_PROBE = `
  (() => {
    const found = [];
    for (const el of document.querySelectorAll('*')) {
      const cs = getComputedStyle(el);
      if (!/auto|scroll/.test(cs.overflowY)) continue;
      const deficit = el.scrollHeight - el.clientHeight;
      if (deficit > 2) {
        const label = el.className && typeof el.className === 'string'
          ? '.' + el.className.trim().split(/\\s+/).join('.')
          : el.tagName.toLowerCase();
        found.push({ label, deficit: Math.round(deficit), scrollHeight: el.scrollHeight, clientHeight: el.clientHeight });
      }
    }
    return found;
  })()
`;

// Custom properties resolve to their literal text via getComputedStyle, not
// the computed px value (clamp() stays "clamp(24px, 5vh, 46px)" verbatim) -
// so the RESOLVED number has to come off the pseudo-element that actually
// consumes it, via the two-argument getComputedStyle(el, '::after') form.
async function ringNumbers(cdp) {
  return cdp.evaluate(`
    (() => {
      const el = document.querySelector('.roll--live') || document.querySelector('.roll');
      const cs = getComputedStyle(el, '::after');
      return {
        radius: cs.borderTopLeftRadius,
        weight: cs.borderTopWidth,
        inset: cs.top,
      };
    })()
  `);
}

async function clipNumbers(cdp) {
  return cdp.evaluate(`
    [...document.querySelectorAll('.camslot__clip, .tally__clock')].map(el => (el.textContent||'').trim())
  `);
}

async function main() {
  await waitHttp(BASE_URL).catch(async () => {
    // Dev server not already running - start one.
  });
  let vite = null;
  try {
    await fetch(BASE_URL);
  } catch {
    vite = spawn(join(REPO_ROOT, 'node_modules', '.bin', 'vite'), ['--port', String(DEV_PORT), '--strictPort'], {
      cwd: REPO_ROOT, stdio: 'ignore',
    });
    await waitHttp(BASE_URL, 25000);
  }

  const chrome = spawn(findChrome(), [
    `--remote-debugging-port=${CDP_PORT}`, `--user-data-dir=${mkdtempSync(join(tmpdir(), 'scroller-'))}`,
    '--headless=new', '--no-first-run', '--disable-gpu', '--force-prefers-reduced-motion', 'about:blank',
  ], { stdio: 'ignore' });
  await waitHttp(`http://localhost:${CDP_PORT}/json/version`, 15000);

  const cdp = await CDP.connect(CDP_PORT);
  await cdp.send('Page.enable'); await cdp.send('Runtime.enable');
  await cdp.viewport(390, 844);
  await cdp.navigate(BASE_URL); await sleep(500);

  const rows = [];
  let totalScrollers = 0;
  const ringRows = [];
  const clipRows = [];

  for (const cams of CAMS) {
    await cdp.viewport(390, 844);
    await cdp.navigate(BASE_URL); await sleep(300);
    await seed(cdp, cams);

    for (const theme of ['day', 'night']) {
      for (const h of HEIGHTS) {
        await cdp.viewport(390, h);
        await openRoll(cdp, theme);

        for (const phase of ['idle', 'rolling']) {
          if (phase === 'rolling') {
            const box = await cdp.evaluate(`(()=>{const e=document.querySelector('.bigbtn');if(!e)return null;const r=e.getBoundingClientRect();return{x:Math.round(r.left+r.width/2),y:Math.round(r.top+r.height/2)};})()`);
            if (box) {
              await cdp.send('Input.dispatchMouseEvent', { type: 'mousePressed', x: box.x, y: box.y, button: 'left', clickCount: 1, buttons: 1 });
              await cdp.send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: box.x, y: box.y, button: 'left', clickCount: 1, buttons: 0 });
              await sleep(500);
            }
          }
          const scrollers = await cdp.evaluate(SCROLLER_PROBE);
          totalScrollers += scrollers.length;
          rows.push({
            cams, theme, h, phase,
            count: scrollers.length,
            detail: scrollers.map((s) => `${s.label}(${s.scrollHeight}/${s.clientHeight})`).join(', '),
          });

          if (phase === 'rolling') {
            const ring = await ringNumbers(cdp);
            ringRows.push({ cams, theme, h, ...ring });
          }
          const clips = await clipNumbers(cdp);
          clipRows.push({ cams, theme, h, phase, clips: clips.join(' | ') });
        }
      }
    }
  }

  console.log('SCROLLER TABLE (target: count=0 everywhere)');
  console.log('cams theme  h    phase   count  detail');
  for (const r of rows) {
    console.log(
      `${String(r.cams).padEnd(4)} ${r.theme.padEnd(6)} ${String(r.h).padEnd(4)} ${r.phase.padEnd(7)} ${String(r.count).padEnd(5)}  ${r.detail}`,
    );
  }
  console.log(`\n${totalScrollers} total scrollable region(s) across ${rows.length} states.`);

  console.log('\nRING NUMBERS (while rolling, resolved off the ::after pseudo-element)');
  console.log('cams theme  h    radius  weight  inset(=safe-top+standoff)');
  for (const r of ringRows) {
    console.log(`${String(r.cams).padEnd(4)} ${r.theme.padEnd(6)} ${String(r.h).padEnd(4)} ${r.radius.padEnd(7)} ${r.weight.padEnd(7)} ${r.inset}`);
  }

  console.log('\nCLIP NUMBERS');
  for (const r of clipRows) {
    console.log(`cams=${r.cams} ${r.theme} h=${r.h} ${r.phase}: ${r.clips || '(none)'}`);
  }

  cdp.ws.close(); chrome.kill();
  if (vite) vite.kill();
  process.exit(totalScrollers > 0 ? 1 : 0);
}

main().catch((e) => { console.error(e); process.exit(1); });
