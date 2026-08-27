// Does any pricing row lose text to an ellipsis, and does the page ever
// scroll sideways? Asked at BOTH supported phone widths, because the answer
// differed between them: 390 was clean while 320 quietly truncated labels to
// a partial word.
//
// WHY THIS EXISTS AS A SCRIPT rather than a one-off check. The defect is
// invisible in code review and nearly invisible in a screenshot at the width
// you happen to test. `text-overflow: ellipsis` on a nowrap row is CORRECT
// for the short settings rows list.css was written for, and silently wrong
// the moment a label carries a number somebody needs ("4 of 10 left") or a
// value is a whole sentence. It has now been introduced twice on this
// screen. A rule broken twice is a rule worth asserting.
//
// THE RULE: a label may wrap and make its row taller. A label may never be
// truncated to make room for a price.
//
// Usage: start a dev server first (the account seam is DEV only), then
//   PORT=5199 node scripts/check-pricing-width.mjs
// Exits non-zero on any clipped row or any horizontal overflow.

import { spawn } from 'node:child_process';
import { mkdtempSync, readdirSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const PORT = Number(process.env.PORT ?? 5199);
const CDP_PORT = Number(process.env.CDP_PORT ?? 9411);
const BASE_URL = `http://localhost:${PORT}/`;

// 390 is the owner's own phone. 320 is the narrowest this app claims to
// support, and is where the truncation actually showed up, which is the
// whole reason both are checked rather than one.
const WIDTHS = [390, 320];

// The signed-in, out-of-free-projects account screen renders well over this
// many rows. The number only has to be high enough that an empty or
// half-rendered page cannot pass.
const MIN_ROWS = 8;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function chromeBinary() {
  const cache = join(process.env.HOME ?? '', 'Library/Caches/ms-playwright');
  if (existsSync(cache)) {
    const dirs = readdirSync(cache).filter((d) => d.startsWith('chromium-')).sort().reverse();
    for (const d of dirs) {
      for (const arch of ['chrome-mac-arm64', 'chrome-mac']) {
        const bin = join(cache, d, arch, 'Google Chrome for Testing.app', 'Contents', 'MacOS', 'Google Chrome for Testing');
        if (existsSync(bin)) return bin;
      }
    }
  }
  const mac = '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
  if (existsSync(mac)) return mac;
  throw new Error('no Chrome found');
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
  once(method) {
    return new Promise((resolve) => {
      const set = this.listeners.get(method) ?? new Set();
      this.listeners.set(method, set);
      const fn = (params) => { set.delete(fn); resolve(params); };
      set.add(fn);
    });
  }
  async evaluate(expression) {
    const r = await this.send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true, timeout: 15000 });
    if (r.exceptionDetails) throw new Error(r.exceptionDetails.exception?.description ?? r.exceptionDetails.text ?? 'evaluate threw');
    return r.result?.value;
  }
  // NEVER navigate to a "#/route": Page.navigate waits on
  // Page.loadEventFired, which a same-document hash change never fires, and
  // the call hangs until the harness times out. Recorded here because this
  // repo has lost two minutes to it before. Set the route via history +
  // hashchange instead, as setRoute() below does.
  async navigate(url) { await this.send('Page.navigate', { url }); await this.once('Page.loadEventFired'); }
  async setViewport(width, height) {
    await this.send('Emulation.setDeviceMetricsOverride', {
      width, height, deviceScaleFactor: 2, mobile: true, screenWidth: width, screenHeight: height,
    });
  }
}

const profile = mkdtempSync(join(tmpdir(), 'clapper-width-'));
const chrome = spawn(chromeBinary(), [
  '--headless=new',
  `--remote-debugging-port=${CDP_PORT}`,
  `--user-data-dir=${profile}`,
  '--no-first-run', '--no-default-browser-check', '--disable-gpu',
  'about:blank',
], { stdio: 'ignore' });

// The account screen behind a signed-in, out-of-free-projects account: the
// state where every paid row is on screen at once, which is the only state
// worth measuring.
const SEED = `
  (() => {
    if (typeof window.__clapperAccountDev !== 'function') return 'no-seam';
    window.__clapperAccountDev({
      signedIn: true,
      email: 'someone@example.com',
      entitlements: {
        freeProjectsUsed: 2, projectCredits: 1,
        subscriptionActive: false, subscriptionProduct: null,
      },
    });
    // CLICK THE TAB, do not set location.hash. The first version of this
    // script did the latter, and the route read back as "#/account" while
    // the page was still rendering Home: this app's router does not listen
    // for hashchange. A harness that drives the app the way a thumb does
    // cannot disagree with the app about what is on screen.
    const tab = [...document.querySelectorAll('button, [role="button"], a')]
      .find((e) => /account/i.test(e.textContent || ''));
    if (!tab) return 'no-account-tab';
    (tab.closest('button') || tab).click();
    return 'ok';
  })()
`;

// scrollWidth > clientWidth on an element whose computed overflow is hidden
// IS the ellipsis: the text is wider than the box it is allowed to occupy,
// so the browser is dropping characters. Reported with the text so a failure
// names the row rather than a selector.
const MEASURE = `
  (() => {
    const clipped = [...document.querySelectorAll('.grow-label, .grow-value, .pr-subrow__name')]
      .filter((el) => el.scrollWidth > el.clientWidth + 1)
      .map((el) => ({ text: el.textContent.trim().slice(0, 60), scrollW: el.scrollWidth, clientW: el.clientWidth }));
    return {
      innerWidth: window.innerWidth,
      scrollWidth: document.documentElement.scrollWidth,
      rows: document.querySelectorAll('.grow').length,
      route: location.hash,
      bodyText: (document.body.innerText || '').replace(/\s+/g, ' ').trim(),
      clipped,
    };
  })()
`;

// Chrome needs a moment before the debugging port answers. Polling rather
// than a fixed sleep: a fixed sleep is either slower than it needs to be or
// flaky on a loaded machine, and this has to be neither.
async function waitForCdp(port, timeoutMs = 20000) {
  const start = Date.now();
  for (;;) {
    try {
      const r = await fetch(`http://localhost:${port}/json/version`);
      if (r.ok) return;
    } catch { /* not listening yet */ }
    if (Date.now() - start > timeoutMs) throw new Error(`CDP never came up on ${port}`);
    await sleep(200);
  }
}

let failures = 0;
try {
  await waitForCdp(CDP_PORT);
  const cdp = await CDP.connectToNewPage(CDP_PORT);
  await cdp.send('Page.enable');
  await cdp.send('Runtime.enable');

  for (const width of WIDTHS) {
    await cdp.setViewport(width, 760);
    await cdp.navigate(BASE_URL);
    await sleep(1200);
    const seeded = await cdp.evaluate(SEED);
    if (seeded !== 'ok') throw new Error(`dev seam missing at ${BASE_URL} (got "${seeded}") - is this a DEV server?`);
    await sleep(900);

    const m = await cdp.evaluate(MEASURE);
    const overflows = m.scrollWidth > m.innerWidth;
    console.log(`\n${width}px  rows=${m.rows}  scrollWidth=${m.scrollWidth} innerWidth=${m.innerWidth}`);
    if (overflows) {
      failures++;
      console.log(`  FAIL page scrolls sideways by ${m.scrollWidth - m.innerWidth}px`);
    }
    if (m.clipped.length) {
      failures++;
      console.log(`  FAIL ${m.clipped.length} row(s) losing text to an ellipsis:`);
      for (const c of m.clipped) console.log(`       "${c.text}"  needs ${c.scrollW}px, has ${c.clientW}px`);
    }
    // A HARNESS THAT MEASURED NOTHING MUST NOT REPORT OK. The first run of
    // this script printed "OK nothing clipped" at both widths while rows=0,
    // because the account screen had not rendered: a green light from a
    // check that looked at an empty page is worse than no check, since it
    // is the one somebody quotes later as proof.
    if (m.rows < MIN_ROWS) {
      failures++;
      console.log(`  FAIL only ${m.rows} row(s) rendered, expected at least ${MIN_ROWS}. Nothing was measured.`);
      console.log(`       route=${m.route} bodyText="${(m.bodyText || '').slice(0, 90)}"`);
    } else if (!overflows && !m.clipped.length) {
      console.log('  OK   nothing clipped, no sideways scroll');
    }
  }
} finally {
  chrome.kill();
}

console.log(failures ? `\n${failures} failure(s)` : '\nAll widths clean');
process.exit(failures ? 1 : 0);
