#!/usr/bin/env node
// THE ANALYTICS REPORT.
//
// One self-contained HTML file with the funnel the owner actually wants to
// see: landing view -> app open -> project created -> shot list uploaded ->
// ROLL pressed -> export. It runs the queries here, at generation time, and
// bakes the results into the page as a plain JS object. That is the whole
// reason this is a script and not a live page: the Supabase access token
// stays on this machine and never touches anything that ends up in a
// browser, committed file, or GitHub Pages deploy.
//
//   node scripts/analytics-report.mjs                # writes the default path
//   node scripts/analytics-report.mjs --out <file>    # writes somewhere else
//
// Reads the `sbp_...` personal access token out of credentials.md (gitignored,
// chmod 600) - never hardcode it, never pass it on the command line where a
// shell history or a process list would keep it.
//
// THE CONTAMINATION BOUNDARY. Before commit 92c31ac ("events fire from the
// live site and nowhere else", merged 2026-08-20 23:22:29 +05:30 /
// 2026-08-20T17:52:29Z UTC), `track()` fired from ANY host - a dev server, a
// file:// preview, someone's laptop running the app in a loop. On 2026-08-20
// alone, 954 `app_open` rows came from just 18 distinct visitors and one
// visitor's ip_hash produced 128 `project_created` rows in a single day -
// nobody clicks New Project 128 times. That is automated traffic, not a
// human being. GATE_TS below is that commit's timestamp, hardcoded rather
// than inferred from the data, because inferring "where does it look clean"
// is exactly the kind of judgment call that quietly drifts every time this
// script is re-run against a bigger table.

import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const REPO_ROOT = fileURLToPath(new URL('..', import.meta.url));
const PROJECT_REF = 'sqqdivfgdfaztfzrzkhu';
const GATE_TS = new Date('2026-08-20T17:52:29Z'); // commit 92c31ac - see header
const IST_OFFSET_MIN = 5.5 * 60; // Asia/Kolkata is a fixed +05:30, no DST

// The exact funnel the owner asked for, in order. `keepwarm` (the 3-day GH
// Actions heartbeat) is deliberately not in this list and is excluded from
// every query below - it is a synthetic row with a real ip_hash (the GH
// runner's), so left in it counts as a fake "visitor" every few days.
const FUNNEL = [
  { name: 'landing_view', label: 'Landing view' },
  { name: 'app_open', label: 'App open' },
  { name: 'project_created', label: 'Project created' },
  { name: 'shotlist_uploaded', label: 'Shot list uploaded', pending: 'instrumented 2026-08-22, ships next deploy' },
  { name: 'roll', label: 'ROLL pressed' },
  { name: 'export', label: 'Export' },
];
const WINDOWS = [3, 7, 30];
const OUT_DEFAULT = '/Users/purohit/Desktop/clapper-analytics/index.html';

function readToken() {
  const path = join(REPO_ROOT, 'credentials.md');
  let text;
  try {
    text = readFileSync(path, 'utf8');
  } catch {
    throw new Error(`Can't read ${path} - is credentials.md present and readable?`);
  }
  const m = text.match(/sbp_[A-Za-z0-9]+/);
  if (!m) {
    throw new Error(`No sbp_ access token found in ${path}. Add the Supabase personal access token line first.`);
  }
  return m[0];
}

async function runQuery(token, sql) {
  const res = await fetch(`https://api.supabase.com/v1/projects/${PROJECT_REF}/database/query`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ query: sql }),
  });
  const body = await res.json();
  if (!res.ok || body?.message) {
    throw new Error(`Supabase query failed: ${body?.message ?? res.status}`);
  }
  return body;
}

// One raw pull, then all aggregation happens in JS below. 31 days of events
// is ~10k rows as of this writing - small enough to fetch whole and cheaper
// to reason about than three windows' worth of hand-tuned SQL that has to
// agree with each other.
async function fetchEvents(token) {
  const rows = await runQuery(
    token,
    `select name, ip_hash, user_id, created_at
     from events
     where name != 'keepwarm'
       and created_at > now() - interval '31 days'
     order by created_at asc;`,
  );
  return rows.map((r) => ({
    name: r.name,
    ip: r.ip_hash, // null for the ~0.5% of rows that predate the ip_hash trigger
    signedIn: r.user_id !== null,
    at: new Date(r.created_at),
  }));
}

// Asia/Kolkata calendar day for a UTC instant, as 'YYYY-MM-DD'. Fixed offset,
// no DST, so this is arithmetic rather than a timezone-database lookup.
function istDay(date) {
  const shifted = new Date(date.getTime() + IST_OFFSET_MIN * 60000);
  return shifted.toISOString().slice(0, 10);
}

// UTC instant of 00:00 IST on the given 'YYYY-MM-DD' calendar day.
function istDayStartUTC(day) {
  return new Date(new Date(`${day}T00:00:00.000Z`).getTime() - IST_OFFSET_MIN * 60000);
}

function dayTag(day) {
  const start = istDayStartUTC(day);
  const end = new Date(start.getTime() + 24 * 3600 * 1000);
  if (end <= GATE_TS) return 'dirty'; // whole IST day is pre-gate
  if (start >= GATE_TS) return 'clean'; // whole IST day is post-gate
  return 'mixed'; // the gate shipped partway through this IST day
}

function distinctVisitors(rows) {
  return new Set(rows.filter((r) => r.ip).map((r) => r.ip)).size;
}

function funnelFor(rows) {
  return FUNNEL.map((step) => {
    const stepRows = rows.filter((r) => r.name === step.name);
    return { ...step, events: stepRows.length, visitors: distinctVisitors(stepRows) };
  });
}

function perDayFor(rows) {
  const days = new Map();
  for (const r of rows) {
    const d = istDay(r.at);
    if (!days.has(d)) days.set(d, []);
    days.get(d).push(r);
  }
  return [...days.keys()]
    .sort()
    .reverse()
    .map((d) => {
      const dayRows = days.get(d);
      return {
        day: d,
        tag: dayTag(d),
        visitors: distinctVisitors(dayRows),
        steps: FUNNEL.map((step) => {
          const stepRows = dayRows.filter((r) => r.name === step.name);
          return { name: step.name, events: stepRows.length, visitors: distinctVisitors(stepRows) };
        }),
      };
    });
}

// Per-visitor rollup, ordered by rolls desc per the spec - that ordering is
// deliberate: it surfaces the heaviest single ip_hash first, which is exactly
// how the 128-projects-in-a-day visitor gets noticed instead of averaged away.
function perVisitorFor(rows) {
  const byIp = new Map();
  for (const r of rows) {
    if (!r.ip) continue;
    if (!byIp.has(r.ip)) byIp.set(r.ip, []);
    byIp.get(r.ip).push(r);
  }
  const count = (list, name) => list.filter((r) => r.name === name).length;
  return [...byIp.entries()]
    .map(([ip, list]) => {
      const firstSeen = list.reduce((min, r) => (r.at < min ? r.at : min), list[0].at);
      return {
        ip: ip.slice(0, 12), // enough to eyeball "is this the same visitor as that row above", not an identity
        firstSeen,
        firstSeenTag: firstSeen < GATE_TS ? 'dirty' : 'clean',
        landingViews: count(list, 'landing_view'),
        appOpens: count(list, 'app_open'),
        projects: count(list, 'project_created'),
        shotlistUploads: count(list, 'shotlist_uploaded'),
        rolls: count(list, 'roll'),
        exports: count(list, 'export'),
        signedIn: list.some((r) => r.signedIn),
      };
    })
    .sort((a, b) => b.rolls - a.rolls);
}

function buildWindow(allRows, days) {
  const start = new Date(Date.now() - days * 24 * 3600 * 1000);
  const rows = allRows.filter((r) => r.at >= start);
  const preGate = rows.filter((r) => r.at < GATE_TS);
  const postGate = rows.filter((r) => r.at >= GATE_TS);
  return {
    days,
    windowStartsBeforeGate: start < GATE_TS,
    totalEvents: rows.length,
    preGateEvents: preGate.length,
    postGateEvents: postGate.length,
    funnel: funnelFor(rows),
    funnelCleanOnly: funnelFor(postGate),
    perDay: perDayFor(rows),
    perVisitor: perVisitorFor(rows),
  };
}

function esc(s) {
  return String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

function renderHTML(data) {
  const dataJSON = JSON.stringify(data).replace(/</g, '\\u003c'); // never let a literal `</script>` land in the payload
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Clapper - Analytics</title>
<style>
  :root {
    --bg: #000;
    --ink: #ece9e1;
    --ink-dim: rgba(236, 233, 225, 0.52);
    --ink-faint: rgba(236, 233, 225, 0.22);
    --accent: #fff;
    --line: rgba(236, 233, 225, 0.16);
    --mono: 'SF Mono', 'JetBrains Mono', ui-monospace, Menlo, Consolas, monospace;
    --sans: -apple-system, BlinkMacSystemFont, 'Segoe UI', Helvetica, Arial, sans-serif;
  }
  * { box-sizing: border-box; }
  body {
    margin: 0;
    background: var(--bg);
    color: var(--ink);
    font-family: var(--sans);
    line-height: 1.45;
    padding: 32px 20px 80px;
  }
  .wrap { max-width: 980px; margin: 0 auto; }
  h1 { font-size: 20px; font-weight: 600; letter-spacing: -0.01em; margin: 0 0 4px; }
  .sub { color: var(--ink-dim); font-size: 13px; margin: 0 0 28px; }
  .sub b { color: var(--ink); font-weight: 600; }

  .tabs { display: flex; gap: 8px; margin-bottom: 22px; }
  .tab {
    font-family: var(--mono);
    font-size: 13px;
    color: var(--ink-dim);
    background: transparent;
    border: 1px solid var(--line);
    border-radius: 8px;
    padding: 7px 14px;
    cursor: pointer;
  }
  .tab[aria-pressed="true"] { color: #000; background: var(--accent); border-color: var(--accent); font-weight: 600; }

  .warn {
    background: var(--accent);
    color: #000;
    border-radius: 10px;
    padding: 16px 18px;
    margin-bottom: 24px;
    font-size: 13px;
    line-height: 1.55;
    display: none;
  }
  .warn.show { display: block; }
  .warn .tag {
    font-family: var(--mono);
    font-weight: 700;
    letter-spacing: 0.04em;
    font-size: 11px;
    text-transform: uppercase;
    margin-bottom: 6px;
    display: block;
  }
  .warn b { font-weight: 700; }
  .warn .split { font-family: var(--mono); margin-top: 8px; opacity: 0.75; font-size: 12px; }

  section { margin-bottom: 36px; }
  h2 {
    font-size: 12px;
    text-transform: uppercase;
    letter-spacing: 0.08em;
    color: var(--ink-dim);
    font-weight: 600;
    margin: 0 0 14px;
  }

  .funnel { display: flex; flex-wrap: wrap; gap: 0; border: 1px solid var(--line); border-radius: 12px; overflow: hidden; }
  .step { flex: 1 1 150px; padding: 16px 14px; border-right: 1px solid var(--line); position: relative; }
  .step:last-child { border-right: none; }
  .step .lbl { font-size: 11px; color: var(--ink-dim); margin-bottom: 8px; text-transform: uppercase; letter-spacing: 0.04em; }
  .step .n { font-family: var(--mono); font-size: 26px; font-weight: 600; color: var(--accent); }
  .step .v { font-family: var(--mono); font-size: 12px; color: var(--ink-dim); margin-top: 4px; }
  .step .drop { font-family: var(--mono); font-size: 11px; color: var(--ink-faint); margin-top: 6px; }
  .step .pending { font-family: var(--sans); font-size: 10.5px; color: var(--accent); margin-top: 6px; line-height: 1.35; }

  .clean-funnel { margin-top: 14px; }
  .clean-funnel .funnel { border-color: var(--ink-faint); }
  .clean-funnel .step .n { color: var(--ink); }

  table { width: 100%; border-collapse: collapse; font-size: 12.5px; }
  th, td { text-align: left; padding: 8px 10px; border-bottom: 1px solid var(--line); white-space: nowrap; }
  th { color: var(--ink-dim); font-weight: 500; text-transform: uppercase; font-size: 10.5px; letter-spacing: 0.04em; }
  td.num, th.num { font-family: var(--mono); text-align: right; }
  .tblwrap { overflow-x: auto; border: 1px solid var(--line); border-radius: 12px; }
  .tblwrap table { min-width: 640px; }
  tr.dirty td.day::after { content: ' ·dirty'; color: var(--ink-faint); font-family: var(--mono); font-size: 10px; }
  tr.mixed td.day::after { content: ' ·mixed'; color: var(--ink-faint); font-family: var(--mono); font-size: 10px; }
  tr.dirty, tr.mixed { opacity: 0.62; }
  .pill { font-family: var(--mono); font-size: 10px; padding: 1px 6px; border-radius: 999px; border: 1px solid var(--ink-faint); color: var(--ink-dim); }
  .yes { color: var(--accent); }
  .note { color: var(--ink-dim); font-size: 11.5px; margin-top: 10px; }
  footer { margin-top: 50px; color: var(--ink-faint); font-size: 11px; font-family: var(--mono); border-top: 1px solid var(--line); padding-top: 16px; }
</style>
</head>
<body>
<div class="wrap">
  <h1>Clapper - Analytics</h1>
  <p class="sub">Generated <b id="genAt"></b> · funnel: landing view → app open → project created → shot list uploaded → ROLL pressed → export</p>

  <div class="tabs" role="tablist">
    <button class="tab" data-days="3" aria-pressed="true">Last 3 days</button>
    <button class="tab" data-days="7" aria-pressed="false">Last 7 days</button>
    <button class="tab" data-days="30" aria-pressed="false">Last 30 days</button>
  </div>

  <div class="warn" id="warn">
    <span class="tag">⚠ contaminated window</span>
    This window includes traffic from before the live-host gate shipped
    (<b>2026-08-20 23:22 IST</b> - commit <code>92c31ac</code>). Before that,
    <code>track()</code> fired from dev servers and local previews, not just
    the real site. On 2026-08-20 alone, one visitor's <code>ip_hash</code>
    produced <b>128 <code>project_created</code> rows in a single day</b> -
    that is a script, not a person. The numbers below include that traffic.
    A second funnel further down, marked <b>clean since gate</b>, counts only
    events after the gate shipped.
    <div class="split" id="warnSplit"></div>
  </div>

  <section>
    <h2>Funnel - this window</h2>
    <div class="funnel" id="funnel"></div>
  </section>

  <section id="cleanSection" style="display:none">
    <h2>Funnel - clean since gate (post-2026-08-20 23:22 IST only)</h2>
    <div class="clean-funnel"><div class="funnel" id="funnelClean"></div></div>
    <p class="note">Same window, but only events recorded after the live-host gate shipped. This is the honest read of real traffic in a contaminated window.</p>
  </section>

  <section>
    <h2>Per day (Asia/Kolkata calendar day)</h2>
    <div class="tblwrap">
      <table id="dayTable"></table>
    </div>
    <p class="note">Rows marked <code>·dirty</code> are entirely before the gate; <code>·mixed</code> straddles the moment it shipped. Unmarked rows are clean.</p>
  </section>

  <section>
    <h2>Per visitor, ordered by ROLLs</h2>
    <div class="tblwrap">
      <table id="visitorTable"></table>
    </div>
    <p class="note">
      <code>ip_hash</code> is a one-way SHA-256 of the visitor's IP, never the IP itself - this table can tell you it's the same
      visitor across rows, never who they are. "First seen" tagged <code>dirty</code> means their earliest event in this window predates the gate.
      <b>shot list uploaded</b> reads 0 everywhere until the next deploy - this event was added 2026-08-22 and has not shipped yet.
    </p>
  </section>

  <footer id="foot"></footer>
</div>

<script>
const DATA = ${dataJSON};

function fmtDate(iso) {
  const d = new Date(iso);
  return d.toLocaleString('en-GB', { timeZone: 'Asia/Kolkata', day: '2-digit', month: 'short', hour: '2-digit', minute: '2-digit' }) + ' IST';
}

function renderFunnel(el, steps) {
  el.innerHTML = steps.map((s, i) => {
    const prev = i > 0 ? steps[i - 1].visitors : null;
    const drop = prev && prev > 0 ? Math.round((1 - s.visitors / prev) * 100) : null;
    return \`<div class="step">
      <div class="lbl">\${s.label}</div>
      <div class="n">\${s.events.toLocaleString()}</div>
      <div class="v">\${s.visitors.toLocaleString()} visitors</div>
      \${s.pending ? \`<div class="pending">\${s.pending}</div>\` : (drop !== null ? \`<div class="drop">\${drop >= 0 ? '-' + drop : '+' + Math.abs(drop)}% vs prev step</div>\` : '')}
    </div>\`;
  }).join('');
}

function renderDayTable(el, rows) {
  const head = '<tr><th>Day</th>' + DATA.stepNames.map((s) => \`<th class="num">\${s}</th>\`).join('') + '<th class="num">Visitors</th></tr>';
  const body = rows.map((r) => {
    const cells = r.steps.map((s) => \`<td class="num">\${s.events}</td>\`).join('');
    return \`<tr class="\${r.tag}"><td class="day">\${r.day}</td>\${cells}<td class="num">\${r.visitors}</td></tr>\`;
  }).join('');
  el.innerHTML = head + body;
}

function renderVisitorTable(el, rows) {
  const shown = rows.slice(0, 100);
  const head = '<tr><th>ip_hash</th><th>First seen</th><th class="num">Landing</th><th class="num">Opens</th><th class="num">Projects</th><th class="num">Uploads</th><th class="num">Rolls</th><th class="num">Exports</th><th>Signed in</th></tr>';
  const body = shown.map((v) => \`<tr>
    <td><code>\${v.ip}…</code> <span class="pill">\${v.firstSeenTag}</span></td>
    <td>\${fmtDate(v.firstSeen)}</td>
    <td class="num">\${v.landingViews}</td>
    <td class="num">\${v.appOpens}</td>
    <td class="num">\${v.projects}</td>
    <td class="num">\${v.shotlistUploads}</td>
    <td class="num">\${v.rolls}</td>
    <td class="num">\${v.exports}</td>
    <td class="\${v.signedIn ? 'yes' : ''}">\${v.signedIn ? 'yes' : 'no'}</td>
  </tr>\`).join('');
  el.innerHTML = head + body + (rows.length > shown.length ? \`<tr><td colspan="9" class="note" style="padding:10px">…and \${rows.length - shown.length} more, cut off for length</td></tr>\` : '');
}

function show(days) {
  const w = DATA.windows[days];
  document.querySelectorAll('.tab').forEach((t) => t.setAttribute('aria-pressed', String(Number(t.dataset.days) === days)));

  const warn = document.getElementById('warn');
  const cleanSection = document.getElementById('cleanSection');
  if (w.windowStartsBeforeGate) {
    warn.classList.add('show');
    cleanSection.style.display = '';
    document.getElementById('warnSplit').textContent =
      w.totalEvents.toLocaleString() + ' events in this window · ' + w.preGateEvents.toLocaleString() + ' before the gate, ' + w.postGateEvents.toLocaleString() + ' after.';
  } else {
    warn.classList.remove('show');
    cleanSection.style.display = 'none';
  }

  renderFunnel(document.getElementById('funnel'), w.funnel);
  renderFunnel(document.getElementById('funnelClean'), w.funnelCleanOnly);
  renderDayTable(document.getElementById('dayTable'), w.perDay);
  renderVisitorTable(document.getElementById('visitorTable'), w.perVisitor);
}

document.querySelectorAll('.tab').forEach((t) => t.addEventListener('click', () => show(Number(t.dataset.days))));
document.getElementById('genAt').textContent = new Date(DATA.generatedAt).toLocaleString('en-GB', { timeZone: 'Asia/Kolkata', dateStyle: 'medium', timeStyle: 'short' }) + ' IST';
document.getElementById('foot').textContent = 'clapper-analytics · scripts/analytics-report.mjs · project ' + DATA.projectRef;
show(3);
</script>
</body>
</html>
`;
}

async function main() {
  const outArgIdx = process.argv.indexOf('--out');
  const outPath = outArgIdx !== -1 ? resolve(process.argv[outArgIdx + 1]) : OUT_DEFAULT;

  const token = readToken();
  const allRows = await fetchEvents(token);

  const windows = {};
  for (const days of WINDOWS) windows[days] = buildWindow(allRows, days);

  const data = {
    generatedAt: new Date().toISOString(),
    projectRef: PROJECT_REF,
    gateTs: GATE_TS.toISOString(),
    stepNames: FUNNEL.map((f) => f.label),
    windows,
  };

  mkdirSync(dirname(outPath), { recursive: true });
  writeFileSync(outPath, renderHTML(data), 'utf8');
  console.log(`Wrote ${outPath}`);
  console.log(`Fetched ${allRows.length} events over the last 31 days (keepwarm excluded).`);
  for (const days of WINDOWS) {
    const w = windows[days];
    console.log(
      `  last ${days}d: ${w.totalEvents} events, ${w.perVisitor.length} distinct visitors` +
        (w.windowStartsBeforeGate ? ` (${w.preGateEvents} pre-gate / ${w.postGateEvents} post-gate)` : ' (clean)'),
    );
  }
}

main().catch((err) => {
  console.error(err.message ?? err);
  process.exit(1);
});
