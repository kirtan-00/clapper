#!/usr/bin/env node
// THE GUILLOTINE CHECK.
//
// Every harness in this repo so far has asked "does the page scroll?" and
// "did CUT move?". Both pass while the screen is still broken, because a
// fixed-height zone that is TOO SHORT for its content does not scroll and does
// not move anything - it just cuts the content off, and if the cut lands
// halfway down a line of text you get a row of half-glyphs. On a real iPhone
// that reads as a rendering fault. Kirtan filmed exactly this and called the
// UI "flimsy and glitchy".
//
// So this script asks a different question: IS ANY TEXT SLICED? For every
// element with visible text it walks up to the nearest clipping ancestor
// (overflow hidden/clip/auto, or `contain` that establishes one) and compares
// rects. A text box must be FULLY inside its clipper or FULLY outside it.
// Partially inside - by more than a 1px rounding tolerance - is a guillotine
// and is reported with the number of pixels lost.
//
// It also reports OVERLAPPING CONTROLS: two interactive elements whose rects
// intersect means one is sitting on top of the other, which is the second
// thing visible in the recordings (the tag pad passing under MARK IN / GOLD).
//
// WHY THE HEIGHTS. 844 is an iPhone Pro with NO browser chrome - a PWA added
// to the home screen. In Safari, with the URL bar and the toolbar showing, the
// same phone gives the page roughly 650-750px. The crew uses the URL. So the
// short heights are the PRIMARY case here, not the corner case: an earlier
// pass FAILED at 740 and 667, triaged it as an edge case, and shipped the bug.
//
//   node scripts/slice-check.mjs            # all heights, both themes, all rigs
//   PORT=5200 node scripts/slice-check.mjs

import { spawn } from 'node:child_process';
import { mkdtempSync, existsSync, readdirSync, writeFileSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const REPO_ROOT = fileURLToPath(new URL('..', import.meta.url));
const DEV_PORT = Number(process.env.PORT ?? 5200);
const CDP_PORT = Number(process.env.CDP_PORT ?? 9350);
const BASE_URL = `http://localhost:${DEV_PORT}/`;
const OUT_DIR = join(REPO_ROOT, '.shots/slice');

// Safari-with-chrome is the common case, so the short heights lead.
const HEIGHTS = [664, 700, 750, 800, 844, 932];

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
  async shot(p) { const { data } = await this.send('Page.captureScreenshot', { format: 'png' }); writeFileSync(p, Buffer.from(data, 'base64')); }
}

/* ------------------------------------------------------------- the probe ---
   Runs in the page. Returns { sliced: [...], overlaps: [...] }.

   TOLERANCE is 1.5px: sub-pixel layout and a mask's own soft edge routinely
   put a rect a fraction outside its clipper, and flagging that would bury the
   real cuts in noise. Anything losing more than 1.5px of a text box is a cut
   a person can see.

   A MASKED SCROLLER IS NOT A CUT. An element that can actually be scrolled, or
   that carries a mask-image/fade, is doing the honest thing: the content is
   reachable and the edge is soft. Those are skipped by design - the defect is
   an element that is clipped, unreachable AND hard-edged. */
const PROBE = `
(() => {
  // 2.5px, not 1.5. At 1.5 this reported 360 "cuts", every one of them -2px on
  // a tabular-numeral clip box - sub-pixel rounding on a font metric, not a cut
  // anybody can see. They buried the 296 real control collisions underneath
  // them. A cut worth reporting removes more than a rounding error.
  const TOL = 2.5;
  const isClipper = (el) => {
    const cs = getComputedStyle(el);
    return /hidden|clip|auto|scroll/.test(cs.overflowY + ' ' + cs.overflowX)
        || /paint|content|strict/.test(cs.contain || '');
  };
  const isSoft = (el) => {
    const cs = getComputedStyle(el);
    const masked = (cs.maskImage && cs.maskImage !== 'none') || (cs.webkitMaskImage && cs.webkitMaskImage !== 'none');
    const scrollable = el.scrollHeight - el.clientHeight > 2 || el.scrollWidth - el.clientWidth > 2;
    return masked || scrollable;
  };
  const hasOwnText = (el) => {
    for (const n of el.childNodes) if (n.nodeType === 3 && n.textContent.trim().length) return true;
    return false;
  };
  const label = (el) => (el.className && typeof el.className === 'string' ? '.' + el.className.trim().split(/\\s+/).join('.') : el.tagName.toLowerCase());

  const sliced = [];
  for (const el of document.querySelectorAll('*')) {
    if (!hasOwnText(el)) continue;
    const cs = getComputedStyle(el);
    if (cs.visibility === 'hidden' || cs.display === 'none' || parseFloat(cs.opacity) === 0) continue;
    const r = el.getBoundingClientRect();
    if (r.width < 2 || r.height < 2) continue;
    for (let p = el.parentElement; p; p = p.parentElement) {
      if (!isClipper(p)) continue;
      if (isSoft(p)) break;               // masked or scrollable: honest, not a guillotine
      const pr = p.getBoundingClientRect();
      const lostTop = pr.top - r.top, lostBottom = r.bottom - pr.bottom;
      const lostLeft = pr.left - r.left, lostRight = r.right - pr.right;
      const worst = Math.max(lostTop, lostBottom, lostLeft, lostRight);
      const fullyOut = r.bottom <= pr.top + TOL || r.top >= pr.bottom - TOL
                    || r.right <= pr.left + TOL || r.left >= pr.right - TOL;
      if (worst > TOL && !fullyOut) {
        sliced.push({
          el: label(el), clipper: label(p), lostPx: Math.round(worst),
          text: (el.textContent || '').trim().slice(0, 46),
        });
      }
      break;                               // nearest clipper decides
    }
  }

  // Two interactive controls occupying the same pixels: one is on the other.
  const SEL = 'button,a,input,select,textarea,[role="button"]';
  const ctrls = [...document.querySelectorAll(SEL)].filter((e) => {
    const cs = getComputedStyle(e), r = e.getBoundingClientRect();
    return cs.visibility !== 'hidden' && cs.display !== 'none' && parseFloat(cs.opacity) > 0
        && r.width > 4 && r.height > 4 && r.bottom > 0 && r.top < innerHeight;
  });
  /* THE VISIBLE RECT, not the layout rect. A control inside a scroller has a
     layout box that extends past the scrollport - that part of it is clipped
     away and nobody can see or press it. Comparing raw boxes therefore reports
     a "collision" between a tag key scrolled out of the pad and the sticky
     MARK IN row painted over the pad's edge, which is not a collision at all:
     it is a scroller doing its job. The slicer above already makes this
     distinction (see isSoft); the overlap check did not, and it cost a full
     agent cycle chasing 278 phantoms.

     So each control's rect is intersected with every clipping ancestor first.
     What is left is the part actually on the glass. Two of THOSE overlapping
     means one control is genuinely sitting on top of another. */
  const visibleRect = (el) => {
    let r = el.getBoundingClientRect();
    let x1 = r.left, y1 = r.top, x2 = r.right, y2 = r.bottom;
    for (let p = el.parentElement; p; p = p.parentElement) {
      if (!isClipper(p)) continue;
      const pr = p.getBoundingClientRect();
      x1 = Math.max(x1, pr.left);  y1 = Math.max(y1, pr.top);
      x2 = Math.min(x2, pr.right); y2 = Math.min(y2, pr.bottom);
    }
    // and by the viewport, which clips everything
    x1 = Math.max(x1, 0); y1 = Math.max(y1, 0);
    x2 = Math.min(x2, innerWidth); y2 = Math.min(y2, innerHeight);
    return { left: x1, top: y1, right: x2, bottom: y2, w: x2 - x1, h: y2 - y1 };
  };
  const overlaps = [];
  for (let i = 0; i < ctrls.length; i++) {
    for (let j = i + 1; j < ctrls.length; j++) {
      const a = ctrls[i], b = ctrls[j];
      if (a.contains(b) || b.contains(a)) continue;         // nesting is not collision
      const ra = visibleRect(a), rb = visibleRect(b);
      if (ra.w <= 0 || ra.h <= 0 || rb.w <= 0 || rb.h <= 0) continue;  // clipped away entirely
      const ox = Math.min(ra.right, rb.right) - Math.max(ra.left, rb.left);
      const oy = Math.min(ra.bottom, rb.bottom) - Math.max(ra.top, rb.top);
      if (ox > 2 && oy > 2) {
        overlaps.push({ a: label(a), b: label(b), area: Math.round(ox * oy),
          aText: (a.textContent||'').trim().slice(0,18), bText: (b.textContent||'').trim().slice(0,18) });
      }
    }
  }
  return { sliced, overlaps };
})()`;

const SHOTS = [
  { id: 's1', code: 'S3−01', order: 0, size: 'WS', move: 'STATIC',
    action: 'Vir parks outside the gate, wide of the mansion looming in the dark against a sky that has not decided whether to rain.' },
  { id: 's2', code: 'S3−02', order: 1, size: 'MCU', move: 'PUSH IN', action: 'He knocks on a heavy wooden door.' },
  { id: 's3', code: 'S3−03', order: 2, size: 'OTS', move: 'HANDHELD',
    action: 'Nayan, the caretaker, opens the door with a single lantern and does not step aside to let him in.' },
];

// The rigs that actually differ in HEIGHT of content, which is what this checks.
const RIGS = [
  { key: 'single', cams: 1, sound: false, shots: false, tags: 6 },
  { key: 'multi', cams: 3, sound: true, shots: false, tags: 8 },
  { key: 'script', cams: 2, sound: true, shots: true, tags: 10 },
];

async function seed(cdp, rig) {
  const cameras = rig.cams >= 2
    ? Array.from({ length: rig.cams }, (_, i) => ({ letter: 'ABCD'[i], clipPrefix: 'C', nextClipNumber: 1, clipPadding: 4 }))
    : undefined;
  const tags = ['WIDE','MID','CLOSEUP','OTS','INSERT','GOLD','PICKUP','NOISE','alarm stops','stretch / wake'].slice(0, rig.tags);
  await cdp.evaluate(`
    (async () => {
      const { store } = await import('/src/store/index.ts');
      for (const p of await store.listProjects()) await store.deleteProject(p.id);
      const proj = await store.createProject({
        name: 'Slice Test', fps: 24, clipPrefix: 'C', nextClipNumber: 1, clipPadding: 4,
        tags: ${JSON.stringify(tags)},
        ${cameras ? `cameras: ${JSON.stringify(cameras)},` : ''}
        ${rig.sound ? `sound: { filePrefix: 'SND_', nextFileNumber: 1, filePadding: 4 },` : ''}
      });
      const slate = await store.createSlate(proj.id, 'SC 3 · INT. THE MANSION');
      ${rig.shots ? `await store.updateSlate(slate.id, { shots: ${JSON.stringify(SHOTS)}, summary: 'Night exterior into the hallway, one lantern, and nobody says what the house is for.' });` : ''}
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
  await cdp.waitFor(`document.body.textContent.includes('Slice Test')`, 'home');
  await cdp.waitFor(CLICK_TEXT('Slice Test'), 'project row');
  await cdp.waitFor(`document.body.textContent.includes('SC 3')`, 'project screen');
  await cdp.waitFor(CLICK_TEXT('SC 3'), 'scene row');
  await cdp.waitFor(
    `(!!document.querySelector('.roll') || (document.querySelector('.stack .card') ? (document.querySelector('.stack .card').click(), true) : false))`,
    'roll, or the shot list on the way',
  );
  await cdp.waitFor(`document.querySelector('.roll') && document.querySelector('.bigbtn')`, 'rolling screen');
  await cdp.evaluate(`document.documentElement.setAttribute('data-theme',${JSON.stringify(theme)});true`);
  await sleep(280);
}

async function main() {
  mkdirSync(OUT_DIR, { recursive: true });
  await waitHttp(BASE_URL);
  const chrome = spawn(findChrome(), [
    `--remote-debugging-port=${CDP_PORT}`, `--user-data-dir=${mkdtempSync(join(tmpdir(), 'slice-'))}`,
    '--headless=new', '--no-first-run', '--hide-scrollbars', '--disable-gpu',
    '--force-prefers-reduced-motion', 'about:blank',
  ], { stdio: 'ignore' });
  await waitHttp(`http://localhost:${CDP_PORT}/json/version`);

  const cdp = await CDP.connect(CDP_PORT);
  await cdp.send('Page.enable'); await cdp.send('Runtime.enable');
  await cdp.viewport(390, 844);
  await cdp.navigate(BASE_URL); await sleep(800);

  let cuts = 0, collisions = 0, checks = 0;

  for (const rig of RIGS) {
    await cdp.viewport(390, 844);
    await cdp.navigate(BASE_URL); await sleep(500);
    await seed(cdp, rig);

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
              await sleep(700);
            }
          }
          const res = await cdp.evaluate(PROBE);
          checks += 1;
          const tag = `${rig.key}/${theme}/${h}/${phase}`;
          if (res.sliced.length || res.overlaps.length) {
            cuts += res.sliced.length; collisions += res.overlaps.length;
            console.log(`FAIL ${tag}`);
            for (const s of res.sliced.slice(0, 6))
              console.log(`   CUT  -${String(s.lostPx).padStart(3)}px  ${s.el} in ${s.clipper}  "${s.text}"`);
            if (res.sliced.length > 6) console.log(`   ... ${res.sliced.length - 6} more cuts`);
            for (const o of res.overlaps.slice(0, 4))
              console.log(`   OVER ${o.area}px2  ${o.a} "${o.aText}"  X  ${o.b} "${o.bText}"`);
            if (res.overlaps.length > 4) console.log(`   ... ${res.overlaps.length - 4} more overlaps`);
            await cdp.shot(join(OUT_DIR, `fail.${rig.key}.${theme}.${h}.${phase}.png`));
          } else {
            console.log(`ok   ${tag}`);
          }
        }
      }
    }
  }

  console.log(`\n${checks} states checked - ${cuts} sliced text box(es), ${collisions} control overlap(s)`);
  if (cuts || collisions) console.log(`failing screenshots in ${OUT_DIR}`);
  console.log(cuts || collisions ? 'GUILLOTINE CHECK FAILED' : 'NOTHING IS SLICED, NOTHING OVERLAPS');
  cdp.ws.close(); chrome.kill();
  process.exit(cuts || collisions ? 1 : 0);
}

main().catch((e) => { console.error(e); process.exit(1); });
