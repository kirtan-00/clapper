#!/usr/bin/env node
// Shoots landing/dashboard/index.html with FIXTURE data through the page's own
// __dashboard.showFixture hook - the same pattern landing/admin/index.html
// uses. No passphrase, no token, no network call to the edge function, and
// nothing here touches the live database.
//
// It exists because the dashboard is the one screen in this repo with no
// route through the app: it is served from a path nothing links to, behind a
// passphrase, and the only way to look at a populated version of it without
// signing into production is to hand it JSON and take a picture.
//
// Both themes and both suspension states get shot, because they are four
// genuinely different layouts: the day/night split repaints every token, and
// suspend_available flips the Users panel between live controls and a
// disabled button carrying the server's reason.
//
//   node scripts/shoot-dashboard.mjs [outDir]
import { spawn } from 'node:child_process';
import { createServer } from 'node:http';
import { mkdtempSync, mkdirSync, writeFileSync, existsSync, readdirSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, extname } from 'node:path';
import { fileURLToPath } from 'node:url';

const REPO_ROOT = fileURLToPath(new URL('..', import.meta.url));
const PORT = Number(process.env.PORT ?? 5311);
const CDP_PORT = Number(process.env.CDP_PORT ?? 9361);
const OUT_DIR = process.argv.slice(2).find((a) => !a.startsWith('--')) ?? join(REPO_ROOT, '.shots/dashboard');

const MIME = { '.html': 'text/html', '.css': 'text/css', '.js': 'text/javascript', '.svg': 'image/svg+xml', '.png': 'image/png' };

function findChrome() {
  if (process.env.CHROME_BIN && existsSync(process.env.CHROME_BIN)) return process.env.CHROME_BIN;
  const base = join(process.env.HOME ?? '', 'Library/Caches/ms-playwright');
  if (existsSync(base)) {
    const dirs = readdirSync(base).filter((d) => d.startsWith('chromium-')).sort().reverse();
    for (const d of dirs) for (const arch of ['chrome-mac-arm64', 'chrome-mac']) {
      const bin = join(base, d, arch, 'Google Chrome for Testing.app', 'Contents', 'MacOS', 'Google Chrome for Testing');
      if (existsSync(bin)) return bin;
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
  constructor(ws) { this.ws = ws; this.nextId = 1; this.pending = new Map(); this.listeners = new Map();
    ws.addEventListener('message', (ev) => this._onMessage(ev.data)); }
  static async connectToNewPage(cdpPort) {
    const res = await fetch(`http://localhost:${cdpPort}/json/new?about:blank`, { method: 'PUT' });
    const target = await res.json();
    const ws = new WebSocket(target.webSocketDebuggerUrl);
    await new Promise((resolve, reject) => { ws.addEventListener('open', resolve, { once: true }); ws.addEventListener('error', reject, { once: true }); });
    return new CDP(ws);
  }
  _onMessage(raw) { const msg = JSON.parse(raw);
    if (msg.id !== undefined && this.pending.has(msg.id)) { const { resolve, reject } = this.pending.get(msg.id); this.pending.delete(msg.id);
      if (msg.error) reject(new Error(msg.error.message)); else resolve(msg.result); }
    else if (msg.method) { const set = this.listeners.get(msg.method); if (set) for (const fn of set) fn(msg.params); } }
  send(method, params = {}) { const id = this.nextId++;
    return new Promise((resolve, reject) => { this.pending.set(id, { resolve, reject }); this.ws.send(JSON.stringify({ id, method, params })); }); }
  once(method, predicate = () => true) { return new Promise((resolve) => { const set = this.listeners.get(method) ?? new Set(); this.listeners.set(method, set);
    const fn = (params) => { if (!predicate(params)) return; set.delete(fn); resolve(params); }; set.add(fn); }); }
  async evaluate(expression) {
    const result = await this.send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true, timeout: 15000 });
    if (result.exceptionDetails) throw new Error(result.exceptionDetails.exception?.description ?? result.exceptionDetails.text ?? 'evaluate() threw');
    return result.result?.value; }
  async navigate(url) { await this.send('Page.navigate', { url }); await this.once('Page.loadEventFired'); }
  async setViewport(width, height) {
    await this.send('Emulation.setDeviceMetricsOverride', { width, height, deviceScaleFactor: 1, mobile: false, screenWidth: width, screenHeight: height }); }
  async shot(path, full = true) {
    const { data } = await this.send('Page.captureScreenshot', { format: 'png', captureBeyondViewport: full });
    writeFileSync(path, Buffer.from(data, 'base64')); }
}

// ---------------------------------------------------------------------------
// Fixture. Shaped by hand to match what dashboard-api's 'stats' action
// returns, INCLUDING the fields the write path added. Numbers are invented and
// obviously so; the point is layout, not data.
// ---------------------------------------------------------------------------
const day = (n) => new Date(Date.UTC(2026, 7, 21 + n)).toISOString().slice(0, 10);
const GUIDES = ['camera-clip-naming-conventions','circle-takes-explained','continuity-notes-guide','how-to-log-takes-on-set','how-to-read-a-clapperboard','mos-meaning-in-film','script-supervisor-duties','shot-log-to-premiere-xml','what-is-a-tcr-sheet'];
const TEMPLATES = ['camera-log-sheet','continuity-sheet-template','script-supervisor-daily-report','shot-list-template','sound-report-template'];

function fixture({ suspendAvailable, killOn = true }) {
  return {
    meta: {
      generated_at: '2026-08-26T04:40:00.000Z',
      dev_gate_cutoff: '2026-08-21T00:00:00.000Z',
      vid_cutoff: '2026-08-25T00:00:00.000Z',
      pre_cutoff_events_excluded: 1614,
      events_fetched: 2210, events_truncated: false,
      profiles_fetched: 10, profiles_truncated: false,
      exclude_self: true, owner_user_id_configured: false,
      excluded_vids_configured: false, excluded_rows_count: 96,
    },
    traffic: {
      total_views: 412, unique_visitors: 63, cta_clicks: 58,
      by_day: [0,1,2,3,4,5].map((i) => ({ day: day(i), views: [41,77,52,96,88,58][i], unique: [8,14,9,17,16,11][i] })),
      by_section: [
        { section: 'landing', views: 244, unique: 42 },
        { section: 'articles', views: 121, unique: 24 },
        { section: 'templates', views: 47, unique: 11 },
      ],
      guides: GUIDES.map((slug, i) => ({ slug, views: [31,22,18,14,11,9,7,5,4][i], unique: [7,5,4,3,3,2,2,1,1][i] })),
      templates: TEMPLATES.map((slug, i) => ({ slug, views: [17,12,8,6,4][i], unique: [4,3,2,2,1][i] })),
    },
    funnel: { stages: [
      { name: 'landing_view', unique: 63 }, { name: 'landing_cta_click', unique: 21 },
      { name: 'app_open', unique: 18 }, { name: 'project_created', unique: 9 },
      { name: 'roll', unique: 7 }, { name: 'cut', unique: 7 },
    ] },
    app_usage: {
      event_counts: [
        { name: 'app_open', count: 143 }, { name: 'screen_view', count: 512 }, { name: 'roll', count: 88 },
        { name: 'cut', count: 86 }, { name: 'moment_marked', count: 61 }, { name: 'tag_used', count: 44 },
        { name: 'project_created', count: 12 }, { name: 'persist', count: 140 }, { name: 'error', count: 3 },
      ],
      screens: [
        { screen: 'home', count: 143 }, { screen: 'rolling', count: 88 }, { screen: 'project', count: 71 },
        { screen: 'shots', count: 55 }, { screen: 'cliplog', count: 31 }, { screen: 'settings', count: 12 },
      ],
      session_ends: { total: 97, by_screen: [
        { screen: 'rolling', count: 54 }, { screen: 'project', count: 22 }, { screen: 'home', count: 21 },
      ] },
    },
    llm: {
      totals: { calls: 61, ok: 54, failed: 5, rate_limited: 2, prompt_tokens: 184220, completion_tokens: 21440 },
      by_model: [{ model: 'llama-3.3-70b-versatile', calls: 61, ok: 54, failed: 5, rate_limited: 2, prompt_tokens: 184220, completion_tokens: 21440 }],
      by_day: [0,1,2,3,4,5].map((i) => ({ day: day(i), calls: [4,11,7,18,14,7][i], ok: 0, failed: 0, rate_limited: 0, prompt_tokens: 0, completion_tokens: 0 })),
      by_user: [
        { user_id: '11111111-1111-4111-8111-111111111111', email: 'chirag@example.com', calls: 34, ok: 31, failed: 2, rate_limited: 1, prompt_tokens: 104000, completion_tokens: 12100 },
        { user_id: '22222222-2222-4222-8222-222222222222', email: 'manthan@example.com', calls: 19, ok: 17, failed: 2, rate_limited: 1, prompt_tokens: 58220, completion_tokens: 6740 },
        { user_id: 'anon', email: null, calls: 8, ok: 6, failed: 1, rate_limited: 0, prompt_tokens: 22000, completion_tokens: 2600 },
      ],
    },
    users: {
      total: 4, pro: 1, free: 3, suspended: suspendAvailable ? 1 : 0,
      suspend_available: suspendAvailable,
      suspend_unavailable_reason: suspendAvailable ? null
        : 'profiles.is_suspended does not exist yet. Apply supabase/migrations/20260826090000_profile_suspension.sql, then reload this page - the control turns itself on.',
      rows: [
        { user_id: '11111111-1111-4111-8111-111111111111', email: 'chirag@example.com', created_at: '2026-07-02T08:00:00.000Z', is_pro: true, pro_until: '2026-10-01T00:00:00.000Z', is_suspended: false, suspended_at: null, suspended_reason: null, llm_calls: 34, llm_prompt_tokens: 104000, llm_completion_tokens: 12100 },
        { user_id: '22222222-2222-4222-8222-222222222222', email: 'manthan@example.com', created_at: '2026-07-19T08:00:00.000Z', is_pro: false, pro_until: null, is_suspended: false, suspended_at: null, suspended_reason: null, llm_calls: 19, llm_prompt_tokens: 58220, llm_completion_tokens: 6740 },
        { user_id: '33333333-3333-4333-8333-333333333333', email: 'ohm@example.com', created_at: '2026-08-04T08:00:00.000Z', is_pro: false, pro_until: null, is_suspended: suspendAvailable, suspended_at: suspendAvailable ? '2026-08-25T11:00:00.000Z' : null, suspended_reason: suspendAvailable ? 'Burned 300 calls in an hour' : null, llm_calls: 6, llm_prompt_tokens: 18000, llm_completion_tokens: 2100 },
        { user_id: '44444444-4444-4444-8444-444444444444', email: null, created_at: '2026-08-22T08:00:00.000Z', is_pro: false, pro_until: null, is_suspended: false, suspended_at: null, suspended_reason: null, llm_calls: 0, llm_prompt_tokens: 0, llm_completion_tokens: 0 },
      ],
    },
    app_control: {
      script_mode_enabled: killOn,
      script_mode_daily_cap: 500,
      used_today: 61,
      day: '2026-08-26',
      malformed: [],
      pro_controls_available: true,
    },
  };
}

async function main() {
  mkdirSync(OUT_DIR, { recursive: true });

  // Static server over landing/, so the page loads at a real http origin with
  // working storage rather than file://.
  const server = createServer((req, res) => {
    const url = new URL(req.url, 'http://x');
    let p = join(REPO_ROOT, 'landing', decodeURIComponent(url.pathname));
    if (url.pathname.endsWith('/')) p = join(p, 'index.html');
    if (!existsSync(p)) { res.writeHead(404); res.end('nope'); return; }
    res.writeHead(200, { 'Content-Type': MIME[extname(p)] ?? 'application/octet-stream' });
    res.end(readFileSync(p));
  });
  await new Promise((r) => server.listen(PORT, r));
  const BASE = `http://localhost:${PORT}/dashboard/`;
  await waitForHttp(BASE);

  const userDataDir = mkdtempSync(join(tmpdir(), 'clapper-dash-'));
  const chrome = spawn(findChrome(), [`--remote-debugging-port=${CDP_PORT}`, `--user-data-dir=${userDataDir}`,
    '--headless=new', '--no-first-run', '--no-default-browser-check', '--hide-scrollbars',
    '--disable-gpu', '--force-prefers-reduced-motion', 'about:blank'], { stdio: 'ignore' });
  await waitForHttp(`http://localhost:${CDP_PORT}/json/version`);
  const cdp = await CDP.connectToNewPage(CDP_PORT);
  await cdp.send('Page.enable'); await cdp.send('Runtime.enable');

  // Console errors are collected for the whole run. A panel can render and
  // still be throwing on every draw; the picture would not show it.
  const consoleErrors = [];
  cdp.listeners.set('Runtime.consoleAPICalled', new Set([(p) => {
    if (p.type === 'error') consoleErrors.push((p.args || []).map((a) => a.value ?? a.description ?? '').join(' '));
  }]));
  cdp.listeners.set('Runtime.exceptionThrown', new Set([(p) => {
    consoleErrors.push(p.exceptionDetails?.exception?.description ?? p.exceptionDetails?.text ?? 'exception');
  }]));

  const written = [];
  const cases = [
    { name: 'night.no-migration', theme: 'night', fx: fixture({ suspendAvailable: false }) },
    { name: 'night.migrated', theme: 'night', fx: fixture({ suspendAvailable: true }) },
    { name: 'day.migrated', theme: 'day', fx: fixture({ suspendAvailable: true }) },
    { name: 'night.killed', theme: 'night', fx: fixture({ suspendAvailable: true, killOn: false }) },
  ];

  for (const c of cases) {
    await cdp.setViewport(1000, 900);
    await cdp.navigate(BASE);
    await sleep(300);
    await cdp.evaluate(`(() => {
      document.documentElement.${c.theme === 'day' ? "setAttribute('data-theme','day')" : "removeAttribute('data-theme')"};
      window.__dashboard.showFixture(${JSON.stringify(c.fx)});
      return true; })()`);
    await sleep(250);
    const f = join(OUT_DIR, `${c.name}.png`); await cdp.shot(f); written.push(f);

    // Panel inventory, printed so a regression in the read path is visible in
    // the log and not only in a picture nobody diffed.
    const inv = await cdp.evaluate(`
      (() => ({
        cards: [...document.querySelectorAll('.card h2')].map(h => h.textContent.trim()),
        subs: [...document.querySelectorAll('h3.sub-h')].map(h => h.textContent.trim()),
        banners: document.querySelectorAll('.banner').length,
        controls: document.querySelectorAll('[data-arm],[data-do]').length,
        disabledSuspend: document.querySelectorAll('button[disabled][title]').length,
        // Does the Users table overflow its own scroll container? Anything
        // above zero means a control is off-screen until you scroll for it.
        tableOverflowPx: (() => { const t = document.querySelector('.table-scroll');
          return t ? Math.max(0, t.scrollWidth - t.clientWidth) : null; })(),
        bodyOverflowPx: Math.max(0, document.documentElement.scrollWidth - document.documentElement.clientWidth),
      }))()`);
    console.log(c.name, JSON.stringify(inv));
  }

  // The armed half of the two consequential controls, shot through the page's
  // own arm() - the same function a click calls.
  for (const [label, kind, id] of [
    ['armed.suspend', 'suspend', '22222222-2222-4222-8222-222222222222'],
    ['armed.set_free', 'set_free', '11111111-1111-4111-8111-111111111111'],
    ['armed.kill', 'kill', null],
  ]) {
    await cdp.navigate(BASE);
    await sleep(300);
    await cdp.evaluate(`(() => {
      window.__dashboard.showFixture(${JSON.stringify(fixture({ suspendAvailable: true }))});
      window.__dashboard.arm(${JSON.stringify(kind)}, ${JSON.stringify(id)});
      return true; })()`);
    await sleep(250);
    const shown = await cdp.evaluate(`
      (() => { const n = document.querySelector('.confirm'); return n ? n.textContent.replace(/\\s+/g,' ').trim().slice(0,160) : null; })()`);
    console.log(label, '->', shown);
    const f = join(OUT_DIR, `${label}.png`); await cdp.shot(f); written.push(f);
  }

  // A phone-width pass. This page is read on a laptop most of the time, but
  // it is part of a phone-first product and the one thing a narrow layout
  // must never do is push the document sideways - see the Users table note
  // in the page's own CSS for how that went the first time.
  for (const w of [390, 520]) {
    await cdp.setViewport(w, 900);
    await cdp.navigate(BASE);
    await sleep(300);
    await cdp.evaluate(`(() => { window.__dashboard.showFixture(${JSON.stringify(fixture({ suspendAvailable: true }))}); return true; })()`);
    await sleep(250);
    const m = await cdp.evaluate(`
      (() => ({ bodyOverflowPx: Math.max(0, document.documentElement.scrollWidth - document.documentElement.clientWidth),
                tableOverflowPx: (() => { const t = document.querySelector('.table-scroll'); return t ? Math.max(0, t.scrollWidth - t.clientWidth) : null; })(),
                cards: document.querySelectorAll('.card h2').length,
                controls: document.querySelectorAll('[data-arm],[data-do]').length }))()`);
    console.log(`narrow.${w}`, JSON.stringify(m));
    const f = join(OUT_DIR, `narrow.${w}.png`); await cdp.shot(f); written.push(f);

    // The confirm strip is the piece most likely to break at this width: it
    // spans every column of a table that scrolls, so it is the one thing that
    // has to stay pinned or the buttons leave the screen.
    await cdp.evaluate(`(() => { window.__dashboard.arm('suspend', '22222222-2222-4222-8222-222222222222'); return true; })()`);
    await sleep(200);
    const cw = await cdp.evaluate(`
      (() => { const n = document.querySelector('.confirm'); if (!n) return null;
        const r = n.getBoundingClientRect();
        return { left: Math.round(r.left), right: Math.round(r.right), fitsViewport: r.right <= innerWidth + 1 && r.left >= -1 }; })()`);
    console.log(`narrow.${w}.confirm`, JSON.stringify(cw));
    const g = join(OUT_DIR, `narrow.${w}.armed.png`); await cdp.shot(g); written.push(g);
  }
  await cdp.setViewport(1000, 900);

  // The toast, driven straight at the node. It is fixed-position and only
  // ever appears after a write, which this harness deliberately never makes -
  // so it is painted here rather than left as the one piece of UI nobody
  // looked at.
  await cdp.navigate(BASE);
  await sleep(300);
  await cdp.evaluate(`(() => {
    window.__dashboard.showFixture(${JSON.stringify(fixture({ suspendAvailable: true }))});
    const t = document.getElementById('toast');
    t.textContent = 'Suspended.'; t.className = 'toast'; t.hidden = false;
    scrollTo(0, 0); return true; })()`);
  await sleep(200);
  { const f = join(OUT_DIR, 'toast.png'); await cdp.shot(f, false); written.push(f); }

  console.log(`\n${written.length} shots -> ${OUT_DIR}`);
  console.log(consoleErrors.length ? `CONSOLE ERRORS (${consoleErrors.length}):\n` + consoleErrors.join('\n') : 'console: clean');
  cdp.ws.close(); chrome.kill(); server.close();
}
main().catch((err) => { console.error(err); process.exit(1); });
