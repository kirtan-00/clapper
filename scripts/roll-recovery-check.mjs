#!/usr/bin/env node
// Simulates the exact failure this feature exists for: a tab killed mid-take,
// then relaunched. Drives the SAME CDP pattern scripts/shoot-roll.mjs already
// uses (Chromium borrowed from Playwright's cache, no new dependency).
//
// A true OS-level tab kill cannot be reproduced from outside the browser, but
// the mechanism that matters IS reproducible: same-origin storage (IndexedDB,
// localStorage) survives independently of the page's JS execution context.
// So this script (1) rolls a take and taps some chips, (2) fires the real
// visibilitychange -> hidden transition the app listens for, (3) does a full
// Page.navigate reload - a fresh JS context, exactly what relaunching a
// killed PWA gives you - and (4) checks what the reloaded page actually shows.
// If the recovery prompt did not appear, or showed the wrong clip/elapsed
// time, this script fails loudly rather than a screenshot being eyeballed
// and guessed at.
//
// Usage: node scripts/roll-recovery-check.mjs [outDir]   # reuses :5200

import { mkdirSync, writeFileSync } from 'node:fs';
import { existsSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const REPO_ROOT = fileURLToPath(new URL('..', import.meta.url));
const DEV_PORT = Number(process.env.PORT ?? 5200);
const CDP_PORT = Number(process.env.CDP_PORT ?? 9335);
const BASE_URL = `http://localhost:${DEV_PORT}/`;
const OUT_DIR = process.argv[2] ?? join(REPO_ROOT, '.shots/rollrecovery');
mkdirSync(OUT_DIR, { recursive: true });

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
    try {
      const res = await fetch(url);
      if (res.ok || res.status < 500) return;
    } catch { /* not up yet */ }
    if (Date.now() - start > timeoutMs) throw new Error(`Timed out waiting for ${url}`);
    await sleep(150);
  }
}

class CDP {
  constructor(ws) {
    this.ws = ws;
    this.nextId = 1;
    this.pending = new Map();
    this.listeners = new Map();
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
      if (msg.error) reject(new Error(msg.error.message));
      else resolve(msg.result);
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
      const fn = (params) => {
        if (!predicate(params)) return;
        set.delete(fn);
        resolve(params);
      };
      set.add(fn);
    });
  }

  async evaluate(expression) {
    const result = await this.send('Runtime.evaluate', {
      expression, awaitPromise: true, returnByValue: true, timeout: 15000,
    });
    if (result.exceptionDetails) {
      throw new Error(
        result.exceptionDetails.exception?.description ?? result.exceptionDetails.text ?? 'evaluate() threw',
      );
    }
    return result.result?.value;
  }

  async waitForExpr(exprBody, { timeout = 12000, interval = 100, desc = exprBody } = {}) {
    const start = Date.now();
    for (;;) {
      const ok = await this.evaluate(`(() => { try { return !!(${exprBody}); } catch (e) { return false; } })()`);
      if (ok) return;
      if (Date.now() - start > timeout) throw new Error(`Timeout waiting for: ${desc}`);
      await sleep(interval);
    }
  }

  async navigate(url) {
    await this.send('Page.navigate', { url });
    await this.once('Page.loadEventFired');
  }

  async setViewport(width, height) {
    await this.send('Emulation.setDeviceMetricsOverride', {
      width, height, deviceScaleFactor: 2, mobile: true, screenWidth: width, screenHeight: height,
    });
  }

  async mouseDown(x, y) {
    await this.send('Input.dispatchMouseEvent', {
      type: 'mousePressed', x, y, button: 'left', clickCount: 1, buttons: 1, pointerType: 'mouse',
    });
  }
  async mouseUp(x, y) {
    await this.send('Input.dispatchMouseEvent', {
      type: 'mouseReleased', x, y, button: 'left', clickCount: 1, buttons: 0, pointerType: 'mouse',
    });
  }
  async tapAt(x, y) {
    await this.mouseDown(x, y);
    await sleep(30);
    await this.mouseUp(x, y);
  }
  async centreOf(selector) {
    return this.evaluate(`
      (() => {
        const el = document.querySelector(${JSON.stringify(selector)});
        if (!el) return null;
        const r = el.getBoundingClientRect();
        return { x: Math.round(r.left + r.width / 2), y: Math.round(r.top + r.height / 2) };
      })()
    `);
  }
  async tapSelector(selector) {
    const c = await this.centreOf(selector);
    if (!c) throw new Error(`not found: ${selector}`);
    await this.tapAt(c.x, c.y);
  }

  async shot(path) {
    const { data } = await this.send('Page.captureScreenshot', { format: 'png', captureBeyondViewport: false });
    writeFileSync(path, Buffer.from(data, 'base64'));
  }
}

const CLICK_BY_TEXT = (text) => `
  (() => {
    const want = ${JSON.stringify(text)};
    const els = [...document.querySelectorAll('button, [role="button"], .card, .grow')];
    const hit = els.find((e) => (e.textContent || '').includes(want));
    if (!hit) return false;
    (hit.closest('button') || hit).click();
    return true;
  })()
`;

async function seed(cdp, { multi, sound } = {}) {
  const cameras = multi
    ? [
        { letter: 'A', clipPrefix: 'C', nextClipNumber: 2, clipPadding: 4 },
        { letter: 'B', clipPrefix: 'C', nextClipNumber: 2, clipPadding: 4 },
      ]
    : undefined;
  const soundUnit = sound ? { filePrefix: 'SND_', nextFileNumber: 1, filePadding: 4 } : undefined;
  await cdp.evaluate(`
    (async () => {
      localStorage.setItem('clapper.onboardingDone', '1');
      localStorage.setItem('clapper.installNudgeDismissed', '1');
      const { store } = await import('/src/store/index.ts');
      for (const p of await store.listProjects()) await store.deleteProject(p.id);
      const project = await store.createProject({
        name: 'Recovery Test', fps: 24, clipPrefix: 'C', nextClipNumber: 1, clipPadding: 4,
        tags: ['WIDE','MID','CU','OTS','INSERT','GOLD','PICKUP','NOISE'],
        ${cameras ? `cameras: ${JSON.stringify(cameras)},` : ''}
        ${soundUnit ? `sound: ${JSON.stringify(soundUnit)},` : ''}
      });
      await store.createSlate(project.id, 'Scene 1');
      return true;
    })()
  `);
}

async function openRoll(cdp) {
  await cdp.navigate(BASE_URL);
  await cdp.waitForExpr(`document.body.textContent.includes('Recovery Test')`, { desc: 'home listing the project' });
  await cdp.waitForExpr(CLICK_BY_TEXT('Recovery Test'), { desc: 'project row clickable' });
  await cdp.waitForExpr(`document.body.textContent.includes('Scene 1')`, { desc: 'project screen' });
  await cdp.waitForExpr(CLICK_BY_TEXT('Scene 1'), { desc: 'scene row clickable - bare scene goes straight to rolling' });
  await cdp.waitForExpr(`document.querySelector('.roll') && document.querySelector('.bigbtn')`, { desc: 'rolling screen' });
  await sleep(200);
}

/** Reads the raw checkpoint straight off localStorage - the ground truth for
 *  what got written, independent of anything the recovery UI later renders. */
async function readCheckpointRaw(cdp) {
  const raw = await cdp.evaluate(`localStorage.getItem('clapper.rollCheckpoint')`);
  return raw ? JSON.parse(raw) : null;
}

async function fireBackgrounding(cdp) {
  await cdp.evaluate(`
    (() => {
      Object.defineProperty(document, 'visibilityState', { value: 'hidden', configurable: true });
      document.dispatchEvent(new Event('visibilitychange'));
      return true;
    })()
  `);
  await sleep(80); // the visibilitychange handler is synchronous, but give the event loop a tick
}

let pass = 0;
let fail = 0;
function check(desc, ok, detail = '') {
  if (ok) {
    pass++;
    console.log(` ok  ${desc}${detail ? '  ' + detail : ''}`);
  } else {
    fail++;
    console.log(`FAIL ${desc}${detail ? '  ' + detail : ''}`);
  }
}

async function main() {
  const chromePath = findChrome();
  await waitForHttp(BASE_URL);

  const { spawn } = await import('node:child_process');
  const chrome = spawn(
    chromePath,
    [
      `--remote-debugging-port=${CDP_PORT}`,
      '--headless=new',
      '--disable-gpu',
      '--no-first-run',
      '--no-default-browser-check',
      `--user-data-dir=${join(REPO_ROOT, '.chrome-recovery-profile')}`,
      'about:blank',
    ],
    { stdio: 'ignore' },
  );
  try {
    await waitForHttp(`http://localhost:${CDP_PORT}/json/version`);
    const cdp = await CDP.connectToNewPage(CDP_PORT);
    await cdp.send('Page.enable');
    await cdp.setViewport(VIEWPORT.width, VIEWPORT.height);
    // about:blank has no origin to hold localStorage against - navigate to
    // the real origin first, or `seed`'s own localStorage.setItem throws.
    await cdp.navigate(BASE_URL);

    // ===================================================================
    // RUN 1 — single-cam. ROLL, tap two tags + arm MARK IN, background,
    // cold-reload, confirm the recovery prompt, then take the STILL ROLLING
    // door and confirm the take resumes rather than restarting.
    // ===================================================================
    console.log('\n== single-cam: roll, tag, kill, recover, resume ==');
    await seed(cdp, { multi: false });
    await openRoll(cdp);

    await cdp.tapSelector('.bigbtn'); // ROLL
    await cdp.waitForExpr(`document.querySelector('.roll--live')`, { desc: 'take rolling' });
    await sleep(600); // clear FALSE_START_MS territory, and let the roll actually run a bit
    await cdp.tapSelector('.goldbtn'); // tag tap #1 (GOLD) - synchronous checkpoint trigger
    await sleep(200);
    await cdp.tapSelector('.markbtn'); // MARK IN armed - synchronous checkpoint trigger
    await sleep(150);

    const preKillWallNow = await cdp.evaluate(`Date.now()`);
    const cpBeforeReload = await readCheckpointRaw(cdp);
    check('checkpoint written after a tag tap + an armed mark', !!cpBeforeReload);
    check(
      'checkpoint carries the clip name the deck is showing',
      !!cpBeforeReload && cpBeforeReload.clips?.[0]?.clipName === 'C0001',
      JSON.stringify(cpBeforeReload?.clips),
    );
    check(
      'checkpoint carries the GOLD tag tap',
      !!cpBeforeReload && cpBeforeReload.buffered?.some((m) => m.tag === 'GOLD'),
      JSON.stringify(cpBeforeReload?.buffered),
    );
    check(
      'checkpoint carries the armed MARK IN',
      !!cpBeforeReload && typeof cpBeforeReload.markInMs === 'number',
      `markInMs=${cpBeforeReload?.markInMs}`,
    );

    await cdp.shot(join(OUT_DIR, '01-rolling-before-kill.png'));

    await fireBackgrounding(cdp);
    const cpAfterBg = await readCheckpointRaw(cdp);
    check(
      'backgrounding (visibilitychange->hidden) ITSELF writes a fresh checkpoint (savedAt advances) - not just riding on the earlier tag/mark writes',
      !!cpAfterBg && cpAfterBg.savedAt > cpBeforeReload.savedAt,
      `before savedAt=${cpBeforeReload?.savedAt} after savedAt=${cpAfterBg?.savedAt}`,
    );

    // THE KILL. A fresh navigate is a brand-new JS execution context - every
    // React state variable, every closure, every in-memory ref is gone -
    // while localStorage/IndexedDB (same origin) survive untouched. This is
    // the actual mechanism an iOS tab-kill-and-relaunch exercises.
    await cdp.navigate(BASE_URL);
    await cdp.waitForExpr(`document.body.textContent.includes('Take recovered')`, {
      desc: 'recovery prompt on cold reload',
      timeout: 15000,
    });
    await sleep(150);
    await cdp.shot(join(OUT_DIR, '02-recovery-prompt.png'));

    const promptText = await cdp.evaluate(`document.querySelector('.sheet')?.textContent ?? ''`);
    check('recovery prompt shows the recovered clip name', promptText.includes('C0001'), promptText);
    check('recovery prompt offers all three doors', ['Still rolling', 'Cut it now', 'Discard'].every((s) => promptText.includes(s)), promptText);

    const takesBeforeRecovery = await cdp.evaluate(`
      (async () => {
        const { store } = await import('/src/store/index.ts');
        const projects = await store.listProjects();
        const slates = await store.listSlates(projects[0].id);
        const takes = await store.listTakes(slates[0].id);
        return takes.length;
      })()
    `);
    check('no take exists yet - "Still rolling" has not consumed a clip number', takesBeforeRecovery === 0);

    await cdp.waitForExpr(CLICK_BY_TEXT('Still rolling'), { desc: '"Still rolling" clickable' });
    await cdp.waitForExpr(`document.querySelector('.roll--live')`, { desc: 'take resumed and rolling' });
    await sleep(300);
    await cdp.shot(join(OUT_DIR, '03-resumed-rolling.png'));

    const resumedGoldCount = await cdp.evaluate(`document.querySelector('.goldbtn .keycap__count')?.textContent ?? null`);
    check('the GOLD tap tally survived the crash+resume (×1 still on the chip)', resumedGoldCount === '×1', `saw ${resumedGoldCount}`);
    const resumedMarkArmed = await cdp.evaluate(`document.querySelector('.markbtn--armed') !== null`);
    check('the armed MARK IN survived the crash+resume', resumedMarkArmed === true);

    // Finish the take for real, and confirm exactly one take with exactly
    // one clip-number consumption resulted from this whole run. Real numbers,
    // not the DrumClock's on-screen text: DrumClock renders every digit
    // 0-9 stacked in a column for the CSS roll animation, so its
    // textContent is the same "0123456789..." string whether 8 seconds or
    // 8 minutes have elapsed - reading it back proves nothing. The take's
    // actual durationMs against real wall-clock time does.
    await cdp.tapSelector('.bigbtn'); // CUT
    const afterCutWallNow = await cdp.evaluate(`Date.now()`);
    await sleep(200);
    const afterCut = await cdp.evaluate(`
      (async () => {
        const { store } = await import('/src/store/index.ts');
        const projects = await store.listProjects();
        const project = await store.getProject(projects[0].id);
        const slates = await store.listSlates(project.id);
        const takes = await store.listTakes(slates[0].id);
        return { nextClipNumber: project.nextClipNumber, takeCount: takes.length, durationMs: takes[0]?.durationMs, tagCount: (await store.listMoments(takes[0]?.id ?? '')).length };
      })()
    `);
    check('exactly one take exists after the resumed take is finally cut', afterCut.takeCount === 1, JSON.stringify(afterCut));
    check('the clip counter advanced by exactly one across the whole crash+resume+cut', afterCut.nextClipNumber === 2, JSON.stringify(afterCut));
    // Real elapsed real-wall-clock time between the pre-kill capture and the
    // final CUT (which spans the simulated crash + reload + recovery click)
    // minus a little slack for evaluate() round-trips - the take's logged
    // duration must be AT LEAST that, proving the reconstructed clock ran
    // through the gap rather than restarting at 0 on resume.
    const realElapsedAcrossCrash = afterCutWallNow - preKillWallNow;
    check(
      'logged take duration tracks REAL wall-clock time across the simulated crash (reconstructed, not reset)',
      afterCut.durationMs >= realElapsedAcrossCrash - 250,
      `durationMs=${afterCut.durationMs} realElapsedAcrossCrash=${realElapsedAcrossCrash}`,
    );

    // ===================================================================
    // RUN 2 — "Cut it now" door: kill mid-take, recover, but say it already
    // ended. Confirms the take is written (status good), the checkpoint
    // clears, and a SECOND reload never re-offers the same take.
    // ===================================================================
    console.log('\n== single-cam: roll, kill, "Cut it now" ==');
    await seed(cdp, { multi: false });
    await openRoll(cdp);
    await cdp.tapSelector('.bigbtn'); // ROLL
    await cdp.waitForExpr(`document.querySelector('.roll--live')`, { desc: 'take rolling' });
    await sleep(700);
    await cdp.tapSelector('.goldbtn');
    await sleep(150);
    await fireBackgrounding(cdp);
    await cdp.navigate(BASE_URL);
    await cdp.waitForExpr(`document.body.textContent.includes('Take recovered')`, { desc: 'recovery prompt', timeout: 15000 });
    await cdp.waitForExpr(CLICK_BY_TEXT('Cut it now'), { desc: '"Cut it now" clickable' });
    await sleep(300);

    const afterCutNow = await cdp.evaluate(`
      (async () => {
        const { store } = await import('/src/store/index.ts');
        const projects = await store.listProjects();
        const project = await store.getProject(projects[0].id);
        const slates = await store.listSlates(project.id);
        const takes = await store.listTakes(slates[0].id);
        const take = takes[0];
        const moments = take ? await store.listMoments(take.id) : [];
        return { nextClipNumber: project.nextClipNumber, takeCount: takes.length, status: take?.status, durationMs: take?.durationMs, goldTag: moments.some((m) => m.tag === 'GOLD') };
      })()
    `);
    check('"Cut it now" writes exactly one take', afterCutNow.takeCount === 1, JSON.stringify(afterCutNow));
    check('the take is status "good"', afterCutNow.status === 'good', afterCutNow.status);
    check('the clip counter advanced by exactly one', afterCutNow.nextClipNumber === 2, JSON.stringify(afterCutNow));
    check('the tag tapped before the kill survived onto the logged take', afterCutNow.goldTag === true);
    check('duration is plausible (>= 700ms it actually rolled)', afterCutNow.durationMs >= 700, `durationMs=${afterCutNow.durationMs}`);

    const checkpointAfterCutNow = await readCheckpointRaw(cdp);
    check('checkpoint cleared after "Cut it now" persists', checkpointAfterCutNow === null);

    // Reload AGAIN - if the checkpoint or the exactly-once guard were wrong,
    // this is where a duplicate take would appear.
    await cdp.navigate(BASE_URL);
    await sleep(400);
    const promptReappeared = await cdp.evaluate(`document.body.textContent.includes('Take recovered')`);
    check('recovery prompt does NOT reappear for an already-saved take', promptReappeared === false);
    const takeCountAfterSecondReload = await cdp.evaluate(`
      (async () => {
        const { store } = await import('/src/store/index.ts');
        const projects = await store.listProjects();
        const slates = await store.listSlates(projects[0].id);
        const takes = await store.listTakes(slates[0].id);
        return takes.length;
      })()
    `);
    check('still exactly one take on disk - no duplicate from the second reload', takeCountAfterSecondReload === 1, `count=${takeCountAfterSecondReload}`);

    // ===================================================================
    // RUN 3 — multi-cam banner: confirms the "A C0002 · B C0002" format the
    // task calls out by name actually renders, not just that it computes.
    // ===================================================================
    console.log('\n== multi-cam: recovery banner shows a clip per camera ==');
    await seed(cdp, { multi: true });
    await openRoll(cdp);
    await cdp.tapSelector('.bigbtn'); // big ROLL - both units join
    await cdp.waitForExpr(`document.querySelector('.roll--live')`, { desc: 'multi-cam take rolling' });
    await sleep(600);
    await cdp.tapSelector('.goldbtn');
    await sleep(150);
    await fireBackgrounding(cdp);
    await cdp.navigate(BASE_URL);
    await cdp.waitForExpr(`document.body.textContent.includes('Take recovered')`, { desc: 'recovery prompt', timeout: 15000 });
    await sleep(150);
    await cdp.shot(join(OUT_DIR, '04-multicam-recovery-prompt.png'));
    const multiPromptText = await cdp.evaluate(`document.querySelector('.sheet')?.textContent ?? ''`);
    check(
      'multi-cam recovery banner names BOTH cameras ("A C.... · B C....")',
      multiPromptText.includes('A C0002') && multiPromptText.includes('B C0002'),
      multiPromptText,
    );
    await cdp.waitForExpr(CLICK_BY_TEXT('Discard'), { desc: '"Discard" clickable' });
    await sleep(300);
    const afterDiscard = await cdp.evaluate(`
      (async () => {
        const { store } = await import('/src/store/index.ts');
        const projects = await store.listProjects();
        const project = await store.getProject(projects[0].id);
        const slates = await store.listSlates(project.id);
        const takes = await store.listTakes(slates[0].id);
        const take = takes[0];
        return { cameras: project.cameras.map((c) => c.nextClipNumber), takeCount: takes.length, status: take?.status, clips: take?.clips };
      })()
    `);
    check('"Discard" still writes exactly one take (footage physically exists on the card)', afterDiscard.takeCount === 1, JSON.stringify(afterDiscard));
    check('the take is status "discarded"', afterDiscard.status === 'discarded', afterDiscard.status);
    check('BOTH camera counters advanced by exactly one - discard consumes the number, matches the README', afterDiscard.cameras.every((n) => n === 3), JSON.stringify(afterDiscard.cameras));

    // ===================================================================
    // RUN 4 — STALE checkpoint: "Still rolling" must be withheld once the
    // checkpoint is older than STALE_MS (45 min). Injected directly rather
    // than actually waiting 45 minutes: a real checkpoint's SHAPE, with
    // savedAt pushed into the past, is what isStale() actually reads.
    // ===================================================================
    console.log('\n== stale checkpoint: "Still rolling" is withheld ==');
    await seed(cdp, { multi: false });
    await openRoll(cdp);
    const ids = await cdp.evaluate(`
      (async () => {
        const { store } = await import('/src/store/index.ts');
        const projects = await store.listProjects();
        const slates = await store.listSlates(projects[0].id);
        return { projectId: projects[0].id, slateId: slates[0].id };
      })()
    `);
    const STALE_SAVED_AT_AGO_MS = 46 * 60 * 1000; // one minute past the 45-minute threshold
    await cdp.evaluate(`
      (() => {
        const now = Date.now();
        const cp = {
          v: 1,
          projectId: ${JSON.stringify(ids.projectId)},
          slateId: ${JSON.stringify(ids.slateId)},
          takeNumber: 1,
          takeStartedAt: now - ${STALE_SAVED_AT_AGO_MS} - 5000,
          savedAt: now - ${STALE_SAVED_AT_AGO_MS},
          camRolls: { A: now - ${STALE_SAVED_AT_AGO_MS} - 5000 },
          finishedRolls: [],
          soundStartedAt: null,
          soundFinished: null,
          buffered: [],
          markInMs: null,
          flashes: {},
          clips: [{ unit: 'A', clipName: 'C0001' }],
        };
        localStorage.setItem('clapper.rollCheckpoint', JSON.stringify(cp));
        return true;
      })()
    `);
    await cdp.navigate(BASE_URL);
    await cdp.waitForExpr(`document.body.textContent.includes('Take recovered')`, {
      desc: 'recovery prompt for the injected stale checkpoint',
      timeout: 15000,
    });
    await sleep(150);
    await cdp.shot(join(OUT_DIR, '05-stale-recovery-prompt.png'));
    const stalePromptText = await cdp.evaluate(`document.querySelector('.sheet')?.textContent ?? ''`);
    check('stale prompt: "Still rolling" is ABSENT', !stalePromptText.includes('Still rolling'), stalePromptText);
    check('stale prompt: "Cut it now" and "Discard" are still offered', stalePromptText.includes('Cut it now') && stalePromptText.includes('Discard'), stalePromptText);
    check('stale prompt: copy explains why', stalePromptText.includes('too long ago'), stalePromptText);

    // Stale does not mean broken - "Cut it now" must still work normally.
    await cdp.waitForExpr(CLICK_BY_TEXT('Cut it now'), { desc: '"Cut it now" clickable on a stale checkpoint' });
    await sleep(300);
    const afterStaleCut = await cdp.evaluate(`
      (async () => {
        const { store } = await import('/src/store/index.ts');
        const takes = await store.listTakes(${JSON.stringify(ids.slateId)});
        return { takeCount: takes.length, status: takes[0]?.status };
      })()
    `);
    check('a stale checkpoint\'s "Cut it now" still logs exactly one take', afterStaleCut.takeCount === 1 && afterStaleCut.status === 'good', JSON.stringify(afterStaleCut));

    // ===================================================================
    // RUN 5 — single-cam WITH SOUND, sound rolled SOLO, camera never joined.
    // This is the case where buildTakeClips' single-cam path would fabricate
    // a phantom camera clip if RollRecovery called createTake naively (see
    // noCameraEverJoined's own comment). Confirms the guard actually holds
    // end-to-end: neither door writes a take, and the clip counter never
    // moves for a camera that physically never rolled.
    // ===================================================================
    console.log('\n== single-cam+sound, sound solo, camera never joined: neither door fabricates a clip ==');
    await seed(cdp, { multi: false, sound: true });
    await openRoll(cdp);
    await cdp.tapSelector('.camslot--edit .camslot__main'); // roll SOUND alone - the camera is never touched
    await cdp.waitForExpr(`document.querySelector('.roll--live')`, { desc: 'sound rolling solo' });
    await sleep(600);
    await fireBackgrounding(cdp);
    await cdp.navigate(BASE_URL);
    await cdp.waitForExpr(`document.body.textContent.includes('Take recovered')`, { desc: 'recovery prompt', timeout: 15000 });
    await sleep(150);
    await cdp.shot(join(OUT_DIR, '06-sound-solo-recovery-prompt.png'));
    const soundSoloPromptText = await cdp.evaluate(`document.querySelector('.sheet')?.textContent ?? ''`);
    check(
      'sound-solo recovery banner names the sound file, not a fabricated camera clip',
      soundSoloPromptText.includes('SND_0001') && !soundSoloPromptText.includes('C0001'),
      soundSoloPromptText,
    );
    await cdp.waitForExpr(CLICK_BY_TEXT('Cut it now'), { desc: '"Cut it now" clickable' });
    await sleep(300);
    const afterSoundSoloCut = await cdp.evaluate(`
      (async () => {
        const { store } = await import('/src/store/index.ts');
        const projects = await store.listProjects();
        const project = await store.getProject(projects[0].id);
        const slates = await store.listSlates(project.id);
        const takes = await store.listTakes(slates[0].id);
        return { nextClipNumber: project.nextClipNumber, takeCount: takes.length };
      })()
    `);
    check(
      '"Cut it now" on a sound-solo checkpoint writes NOTHING - mirrors abortPendingTake, never fabricates a camera clip',
      afterSoundSoloCut.takeCount === 0 && afterSoundSoloCut.nextClipNumber === 1,
      JSON.stringify(afterSoundSoloCut),
    );
    const checkpointAfterSoundSoloCut = await readCheckpointRaw(cdp);
    check('checkpoint still cleared even though nothing was written', checkpointAfterSoundSoloCut === null);

    console.log(`\nPNGs in ${OUT_DIR}`);
    console.log(fail === 0 ? `\nALL ${pass} PASS.` : `\n${fail} FAILURES out of ${pass + fail}.`);
    process.exitCode = fail === 0 ? 0 : 1;
  } finally {
    chrome.kill();
  }
}

main().catch((err) => {
  console.error(err);
  process.exitCode = 1;
});
