// Generate the Clapper PWA icons (public/icon-192.png, public/icon-512.png,
// public/apple-touch-icon.png, public/favicon-32.png) from the single vector
// master, public/favicon.svg — the clapperboard-and-continuity-card mark in
// acid yellow (#e6ff2b) on near-black. There is ONE mark, and favicon.svg is
// it, so every raster here is the same art at a different size. The earlier
// inline "C" mark was retired 2026-08-29; do not reintroduce a second mark.
//
//   node scripts/make-icons.mjs
import { mkdir } from 'node:fs/promises';
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { homedir } from 'node:os';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = join(__dirname, '..');
const OUT = join(ROOT, 'public');
const SVG = readFileSync(join(OUT, 'favicon.svg'), 'utf8');

function findChromium(){const root=process.env.PLAYWRIGHT_BROWSERS_PATH||join(homedir(),'Library/Caches/ms-playwright');if(!existsSync(root))return;for(const d of readdirSync(root).filter(d=>d.startsWith('chromium-')&&!d.includes('headless')).sort().reverse())for(const c of [join(root,d,'chrome-mac-arm64','Google Chrome for Testing.app','Contents','MacOS','Google Chrome for Testing'),join(root,d,'chrome-mac','Google Chrome for Testing.app','Contents','MacOS','Google Chrome for Testing'),join(root,d,'chrome-mac-arm64','Chromium.app','Contents','MacOS','Chromium')])if(existsSync(c))return c;}
function loadPlaywright(){for(const m of ['playwright','playwright-core']){try{return require(m);}catch{}}for(const base of ['/usr/local/lib/node_modules','/opt/homebrew/lib/node_modules']){try{return require(join(base,'openclaw','node_modules','playwright-core'));}catch{}}throw new Error('Could not resolve playwright');}

async function rasterize(browser, size, outPath){
  const page = await browser.newPage({ viewport: { width: size, height: size }, deviceScaleFactor: 1 });
  const html = `<!doctype html><html><head><style>html,body{margin:0;padding:0;background:transparent}svg{display:block;width:${size}px;height:${size}px}</style></head><body>${SVG}</body></html>`;
  await page.setContent(html, { waitUntil: 'networkidle' });
  const el = await page.$('svg');
  await el.screenshot({ path: outPath, omitBackground: true });
  await page.close();
}
async function main(){
  await mkdir(OUT, { recursive: true });
  const { chromium } = loadPlaywright();
  const exe = findChromium();
  const browser = await chromium.launch(exe ? { executablePath: exe } : {});
  try {
    await rasterize(browser, 192, join(OUT, 'icon-192.png'));
    await rasterize(browser, 512, join(OUT, 'icon-512.png'));
    await rasterize(browser, 180, join(OUT, 'apple-touch-icon.png'));
    await rasterize(browser, 32, join(OUT, 'favicon-32.png'));
  } finally { await browser.close(); }
  console.log('Wrote icon-192, icon-512, apple-touch-icon, favicon-32 from favicon.svg');
}
main().catch((e) => { console.error(e); process.exit(1); });
