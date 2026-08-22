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
      // Merged in from feat/newproject-stages: AppShell now mounts a global,
      // once-ever "first open" sheet (src/ui/Onboarding.tsx) that would
      // otherwise sit on top of every screen this script shoots. Mark it (and
      // the install nudge it folded in) already answered, the same way
      // scripts/shoot-onboarding.mjs's own "home-after-skip" checkpoint does.
      localStorage.setItem('clapper.onboardingDone', '1');
      localStorage.setItem('clapper.installNudgeDismissed', '1');
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
      // Real takes, so the clip log is a log of something. Mixed on purpose:
      // gold, discarded, tagged, across two scenes and both cameras.
      // startedAt is REQUIRED on TakeInput — omit it and every wall clock in the
      // log renders NaN:NaN:NaN, which looks exactly like an app bug and is not.
      // Staggered off a fixed base so the shots are deterministic and the times
      // read like a real morning rather than six identical stamps.
      let clock = new Date(2026, 7, 21, 9, 12, 0).getTime();
      const mk = async (slateId, shotId, tags, status, dur) => {
        clock += dur + 240000;
        const t = await store.createTake({ projectId: a.id, slateId, shotId, durationMs: dur, startedAt: clock });
        if (tags || status) await store.updateTake(t.id, { ...(tags?{tags}:{}) , ...(status?{status}:{}) });
        return t;
      };
      await mk(s1.id, 's1', ['WIDE'], undefined, 42000);
      await mk(s1.id, 's1', ['WIDE','GOLD'], undefined, 61000);
      await mk(s1.id, 's1', ['NOISE'], 'discarded', 8000);
      await mk(s1.id, 's2', ['OTS'], undefined, 37000);
      await mk(s1.id, 's2', ['OTS','GOLD'], undefined, 55000);
      await mk(s1.id, undefined, ['CU'], undefined, 29000);
      await store.createProject({ name: 'Okkai Hero Film', fps: 25, clipPrefix: 'C', nextClipNumber: 1, clipPadding: 4, tags: ['WIDE','CU','GOLD'] });
      await store.createProject({ name: 'Palladium Spot', fps: 24, clipPrefix: 'C', nextClipNumber: 1, clipPadding: 4, tags: ['WIDE','CU'] });

      // ---------------------------------------------------------------------
      // THE PROJECTS-SCREEN REBUILD'S OWN SEED. Twelve projects minimum, per
      // the brief: a mix of with/without a shot list, several mid-shoot, one
      // wrapped, varying day numbers — so the progress bar, the "no shot
      // list" flag, the "Wrapped" flag and the day/recency lines all have
      // something real to prove themselves against, not just the three
      // projects above (all day-1-or-less, none with a completed shot list).
      const { wrapShootDay } = await import('/src/store/util.ts');

      /** Advance a project N wrap cycles with NO take logged in between, so
       *  the project lands on a fresh, untouched day N+1 — exactly what
       *  WRAP DAY does on a real set when nothing has rolled yet today. */
      async function wrapForward(projectId, times) {
        for (let i = 0; i < times; i++) {
          const p = await store.getProject(projectId);
          const { project: next } = wrapShootDay(p, Date.now());
          await store.updateProject(projectId, next);
        }
      }

      /** A scene with a shot breakdown: KEPT of shots.length shots get a
       *  KEPT take, the rest get none — so shotsInCan / scenesLeft land
       *  exactly where the caller wants them, not wherever random chance
       *  puts them. */
      async function shotScene(projectId, name, shots, kept) {
        const slate = await store.createSlate(projectId, name);
        const built = shots.map((code, i) => ({ id: slate.id + '-sh' + i, code, order: i }));
        await store.updateSlate(slate.id, { shots: built });
        for (let i = 0; i < built.length; i++) {
          if (i < kept) {
            await store.createTake({ projectId, slateId: slate.id, shotId: built[i].id, durationMs: 30000, startedAt: Date.now() });
          }
        }
        return slate;
      }

      /** A bare scene (no breakdown): N takes logged straight against it. */
      async function bareScene(projectId, name, n, discards = 0) {
        const slate = await store.createSlate(projectId, name);
        for (let i = 0; i < n; i++) {
          const t = await store.createTake({ projectId, slateId: slate.id, durationMs: 20000, startedAt: Date.now() });
          if (i < discards) await store.updateTake(t.id, { status: 'discarded' });
        }
        return slate;
      }

      // "The Last Monsoon" — mid-shoot, DAY 3, a real shot list at 14/22
      // (the exact worked example from the brief): two scenes still short of
      // a full breakdown so "2 scenes left" reads true, three already clean.
      {
        const p = await store.createProject({ name: 'The Last Monsoon', fps: 24, clipPrefix: 'C', nextClipNumber: 1, clipPadding: 4, tags: ['WIDE','CU','GOLD'] });
        await wrapForward(p.id, 2); // day 1 -> day 3, untouched
        await shotScene(p.id, 'INT. HOUSE — MORNING', ['1.1','1.2','1.3','1.4'], 4);
        await shotScene(p.id, 'EXT. FIELD — DAY', ['2.1','2.2','2.3','2.4','2.5'], 2);
        await shotScene(p.id, 'INT. TEMPLE — DUSK', ['3.1','3.2','3.3','3.4','3.5','3.6'], 1);
        await shotScene(p.id, 'EXT. RIVER — NIGHT', ['4.1','4.2','4.3','4.4'], 4);
        await shotScene(p.id, 'INT. HOUSE — NIGHT', ['5.1','5.2','5.3'], 3);
        // A handful of extra takes on shots already in the can — retakes and
        // one discard — so the take COUNT is well past the shot count, the
        // same way a real day's log always is.
        const extra = await store.listSlates(p.id);
        for (let i = 0; i < 6; i++) {
          const t = await store.createTake({ projectId: p.id, slateId: extra[i % extra.length].id, durationMs: 25000, startedAt: Date.now() });
          if (i === 0) await store.updateTake(t.id, { status: 'discarded' });
        }
      }

      // "Bhoot Ki Kahani" — the brief's OTHER worked example, verbatim: no
      // shot list anywhere, Day 1, 17 takes, 3 scenes.
      {
        const p = await store.createProject({ name: 'Bhoot Ki Kahani', fps: 24, clipPrefix: 'C', nextClipNumber: 1, clipPadding: 4, tags: ['WIDE','CU'] });
        await bareScene(p.id, 'Scene 1', 7, 1);
        await bareScene(p.id, 'Scene 2', 6, 1);
        await bareScene(p.id, 'Scene 3', 4, 0);
      }

      // "Coffee & Kismet" — WRAPPED with every scene covered: the bar reads
      // full, the caption reads "every scene covered", and the Wrapped flag
      // sits right next to the name. Proves the bar and the flag are
      // independent facts that can both be true at once.
      {
        const p = await store.createProject({ name: 'Coffee & Kismet', fps: 25, clipPrefix: 'C', nextClipNumber: 1, clipPadding: 4, tags: ['WIDE','CU'] });
        await shotScene(p.id, 'INT. CAFE — DAY', ['1.1','1.2','1.3'], 3);
        await shotScene(p.id, 'EXT. STREET — DAY', ['2.1','2.2','2.3'], 3);
        await wrapForward(p.id, 1); // day 1 -> day 2, untouched: WRAPPED
      }

      // "Summer Break" — a shot list barely started: DAY 1, low completion,
      // proves the bar reads correctly near-empty too, not just near-full.
      {
        const p = await store.createProject({ name: 'Summer Break', fps: 24, clipPrefix: 'C', nextClipNumber: 1, clipPadding: 4, tags: ['WIDE','CU'] });
        await shotScene(p.id, 'EXT. BEACH — DAY', ['1.1','1.2','1.3','1.4'], 1);
        await shotScene(p.id, 'INT. VAN — DAY', ['2.1','2.2','2.3'], 0);
        await shotScene(p.id, 'EXT. CAMPFIRE — NIGHT', ['3.1','3.2','3.3'], 0);
      }

      // "The Long Wait" — no shot list, WRAPPED, DAY 4: proves the Wrapped
      // flag and the "no shot list" flag can both be true on the same row,
      // and gives the list a second, higher day number.
      {
        const p = await store.createProject({ name: 'The Long Wait', fps: 24, clipPrefix: 'C', nextClipNumber: 1, clipPadding: 4, tags: ['WIDE','CU'] });
        await bareScene(p.id, 'Scene 1', 9, 2);
        await wrapForward(p.id, 1);
        await bareScene(p.id, 'Scene 2', 7, 0);
        await wrapForward(p.id, 1);
        await bareScene(p.id, 'Scene 3', 5, 1);
        await wrapForward(p.id, 1); // day 4, untouched: WRAPPED
      }

      // "Ashes & Neon" — DAY 5, one scene short of a full shot list: proves
      // the bar and "N scenes left" both still read right at the high end,
      // not just at 14/22.
      {
        const p = await store.createProject({ name: 'Ashes & Neon', fps: 24, clipPrefix: 'C', nextClipNumber: 1, clipPadding: 4, tags: ['WIDE','CU','GOLD'] });
        await wrapForward(p.id, 4); // day 1 -> day 5, untouched
        await shotScene(p.id, 'INT. CLUB — NIGHT', ['1.1','1.2','1.3'], 3);
        await shotScene(p.id, 'EXT. ALLEY — NIGHT', ['2.1','2.2','2.3'], 3);
        await shotScene(p.id, 'INT. GREEN ROOM — NIGHT', ['3.1','3.2','3.3','3.4'], 3);
      }

      // "Quiet Riot Ad" — a shot list attached, but NOTHING shot yet: proves
      // the bar can sit at a real 0% (0/7 shots) rather than being hidden
      // just because nothing has rolled.
      {
        const p = await store.createProject({ name: 'Quiet Riot Ad', fps: 24, clipPrefix: 'C', nextClipNumber: 1, clipPadding: 4, tags: ['WIDE','CU'] });
        await shotScene(p.id, 'INT. STUDIO — DAY', ['1.1','1.2','1.3'], 0);
        await shotScene(p.id, 'INT. STUDIO — DAY (CU)', ['2.1','2.2','2.3','2.4'], 0);
      }

      // "Diwali Campaign" — no shot list AND nothing shot yet: the OTHER
      // zero-take case, so the two never get confused for one another.
      {
        const p = await store.createProject({ name: 'Diwali Campaign', fps: 24, clipPrefix: 'C', nextClipNumber: 1, clipPadding: 4, tags: ['WIDE','CU'] });
        await store.createSlate(p.id, 'Scene 1');
        await store.createSlate(p.id, 'Scene 2');
      }

      // "Rooftop Sessions" — no shot list, DAY 7: the widest day number on
      // the list, proving the recency/day facts hold up on a long shoot.
      {
        const p = await store.createProject({ name: 'Rooftop Sessions', fps: 24, clipPrefix: 'C', nextClipNumber: 1, clipPadding: 4, tags: ['WIDE','CU'] });
        await wrapForward(p.id, 6); // day 1 -> day 7
        await bareScene(p.id, 'Scene 1', 8, 1);
        await bareScene(p.id, 'Scene 2', 6, 0);
        await bareScene(p.id, 'Scene 3', 4, 1);
        await bareScene(p.id, 'Scene 4', 3, 0);
      }

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

    // PROJECTS SEARCH, ACTIVE — a query typed into `.pj-search`, set through
    // React's own native-input setter (a plain `.value =` never fires
    // React's onChange) so the screen re-renders exactly as it would for a
    // real keystroke, not a scripted shortcut around one.
    await cdp.evaluate(`
      (() => {
        const el = document.querySelector('.pj-search');
        if (!el) return false;
        const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set;
        setter.call(el, 'monsoon');
        el.dispatchEvent(new Event('input', { bubbles: true }));
        return true;
      })()
    `);
    await sleep(300);
    await take('01c-projects-search', theme);
    await cdp.evaluate(`
      (() => {
        const el = document.querySelector('.pj-search');
        if (!el) return false;
        const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set;
        setter.call(el, '');
        el.dispatchEvent(new Event('input', { bubbles: true }));
        return true;
      })()
    `);
    await sleep(200);

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

    // CLIP LOG — reached from the project screen. Navigate home first: the tab
    // tray is UNMOUNTED on the rolling screen, so there is no tab to tap.
    await cdp.navigate(BASE_URL);
    await setTheme(cdp, theme);
    await sleep(600);
    await cdp.waitForExpr(TAB('Projects'), { desc: 'projects tab' });
    await cdp.waitForExpr(CLICK_BY_TEXT("No Mans Hero"), { desc: 'project row' });
    await cdp.waitForExpr(`document.body.textContent.includes('Scene 1')`, { desc: 'project screen' });
    await setTheme(cdp, theme);
    // Label changed from "Every clip rolled" to "All rolled" when the shoot
    // day actions became a 2x2 icon tile grid (feat/app-shell 6321531).
    if (await cdp.evaluate(CLICK_BY_TEXT('All rolled'))) {
      await cdp.waitForExpr(`!!document.querySelector('.mclip')`, { desc: 'clip log' });
      await sleep(700);
      await take('07-cliplog', theme);
      // and the fix-a-clip sheet, which is the whole point of the screen
      if (await cdp.evaluate(`(()=>{const t=document.querySelector('.mclip__tool--fix')||document.querySelector('.mclip__face');if(!t)return false;t.click();return true;})()`)) {
        await sleep(800);
        await take('08-clipfix', theme);
      }
    }

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
