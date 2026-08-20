#!/usr/bin/env node
/**
 * contrast-audit.mjs — the rendered-app contrast auditor for the frosted material.
 *
 * WHY THIS EXISTS
 * Token arithmetic cannot answer the only question that matters about a
 * translucent bar: what is BEHIND it. That is whatever the list happens to be
 * showing, blurred, saturated and brightened by `backdrop-filter`. So this
 * script drives the real built app, scrolls real content under every material
 * surface, makes the type on those surfaces transparent, screenshots, and reads
 * the pixels left inside each text node's own rectangle. Those pixels ARE the
 * composited backdrop. Everything else is a guess.
 *
 * IT MEASURES THE TREE IT BUILT, OR IT DIES
 * A previous version of this script was pointed at a dead worktree and compared
 * a stale `dist` to itself, so it could return clean on a tree nobody was
 * running. Three guards now make that impossible:
 *   1. ROOT is resolved from this file's own location, so it always audits the
 *      checkout it is committed in - never a sibling worktree, never a path
 *      somebody typed.
 *   2. It runs `npm run build` itself by default, and with `--no-build` it
 *      refuses to run if any file under src/ is newer than dist/index.html.
 *   3. It asserts the bundle filename the BROWSER actually loaded against the
 *      one dist/index.html names, after clearing the service worker and its
 *      caches, waiting, and navigating again as a separate step.
 * The banner prints the resolved root, the git rev and whether the tree is
 * dirty, so a run can never be mistaken for a run of something else.
 *
 * WHAT IT REPORTS
 *   A. BAND DELTA - how far the material actually moves with content behind it.
 *      Each surface is rendered twice at the same scroll position: once as
 *      built, once with `backdrop-filter: none` and the opaque fallback token.
 *      The difference in mean luminance is the whole claim "this reads as
 *      glass". The spec's baseline measurement was ~3 levels of grey, which is
 *      technically present and visually absent.
 *   B. CONTRAST - WCAG ratio of every text node sitting on a material surface,
 *      against the sampled backdrop. Reports the MEAN ratio and the adverse
 *      tail (P10: the 10th percentile of the per-pixel ratios inside the
 *      rectangle) so a saturated chip or a REC dot sliding under tray text
 *      counts rather than being averaged away. P10 is the number that fails.
 *
 * USAGE
 *   node scripts/contrast-audit.mjs                 # build, then audit
 *   node scripts/contrast-audit.mjs --no-build      # audit the existing dist
 *   node scripts/contrast-audit.mjs --shots DIR     # also save the frames
 *   node scripts/contrast-audit.mjs --theme light   # one theme only
 *   node scripts/contrast-audit.mjs --headed        # watch it drive
 *
 * Requires playwright-core and a Chrome install. If playwright-core is not a
 * dependency of this repo (it is not, deliberately - this is a dev tool, not a
 * shipped one), point PLAYWRIGHT_PATH at a node_modules that has it:
 *   PLAYWRIGHT_PATH=/tmp/pw/node_modules node scripts/contrast-audit.mjs
 *
 * Exit code 1 if any text node on a material surface is below its WCAG bar.
 */
import fs from 'node:fs';
import path from 'node:path';
import http from 'node:http';
import { execSync } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';

// ---------------------------------------------------------------- the tree --

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '..');
const DIST = path.join(ROOT, 'dist');
const SRC = path.join(ROOT, 'src');

const argv = process.argv.slice(2);
const flag = (name) => argv.includes(name);
const opt = (name, dflt) => {
  const i = argv.indexOf(name);
  return i >= 0 && argv[i + 1] ? argv[i + 1] : dflt;
};

const THEMES = opt('--theme') ? [opt('--theme')] : ['light', 'night'];
const SHOTS = opt('--shots', null);
const PORT = +opt('--port', 4188);

function die(msg) {
  console.error('\n  FATAL  ' + msg + '\n');
  process.exit(2);
}

function git(cmd) {
  try {
    return execSync(`git ${cmd}`, { cwd: ROOT, encoding: 'utf8' }).trim();
  } catch {
    return '(no git)';
  }
}

// The audit is worthless if the bundle it loads was built from different
// source. Newest mtime under src/ against dist/index.html, and name the file.
function assertFresh() {
  if (!fs.existsSync(path.join(DIST, 'index.html'))) {
    die(`no dist/index.html under ${ROOT}. Run without --no-build, or npm run build first.`);
  }
  const built = fs.statSync(path.join(DIST, 'index.html')).mtimeMs;
  let newest = { file: null, t: 0 };
  const walk = (dir) => {
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
      const p = path.join(dir, e.name);
      if (e.isDirectory()) walk(p);
      else {
        const t = fs.statSync(p).mtimeMs;
        if (t > newest.t) newest = { file: p, t };
      }
    }
  };
  walk(SRC);
  for (const extra of ['index.html', 'vite.config.ts', 'package.json']) {
    const p = path.join(ROOT, extra);
    if (fs.existsSync(p)) {
      const t = fs.statSync(p).mtimeMs;
      if (t > newest.t) newest = { file: p, t };
    }
  }
  if (newest.t > built) {
    die(
      `STALE DIST. ${path.relative(ROOT, newest.file)} is newer than dist/index.html.\n` +
        `         The tree this would measure is not the tree it was built from.\n` +
        `         Drop --no-build, or run: npm run build`
    );
  }
}

function build() {
  console.error('  building ' + ROOT + ' ...');
  execSync('npm run build', { cwd: ROOT, stdio: ['ignore', 'ignore', 'inherit'] });
}

// ------------------------------------------------------------- the server --

const MIME = {
  '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css',
  '.json': 'application/json', '.svg': 'image/svg+xml', '.png': 'image/png',
  '.webmanifest': 'application/manifest+json', '.txt': 'text/plain',
  '.xml': 'application/xml', '.ico': 'image/x-icon',
};

function serve(port) {
  const server = http.createServer((req, res) => {
    let p = decodeURIComponent(req.url.split('?')[0]);
    if (p === '/') p = '/index.html';
    let file = path.join(DIST, p);
    if (!fs.existsSync(file) || fs.statSync(file).isDirectory()) file = path.join(DIST, 'index.html');
    res.writeHead(200, {
      'Content-Type': MIME[path.extname(file)] || 'application/octet-stream',
      'Cache-Control': 'no-store',
      'Service-Worker-Allowed': '/',
    });
    fs.createReadStream(file).pipe(res);
  });
  return new Promise((resolve) => server.listen(port, () => resolve(server)));
}

const expectedBundle = () =>
  fs.readFileSync(path.join(DIST, 'index.html'), 'utf8').match(/assets\/index-[A-Za-z0-9_-]+\.js/)[0];

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// -------------------------------------------------------------- playwright --

async function loadPlaywright() {
  const tries = [
    'playwright-core',
    process.env.PLAYWRIGHT_PATH && path.join(process.env.PLAYWRIGHT_PATH, 'playwright-core/index.js'),
  ].filter(Boolean);
  for (const t of tries) {
    try {
      const m = await import(t.startsWith('/') ? pathToFileURL(t).href : t);
      // playwright-core is CJS, so importing it by path yields { default: ... }
      const api = m.chromium ? m : m.default;
      if (api && api.chromium) return api;
    } catch { /* next */ }
  }
  die(
    'playwright-core not found. Install it somewhere and point PLAYWRIGHT_PATH at\n' +
      '         that node_modules, e.g.\n' +
      '           mkdir -p /tmp/pw && cd /tmp/pw && npm i playwright-core\n' +
      '           PLAYWRIGHT_PATH=/tmp/pw/node_modules node scripts/contrast-audit.mjs'
  );
}

// ------------------------------------------------------- in-page collectors --

const MATERIAL = ['.tabtray', '.ltop', '.topbar', '.sheet__head'];

/** Every text node sitting ON a material surface, with its rect and colour. */
const COLLECT = (surfaces) => {
  const out = [];
  for (const sel of surfaces) {
    for (const surf of document.querySelectorAll(sel)) {
      const sr = surf.getBoundingClientRect();
      if (sr.width < 2 || sr.height < 2) continue;
      for (const el of surf.querySelectorAll('*')) {
        const own = [...el.childNodes]
          .filter((n) => n.nodeType === 3 && n.textContent.trim())
          .map((n) => n.textContent.trim())
          .join(' ');
        if (!own) continue;
        const cs = getComputedStyle(el);
        if (cs.visibility === 'hidden' || cs.display === 'none' || +cs.opacity === 0) continue;
        const r = el.getBoundingClientRect();
        if (r.width < 3 || r.height < 3) continue;
        out.push({
          surface: sel,
          text: own.slice(0, 30),
          color: cs.color,
          px: Math.round(parseFloat(cs.fontSize) * 10) / 10,
          weight: +cs.fontWeight,
          rect: { x: r.x, y: r.y, w: r.width, h: r.height },
        });
      }
    }
  }
  return out;
};

/** The rect of each material surface actually on screen. */
const BANDS = (surfaces) => {
  const out = [];
  for (const sel of surfaces) {
    for (const surf of document.querySelectorAll(sel)) {
      const r = surf.getBoundingClientRect();
      if (r.width < 8 || r.height < 8) continue;
      if (r.bottom < 0 || r.top > window.innerHeight) continue;
      out.push({ surface: sel, rect: { x: r.x, y: r.y, w: r.width, h: r.height } });
    }
  }
  return out;
};

const HIDE_TYPE = MATERIAL.map((s) => `${s} *`).join(', ') +
  ` { color: transparent !important; -webkit-text-fill-color: transparent !important; }\n` +
  MATERIAL.map((s) => `${s} svg`).join(', ') + ` { visibility: hidden !important; }\n` +
  MATERIAL.map((s) => `${s} *::before, ${s} *::after`).join(', ') +
  ` { opacity: 0 !important; }`;

/* The A/B for the band delta: kill the blur and raise the tint to the opaque
   fallback, which is exactly what the surface would be if the material were
   not there. Everything behind stays put, so the difference is the material. */
const FLATTEN = MATERIAL.join(', ') +
  ` { backdrop-filter: none !important; -webkit-backdrop-filter: none !important; }\n` +
  `.tabtray, .ltop, .topbar { background: var(--material-solid) !important; }\n` +
  `.sheet__head { background: var(--material-cap-solid) !important; }`;

// ------------------------------------------------------------ pixel reading --

const parseColor = (css) => {
  const m = css.match(/rgba?\(([\d.]+),\s*([\d.]+),\s*([\d.]+)(?:,\s*([\d.]+))?\)/);
  if (!m) return null;
  return [+m[1], +m[2], +m[3], m[4] === undefined ? 1 : +m[4]];
};

/* PNG decoding and all the pixel arithmetic happen INSIDE a blank Chrome page:
   canvas is the decoder, so this script needs no image dependency at all, and
   shipping a 780x1344 frame back over CDP as a JS array (four million numbers,
   twice per frame) is what made the first version take minutes. Only the
   per-rect statistics cross the boundary. */
async function makeLab(browser) {
  const ctx = await browser.newContext();
  const page = await ctx.newPage();
  await page.setContent('<canvas id="a"></canvas><canvas id="b"></canvas>');
  await page.evaluate(() => {
    window.__put = async (which, b64) => {
      const img = new Image();
      img.src = 'data:image/png;base64,' + b64;
      await img.decode();
      const c = document.getElementById(which);
      c.width = img.naturalWidth;
      c.height = img.naturalHeight;
      const g = c.getContext('2d', { willReadFrequently: true });
      g.drawImage(img, 0, 0);
      window['__' + which] = g.getImageData(0, 0, c.width, c.height);
    };
    window.__box = (img, rect, dsf) => ({
      x0: Math.max(0, Math.round(rect.x * dsf)),
      y0: Math.max(0, Math.round(rect.y * dsf)),
      x1: Math.min(img.width, Math.round((rect.x + rect.w) * dsf)),
      y1: Math.min(img.height, Math.round((rect.y + rect.h) * dsf)),
    });
    const srgb = (v) => { v /= 255; return v <= 0.04045 ? v / 12.92 : Math.pow((v + 0.055) / 1.055, 2.4); };
    window.__lum = (r, g, b) => 0.2126 * srgb(r) + 0.7152 * srgb(g) + 0.0722 * srgb(b);
    window.__ratio = (p, q) => {
      const a = window.__lum(p[0], p[1], p[2]);
      const b = window.__lum(q[0], q[1], q[2]);
      return a > b ? (a + 0.05) / (b + 0.05) : (b + 0.05) / (a + 0.05);
    };
  });
  return {
    put: (which, buf) => page.evaluate(([w, b]) => window.__put(w, b), [which, buf.toString('base64')]),

    /** Band delta: the A frame against the B frame, over each surface rect. */
    bands: (rects, dsf) => page.evaluate(([rects, dsf]) => {
      const A = window.__a, B = window.__b;
      return rects.map((r) => {
        const q = window.__box(A, r.rect, dsf);
        let sa = 0, sb = 0, n = 0, sd = 0;
        const diffs = [];
        for (let y = q.y0; y < q.y1; y++) {
          for (let x = q.x0; x < q.x1; x++) {
            const i = (y * A.width + x) * 4;
            const ga = (A.data[i] + A.data[i + 1] + A.data[i + 2]) / 3;
            const gb = (B.data[i] + B.data[i + 1] + B.data[i + 2]) / 3;
            sa += ga; sb += gb; n++;
            const d = Math.abs(ga - gb);
            sd += d; diffs.push(d);
          }
        }
        if (!n) return null;
        diffs.sort((p, s) => p - s);
        const r1 = (v) => Math.round(v * 10) / 10;
        return {
          surface: r.surface,
          flat: r1(sb / n), live: r1(sa / n), shift: r1((sa - sb) / n),
          move: Math.round((sd / n) * 100) / 100,
          p95: r1(diffs[Math.floor(diffs.length * 0.95)]),
          max: r1(diffs[diffs.length - 1]),
        };
      }).filter(Boolean);
    }, [rects, dsf]),

    /** Contrast: for each text rect, the mean backdrop and the P10 adverse
        tail of the per-pixel ratio, sampled off the type-hidden frame. */
    contrast: (targets, dsf) => page.evaluate(([targets, dsf]) => {
      const A = window.__a;
      return targets.map((t) => {
        const q = window.__box(A, t.rect, dsf);
        const px = [];
        let s0 = 0, s1 = 0, s2 = 0;
        for (let y = q.y0; y < q.y1; y++) {
          for (let x = q.x0; x < q.x1; x++) {
            const i = (y * A.width + x) * 4;
            px.push([A.data[i], A.data[i + 1], A.data[i + 2]]);
            s0 += A.data[i]; s1 += A.data[i + 1]; s2 += A.data[i + 2];
          }
        }
        if (px.length < 4) return null;
        const mean = [s0 / px.length, s1 / px.length, s2 / px.length];
        const fg = t.fg;
        const eff = fg[3] < 1
          ? [0, 1, 2].map((i) => fg[i] * fg[3] + mean[i] * (1 - fg[3]))
          : fg.slice(0, 3);
        const rs = px.map((p) => window.__ratio(eff, p)).sort((a, b) => a - b);
        return {
          bg: 'rgb(' + mean.map(Math.round).join(',') + ')',
          mean: Math.round(window.__ratio(eff, mean) * 100) / 100,
          p10: Math.round(rs[Math.min(rs.length - 1, Math.floor(rs.length * 0.10))] * 100) / 100,
        };
      });
    }, [targets, dsf]),

    close: () => ctx.close(),
  };
}

// ------------------------------------------------------------------- drive --

async function openApp({ browser, theme, devices }) {
  const ctx = await browser.newContext({ ...devices['iPhone 14'], deviceScaleFactor: 2 });
  if (theme === 'night') {
    await ctx.addInitScript(() => { try { localStorage.setItem('clapper.theme', 'night'); } catch {} });
  }
  const page = await ctx.newPage();

  await page.goto(`http://localhost:${PORT}/`, { waitUntil: 'domcontentloaded' });
  await page.evaluate(async () => {
    if (navigator.serviceWorker) {
      const regs = await navigator.serviceWorker.getRegistrations();
      await Promise.all(regs.map((r) => r.unregister()));
    }
    if (window.caches) {
      const keys = await caches.keys();
      await Promise.all(keys.map((k) => caches.delete(k)));
    }
  });
  await sleep(2200);                                    // wait, as its own step
  await page.goto(`http://localhost:${PORT}/`, { waitUntil: 'load' });
  await page.waitForTimeout(900);

  const loaded = await page.evaluate(() =>
    [...document.querySelectorAll('script[src]')].map((s) => s.getAttribute('src'))
  );
  const want = expectedBundle().replace('assets/', '');
  if (!loaded.some((s) => s && s.includes(want))) {
    die(`BUNDLE MISMATCH: the page loaded ${JSON.stringify(loaded)} but dist/index.html names ${want}.`);
  }

  const dismiss = page.locator('.installnudge__dismiss');
  if (await dismiss.count()) { await dismiss.first().click(); await page.waitForTimeout(250); }
  return { ctx, page, bundle: want };
}

/** Home -> shotlist sheet -> the 137-shot pack -> start shoot -> project. */
async function seed(page) {
  await page.getByText(/Shotlist . from a PDF/i).first().click();
  await page.waitForTimeout(800);
  await page.locator('.sp-example', { hasText: /Keep The Take/i }).first().click();
  await page.waitForTimeout(1400);
  const start = page.getByRole('button', { name: /start the shoot/i }).first();
  if (await start.count()) { await start.click(); await page.waitForTimeout(1400); }
}

// ------------------------------------------------------------------- main ---

if (!flag('--no-build')) build();
assertFresh();

console.error('');
console.error('  clapper contrast auditor');
console.error('  root     ' + ROOT);
console.error('  git      ' + git('rev-parse --short HEAD') +
  (git('status --porcelain') ? '  (DIRTY working tree)' : '  (clean)'));
console.error('  bundle   ' + expectedBundle());
console.error('  built    ' + new Date(fs.statSync(path.join(DIST, 'index.html')).mtimeMs).toISOString());
console.error('');

const { chromium, devices } = await loadPlaywright();
const server = await serve(PORT);
const browser = await chromium.launch({ channel: 'chrome', headless: !flag('--headed') });
const lab = await makeLab(browser);
if (SHOTS) fs.mkdirSync(SHOTS, { recursive: true });

const contrastRows = [];
const bandRows = [];

for (const theme of THEMES) {
  const { ctx, page } = await openApp({ browser, theme, devices });
  const dsf = 2;

  /** One frame: band delta for every visible material surface, plus the WCAG
      contrast of every text node on them, sampled off real pixels. */
  const frame = async (label) => {
    await page.waitForTimeout(350);
    const targets = await page.evaluate(COLLECT, MATERIAL);
    const bands = await page.evaluate(BANDS, MATERIAL);

    if (SHOTS) {
      await page.screenshot({ path: path.join(SHOTS, `${theme}-${label}.png`) });
    }

    // A: as built.
    await lab.put('a', await page.screenshot());

    // B: material flattened to its opaque fallback, same scroll position.
    const flat = await page.addStyleTag({ content: FLATTEN });
    await page.waitForTimeout(250);
    await lab.put('b', await page.screenshot());
    await page.evaluate((el) => el.remove(), flat);
    await page.waitForTimeout(150);

    for (const b of await lab.bands(bands, dsf)) bandRows.push({ theme, frame: label, ...b });

    // C: type off, screenshot, sample each text rect. Those pixels are the
    //    composited backdrop the type is actually fighting.
    const hide = await page.addStyleTag({ content: HIDE_TYPE });
    await page.waitForTimeout(220);
    await lab.put('a', await page.screenshot());
    await page.evaluate((el) => el.remove(), hide);
    await page.waitForTimeout(150);

    const withFg = targets
      .map((t) => ({ ...t, fg: parseColor(t.color) }))
      .filter((t) => t.fg);
    const measured = await lab.contrast(withFg, dsf);
    withFg.forEach((t, i) => {
      const m = measured[i];
      if (!m) return;
      const large = t.px >= 24 || (t.weight >= 700 && t.px >= 18.66);
      contrastRows.push({
        theme, frame: label, surface: t.surface, text: t.text,
        px: t.px, weight: t.weight, color: t.color,
        bg: m.bg, mean: m.mean, p10: m.p10, need: large ? 3 : 4.5,
      });
    });
    console.error(`  ${theme}/${label}: ${bands.length} bands, ${targets.length} text nodes`);
  };

  // ---- the frames §11 names ------------------------------------------------
  await seed(page);

  // 1. the project screen scrolled so scene cards pass under the nav bar and
  //    the tray. Cards carry the clapper stripe and the scene tag chips, so
  //    this is the tray over structure AND over signal colour.
  await page.evaluate(() => window.scrollTo(0, 420));
  await frame('project-midscroll');

  // 2. deeper, so a different band of content sits under both bars
  await page.evaluate(() => window.scrollTo(0, 900));
  await frame('project-deep');

  // 3. the 137-shot list: the densest content in the app, and the shot chips
  //    are the saturated case the spec calls the worst one.
  await page.evaluate(() => window.scrollTo(0, 0));
  await page.waitForTimeout(300);
  const card = (await page.$$('.card'))[0];
  if (card) { await card.click(); await page.waitForTimeout(1100); }
  await page.evaluate(() => window.scrollTo(0, 640));
  await frame('shots-midscroll');

  // 4. THE WORST CASE THE SPEC NAMES: a saturated element parked deliberately
  //    inside the tray band, not wherever the scroll happened to leave one.
  //    It then CHECKS that the element really landed there and reports which
  //    one and in what colour - a frame that silently missed would let the
  //    whole audit pass while never testing the case it exists for.
  const parked = await page.evaluate(() => {
    const tray = document.querySelector('.tabtray');
    if (!tray) return { ok: false, why: 'no tray' };
    const band = tray.getBoundingClientRect();
    const chromatic = (c) => {
      const m = c.match(/(\d+),\s*(\d+),\s*(\d+)/);
      if (!m) return 0;
      const v = [+m[1], +m[2], +m[3]];
      return Math.max(...v) - Math.min(...v);
    };
    // anything whose own text or fill carries chroma: brass shot codes, the
    // green counts, tag chips, REC dots.
    const pool = [...document.querySelectorAll('*')].filter((e) => {
      const r = e.getBoundingClientRect();
      if (r.width < 8 || r.height < 8 || r.width > 400) return false;
      const cs = getComputedStyle(e);
      return chromatic(cs.color) > 24 || chromatic(cs.backgroundColor) > 24;
    });
    if (!pool.length) return { ok: false, why: 'no chromatic element on this screen' };
    const target = pool[Math.floor(pool.length / 2)];
    const top = target.getBoundingClientRect().top + window.scrollY;
    // aim its middle at the middle of the tray band
    window.scrollTo(0, Math.max(0, top - band.top - band.height / 2 + 10));
    const r = target.getBoundingClientRect();
    const hit = r.bottom > band.top && r.top < band.bottom;
    const cs = getComputedStyle(target);
    return {
      ok: true, hit,
      what: (typeof target.className === 'string' ? target.className : target.tagName).slice(0, 40),
      text: (target.textContent || '').trim().slice(0, 20),
      color: cs.color, bgcolor: cs.backgroundColor,
      trayTop: Math.round(band.top), elTop: Math.round(r.top), elBottom: Math.round(r.bottom),
    };
  });
  if (parked.ok) {
    console.error(
      `  ${theme}/shots-signal-under-tray: ` +
      (parked.hit
        ? `PARKED .${parked.what} "${parked.text}" ${parked.color} in the tray band ` +
          `(${parked.elTop}-${parked.elBottom} vs band top ${parked.trayTop})`
        : `MISSED - .${parked.what} did not land in the band. ` +
          `THE WORST CASE WAS NOT TESTED IN THIS RUN.`)
    );
    await frame('shots-signal-under-tray');
  } else {
    console.error(`  ${theme}/shots-signal-under-tray: SKIPPED (${parked.why})`);
  }

  // 5. .ltop on every tab root, scrolled
  for (const tab of ['home', 'projects', 'settings', 'account']) {
    const btn = page.getByRole('button', { name: new RegExp(`^${tab}$`, 'i') }).first();
    if (!(await btn.count())) continue;
    await btn.click();
    await page.waitForTimeout(800);
    // pop any restored stack so we land on the tab ROOT, which is where .ltop lives
    for (let i = 0; i < 4; i++) {
      const back = page.locator('.topbar .iconbtn');
      if (!(await back.count())) break;
      await back.first().click();
      await page.waitForTimeout(650);
    }
    await page.evaluate(() => window.scrollTo(0, 260));
    await frame(`ltop-${tab}`);
  }

  // 6. .sheet__head over a body that really scrolls
  await page.getByRole('button', { name: /^projects$/i }).first().click();
  await page.waitForTimeout(800);
  const nu = page.getByRole('button', { name: /new project/i }).first();
  if (await nu.count()) {
    await nu.click();
    await page.waitForTimeout(1000);
    await page.evaluate(() => {
      const b = document.querySelector('.sheet__body');
      if (b) b.scrollTop = 200;
    });
    await frame('sheet-scrolled');
  }

  await ctx.close();
}

await lab.close();
await browser.close();
server.close();

// ----------------------------------------------------------------- report ---

console.log('\n=== A. BAND DELTA — how far the material moves with content behind it ===');
console.log('   FLAT  the same bar with backdrop-filter off and the opaque token');
console.log('   LIVE  as built');
console.log('   SHIFT live - flat, the difference of means (the number the spec quoted)');
console.log('   MOVE  mean per-pixel |live - flat|. The honest one: lighter and darker');
console.log('         pixels cancel in SHIFT, so a bar with real structure showing');
console.log('         through can read as zero there and still read as glass.');
console.log('   P95   the 95th percentile of that, i.e. where the backdrop shows most.\n');
const bhead = ['THEME', 'FRAME', 'SURFACE', 'FLAT', 'LIVE', 'SHIFT', 'MOVE', 'P95', 'MAX'];
const bwid = [6, 24, 13, 7, 7, 7, 7, 6, 6];
const row = (cells, wid) => cells.map((c, i) => String(c).padEnd(wid[i])).join(' ');
console.log(row(bhead, bwid));
for (const b of bandRows) {
  console.log(row([b.theme, b.frame, b.surface, b.flat, b.live, b.shift, b.move, b.p95, b.max], bwid));
}
const byTheme = {};
for (const b of bandRows) (byTheme[b.theme] ||= []).push(b);
console.log('');
for (const [t, bs] of Object.entries(byTheme)) {
  // A bar with nothing behind it CORRECTLY moves zero, so averaging those in
  // reads as a regression when the effect improved. Report the loaded bands
  // separately and say how many were empty.
  const loaded = bs.filter((b) => b.p95 >= 0.5);
  const mean = (xs) => xs.reduce((a, c) => a + c, 0) / (xs.length || 1);
  console.log(
    `   ${t}: ${loaded.length}/${bs.length} bands had content behind them` +
    `  |  loaded: mean MOVE ${mean(loaded.map((b) => b.move)).toFixed(2)}` +
    `, mean P95 ${mean(loaded.map((b) => b.p95)).toFixed(1)}` +
    `, max P95 ${Math.max(...loaded.map((b) => b.p95), 0).toFixed(1)}`
  );
}

console.log('\n=== B. CONTRAST on material, against the sampled backdrop ===');
console.log('   P10 is the adverse tail: the 10th-percentile per-pixel ratio in the');
console.log('   text rectangle. That is the number a saturated chip sliding under the');
console.log('   bar moves, and it is the number that fails.\n');
const chead = ['THEME', 'FRAME', 'SURFACE', 'TEXT', 'PX', 'MEAN', 'P10', 'NEED', 'BACKDROP'];
const cwid = [6, 24, 13, 30, 6, 7, 7, 6, 18];
console.log(row(chead, cwid));
contrastRows.sort((a, b) => a.p10 - b.p10);
let fails = 0;
for (const c of contrastRows) {
  const bad = c.p10 < c.need;
  if (bad) fails++;
  console.log(
    row([c.theme, c.frame, c.surface, c.text, c.px, c.mean, c.p10, c.need, c.bg], cwid) +
      (bad ? '   <-- FAILS' : '')
  );
}
console.log(`\n${contrastRows.length} text nodes measured on material, ${fails} below bar.`);
if (SHOTS) console.log(`frames written to ${SHOTS}`);
process.exit(fails ? 1 : 0);
