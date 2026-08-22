// Generate the Clapper PWA icons (public/icon-192.png, public/icon-512.png).
//
// No new npm deps: we render an inline SVG in the already-installed Playwright
// Chromium and screenshot it at the exact pixel size, with transparent corners
// (omitBackground) so the rounded-square reads as a real app icon.
//
//   node scripts/make-icons.mjs
//
// Motif: near-black rounded square, a white diagonal clapper-stripe band across
// the upper third, and a bold green "C" (matching --go #38d178 from styles.css).

import { mkdir } from 'node:fs/promises';
import { existsSync, readdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { homedir } from 'node:os';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = join(__dirname, '..');
const OUT_DIR = join(ROOT, 'public');

// The icon is always the NIGHT pairing, whatever theme the app is in: a home
// screen is somebody else's wallpaper and the icon has to hold on any of them.
// Acid on true black is 18.70:1, which is the highest-contrast pair the palette
// has and the reason it survives being 48px on a busy background.
const INK = '#000000'; // night ground
const GO = '#e6ff2b'; // --m-accent on night (was --go #38d178, retired 2026-08-22)
const CHALK = '#ece9e1'; // warm off-white, never pure #fff

// ---- SVG (512 viewBox, scaled to the target size) -------------------------

function buildSvg(size) {
  const S = 512;
  const rx = 112; // ~22% rounded corners

  // Clapper stripe band across the upper third, tilted like a hinged top.
  // Diagonal white stripes over the ink band, clipped to the band rect.
  const bandTop = 104;
  const bandH = 108;
  const stripes = [];
  const slant = 46; // horizontal shear of each stripe
  for (let x = -slant; x < S + slant; x += 84) {
    stripes.push(
      `<path d="M ${x} ${bandTop} L ${x + 42} ${bandTop} L ${x + 42 - slant} ${bandTop + bandH} L ${x - slant} ${bandTop + bandH} Z" fill="${CHALK}"/>`,
    );
  }

  // Bold "C" as a stroked arc (no font dependency). Opening faces right.
  const cx = 256;
  const cy = 348;
  const r = 96;
  const a0 = (48 * Math.PI) / 180; // lower-right start
  const a1 = (-48 * Math.PI) / 180; // upper-right end
  const p = (a) => `${(cx + r * Math.cos(a)).toFixed(2)} ${(cy + r * Math.sin(a)).toFixed(2)}`;
  const cPath = `M ${p(a0)} A ${r} ${r} 0 1 0 ${p(a1)}`;

  return `<svg xmlns="http://www.w3.org/2000/svg" width="${size}" height="${size}" viewBox="0 0 ${S} ${S}">
  <defs>
    <clipPath id="band">
      <rect x="0" y="${bandTop}" width="${S}" height="${bandH}"/>
    </clipPath>
  </defs>
  <rect x="0" y="0" width="${S}" height="${S}" rx="${rx}" ry="${rx}" fill="${INK}"/>
  <g clip-path="url(#band)">
    <rect x="0" y="${bandTop}" width="${S}" height="${bandH}" fill="${INK}"/>
    ${stripes.join('\n    ')}
  </g>
  <path d="${cPath}" fill="none" stroke="${GO}" stroke-width="48" stroke-linecap="round"/>
</svg>`;
}

// ---- locate the installed Playwright Chromium executable ------------------

function findChromium() {
  const cacheRoot = process.env.PLAYWRIGHT_BROWSERS_PATH || join(homedir(), 'Library/Caches/ms-playwright');
  if (!existsSync(cacheRoot)) return undefined;
  const dirs = readdirSync(cacheRoot)
    .filter((d) => d.startsWith('chromium-') && !d.includes('headless'))
    .sort()
    .reverse();
  for (const d of dirs) {
    const candidates = [
      join(cacheRoot, d, 'chrome-mac-arm64', 'Google Chrome for Testing.app', 'Contents', 'MacOS', 'Google Chrome for Testing'),
      join(cacheRoot, d, 'chrome-mac', 'Google Chrome for Testing.app', 'Contents', 'MacOS', 'Google Chrome for Testing'),
      join(cacheRoot, d, 'chrome-mac-arm64', 'Chromium.app', 'Contents', 'MacOS', 'Chromium'),
    ];
    for (const c of candidates) if (existsSync(c)) return c;
  }
  return undefined;
}

function loadPlaywright() {
  for (const mod of ['playwright', 'playwright-core']) {
    try {
      return require(mod);
    } catch {
      /* try next */
    }
  }
  // Fall back to the globally installed playwright-core.
  for (const base of ['/usr/local/lib/node_modules', '/opt/homebrew/lib/node_modules']) {
    try {
      return require(join(base, 'openclaw', 'node_modules', 'playwright-core'));
    } catch {
      /* keep looking */
    }
  }
  throw new Error('Could not resolve playwright / playwright-core');
}

async function rasterize(browser, size, outPath) {
  const page = await browser.newPage({ viewport: { width: size, height: size }, deviceScaleFactor: 1 });
  const svg = buildSvg(size);
  const html = `<!doctype html><html><head><style>
    html,body{margin:0;padding:0;background:transparent}
    svg{display:block}
  </style></head><body>${svg}</body></html>`;
  await page.setContent(html, { waitUntil: 'networkidle' });
  const el = await page.$('svg');
  await el.screenshot({ path: outPath, omitBackground: true });
  await page.close();
}

async function main() {
  await mkdir(OUT_DIR, { recursive: true });
  const { chromium } = loadPlaywright();
  const executablePath = findChromium();
  const browser = await chromium.launch(executablePath ? { executablePath } : {});
  try {
    await rasterize(browser, 192, join(OUT_DIR, 'icon-192.png'));
    await rasterize(browser, 512, join(OUT_DIR, 'icon-512.png'));
  } finally {
    await browser.close();
  }
  console.log('Wrote public/icon-192.png and public/icon-512.png');
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
