/* View renderers. Each exports `render(root, ctx)` and may return a cleanup fn.
 *
 * Views own their own data fetching so they can be opened directly by URL, and
 * they re-read from the API rather than trusting any client-side cache — the
 * fleet state changes every couple of seconds, so a stale render is a wrong one.
 */

import { api } from './api.js';
import {
  bandColor, bandPill, closeDrawer, confidenceMeter, emptyState, esc, fmt, icon,
  loading, markdown, openDrawer, priorityBadge, retrofitTag, severityPill,
  statusPill, toast,
} from './ui.js';
import { bandRibbon, divergingBars, hideTip, rankedBars, sparkline, timeSeries } from './charts.js';

/* ==========================================================================
   Dashboard
   ========================================================================== */
export async function dashboard(root, ctx) {
  root.innerHTML = loading();
  const [overview, trends, fleet, industries] = await Promise.all([
    api.overview(), api.trends(6), api.fleet(), api.industries(),
  ]);

  const h = overview.health;
  const wo = overview.work_orders;
  const m90 = overview.maintenance_90d;
  const atRisk = fleet.machines
    .filter((x) => x.failure_prob !== null)
    .sort((a, b) => (b.failure_prob || 0) - (a.failure_prob || 0))
    .slice(0, 6);

  root.innerHTML = `
    <div class="page-head">
      <div>
        <h1>Fleet overview</h1>
        <div class="sub">${overview.machines.total} machines across 10 plants ·
          ${overview.machines.retrofit} monitored via EdgeSense retrofit
          (${overview.machines.retrofit_pct}%)</div>
      </div>
      <div class="actions">
        <button class="btn btn-sm" data-refresh>${icon('refresh', 14)}Refresh</button>
      </div>
    </div>

    <div class="grid grid-kpi mb">
      <div class="card tile">
        <div class="label">${icon('gauge', 12)}Fleet health</div>
        <div class="value num">${h.avg ?? '—'}<span class="unit">/100</span></div>
        <div class="foot">${h.bands.critical} critical · ${h.bands.degraded} degraded</div>
        <div class="spark" data-spark-health></div>
      </div>
      <div class="card tile">
        <div class="label">${icon('bell', 12)}Open alerts</div>
        <div class="value num">${overview.alerts.open ?? 0}</div>
        <div class="foot">${overview.alerts.critical_open ?? 0} critical ·
          ${overview.alerts.last_24h ?? 0} raised in 24h</div>
      </div>
      <div class="card tile">
        <div class="label">${icon('clipboard', 12)}Work orders</div>
        <div class="value num">${wo.total ?? 0}</div>
        <div class="foot">${wo.pending ?? 0} awaiting approval ·
          ${fmt.money(wo.open_cost)} planned</div>
      </div>
      <div class="card tile">
        <div class="label">${icon('shield', 12)}Evidence confidence</div>
        <div class="value num">${h.avg_confidence ? Math.round(h.avg_confidence * 100) : '—'}<span class="unit">%</span></div>
        <div class="foot">Mean across all monitored assets</div>
      </div>
      <div class="card tile">
        <div class="label">${icon('history', 12)}Planned vs reactive</div>
        <div class="value num">${Math.round((m90.planned_ratio || 0) * 100)}<span class="unit">%</span></div>
        <div class="foot">${m90.planned} planned · ${m90.reactive} reactive (90d)</div>
      </div>
    </div>

    <div class="grid grid-2 mb">
      <div class="card">
        <div class="card-head"><h2>Fleet health · last 6 hours</h2></div>
        <div class="card-body"><div data-chart-trend></div></div>
      </div>
      <div class="card">
        <div class="card-head"><h2>Health distribution</h2></div>
        <div class="card-body">
          <div data-chart-bands></div>
          <div style="margin-top:18px">
            <h3 style="margin-bottom:9px">Developing failure modes</h3>
            <div data-chart-modes></div>
          </div>
        </div>
      </div>
    </div>

    <div class="grid grid-2">
      <div class="card">
        <div class="card-head">
          <h2>Highest predicted risk</h2>
          <div class="actions"><button class="btn btn-sm btn-ghost" data-goto="fleet">View all</button></div>
        </div>
        <div class="table-wrap">
          ${atRisk.length ? `<table class="data">
            <thead><tr>
              <th>Machine</th><th class="num">P(fail)</th><th class="num">RUL</th>
              <th class="num">Health</th><th>Mode</th>
            </tr></thead>
            <tbody>${atRisk.map((x) => `
              <tr class="clickable" data-machine="${x.id}">
                <td>
                  <div style="display:flex;align-items:center;gap:7px">
                    <strong class="mono">${esc(x.code)}</strong>
                    ${x.retrofit ? retrofitTag() : ''}
                  </div>
                  <div class="muted" style="font-size:11.5px">${esc(x.name)}</div>
                </td>
                <td class="num"><strong>${fmt.pct(x.failure_prob)}</strong></td>
                <td class="num">${fmt.hours(x.rul_hours)}</td>
                <td class="num">${x.health_score?.toFixed(0) ?? '—'}</td>
                <td>${bandPill(x.health_band)}</td>
              </tr>`).join('')}</tbody>
          </table>` : emptyState('No predictions yet — the pipeline is still warming up.', 'check')}
        </div>
      </div>

      <div class="card">
        <div class="card-head"><h2>Coverage by industry</h2></div>
        <div class="table-wrap">
          <table class="data">
            <thead><tr>
              <th>Industry</th><th class="num">Assets</th><th class="num">Retrofit</th>
              <th class="num">Health</th><th class="num">Alerts</th>
            </tr></thead>
            <tbody>${industries.industries.map((r) => `
              <tr>
                <td>${esc(r.industry)}</td>
                <td class="num">${r.machines}</td>
                <td class="num">${r.retrofits}</td>
                <td class="num">${r.avg_health ?? '—'}</td>
                <td class="num">${r.open_alerts}</td>
              </tr>`).join('')}</tbody>
          </table>
        </div>
      </div>
    </div>`;

  // charts
  const trendPoints = trends.buckets.map((b) => ({ ts: b.ts, health: b.health, confidence: b.confidence * 100 }));
  timeSeries(root.querySelector('[data-chart-trend]'), {
    points: trendPoints,
    yMin: 0, yMax: 100,
    yLabel: 'Fleet health',
    series: [
      { key: 'health', label: 'Mean health score', color: 'var(--series-1)', area: true,
        format: (v) => v.toFixed(1) },
      { key: 'confidence', label: 'Evidence confidence %', color: 'var(--series-2)',
        format: (v) => `${v.toFixed(0)}%` },
    ],
  });

  bandRibbon(root.querySelector('[data-chart-bands]'), h.bands);

  const modes = (trends.failure_mix || []).map((m) => ({ label: m.label, value: m.count, unit: 'Predictions' }));
  rankedBars(root.querySelector('[data-chart-modes]'), modes.length ? modes : [], {
    color: 'var(--series-1)',
  });
  if (!modes.length) {
    root.querySelector('[data-chart-modes]').innerHTML =
      '<div class="empty" style="padding:20px">No failure modes developing.</div>';
  }

  const sparkValues = trends.buckets.map((b) => b.health);
  root.querySelector('[data-spark-health]').appendChild(
    sparkline(sparkValues, { color: 'var(--series-1)' })
  );

  root.querySelectorAll('[data-machine]').forEach((row) =>
    row.addEventListener('click', () => ctx.go(`machine/${row.dataset.machine}`)));
  root.querySelector('[data-goto]')?.addEventListener('click', () => ctx.go('fleet'));
  root.querySelector('[data-refresh]')?.addEventListener('click', () => ctx.reload());
}

/* ==========================================================================
   Fleet grid
   ========================================================================== */
export async function fleetView(root, ctx) {
  root.innerHTML = loading();
  const [fleet, plants] = await Promise.all([api.fleet(), api.plants()]);
  const state = { band: '', plant: '', retrofit: '', q: ctx.search || '' };

  root.innerHTML = `
    <div class="page-head">
      <div>
        <h1>Machines</h1>
        <div class="sub">${fleet.summary.total} assets · mean health
          ${fleet.summary.avg_health ?? '—'}/100</div>
      </div>
    </div>
    <div class="filter-bar">
      <input class="input" data-q placeholder="Search code, name or plant…"
             value="${esc(state.q)}" style="min-width:216px">
      <select class="select" data-band>
        <option value="">All health bands</option>
        <option value="healthy">Healthy</option>
        <option value="watch">Watch</option>
        <option value="degraded">Degraded</option>
        <option value="critical">Critical</option>
      </select>
      <select class="select" data-plant>
        <option value="">All plants</option>
        ${plants.plants.map((p) => `<option value="${p.id}">${esc(p.name)}</option>`).join('')}
      </select>
      <div class="seg" data-retrofit>
        <button class="on" data-v="">All</button>
        <button data-v="true">EdgeSense</button>
        <button data-v="false">Instrumented</button>
      </div>
      <span class="muted" data-count style="margin-left:auto"></span>
    </div>
    <div class="machine-grid" data-grid></div>`;

  const grid = root.querySelector('[data-grid]');
  const countEl = root.querySelector('[data-count]');

  function paint() {
    let items = fleet.machines;
    if (state.band) items = items.filter((m) => m.health_band === state.band);
    if (state.plant) items = items.filter((m) => String(m.plant_id) === state.plant);
    if (state.retrofit !== '') items = items.filter((m) => String(m.retrofit) === state.retrofit);
    if (state.q) {
      const q = state.q.toLowerCase();
      items = items.filter((m) =>
        m.code.toLowerCase().includes(q) ||
        m.name.toLowerCase().includes(q) ||
        m.plant_name.toLowerCase().includes(q));
    }

    countEl.textContent = `${items.length} of ${fleet.machines.length} shown`;
    grid.innerHTML = items.length
      ? items.map((m) => `
        <article class="machine-card" data-band="${m.health_band}" data-id="${m.id}"
                 tabindex="0" role="button" aria-label="${esc(m.code)} ${esc(m.name)}">
          <div class="top">
            <div style="min-width:0">
              <div class="code">${esc(m.code)}</div>
              <div class="name">${esc(m.name)}</div>
              <div class="plant">${esc(m.plant_name)}</div>
            </div>
            <div class="score-wrap">
              <div class="score" style="color:${bandColor(m.health_band)}">
                ${m.health_score?.toFixed(0) ?? '—'}</div>
              <div class="score-lbl">Health</div>
            </div>
          </div>
          ${m.failure_prob !== null ? `
            <div style="display:flex;gap:14px;font-size:12px" class="secondary">
              <span>P(fail) <strong class="num">${fmt.pct(m.failure_prob)}</strong></span>
              <span>RUL <strong class="num">${fmt.hours(m.rul_hours)}</strong></span>
            </div>` : '<div class="muted" style="font-size:12px">Awaiting prediction</div>'}
          <div style="margin-top:9px">${confidenceMeter(m.confidence, m.confidence_band)}</div>
          <div class="facts">
            ${bandPill(m.health_band)}
            ${m.retrofit ? retrofitTag() : ''}
            ${m.open_alerts ? `<span class="pill pill-critical">${icon('bell', 11)}${m.open_alerts}</span>` : ''}
            ${m.open_work_orders ? `<span class="pill pill-info">${icon('clipboard', 11)}${m.open_work_orders}</span>` : ''}
          </div>
        </article>`).join('')
      : emptyState('No machines match these filters.', 'search');

    grid.querySelectorAll('.machine-card').forEach((card) => {
      const go = () => ctx.go(`machine/${card.dataset.id}`);
      card.addEventListener('click', go);
      card.addEventListener('keydown', (e) => {
        if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); go(); }
      });
    });
  }

  root.querySelector('[data-q]').addEventListener('input', (e) => {
    state.q = e.target.value; paint();
  });
  root.querySelector('[data-band]').addEventListener('change', (e) => {
    state.band = e.target.value; paint();
  });
  root.querySelector('[data-plant]').addEventListener('change', (e) => {
    state.plant = e.target.value; paint();
  });
  root.querySelectorAll('[data-retrofit] button').forEach((b) =>
    b.addEventListener('click', () => {
      root.querySelectorAll('[data-retrofit] button').forEach((x) => x.classList.remove('on'));
      b.classList.add('on');
      state.retrofit = b.dataset.v;
      paint();
    }));

  paint();
}

/* ==========================================================================
   Machine detail
   ========================================================================== */
export async function machineView(root, ctx, machineId) {
  root.innerHTML = loading();
  const [detail, detect] = await Promise.all([
    api.machine(machineId),
    api.detectability(machineId).catch(() => null),
  ]);
  const m = detail.machine;

  const explanation = (detail.explanation || []).map((e) => ({
    label: e.label, value: e.shap_value, observed: e.observed, deviation: e.deviation_pct,
  }));

  root.innerHTML = `
    <div class="page-head">
      <button class="icon-btn" data-back aria-label="Back to fleet">${icon('arrowLeft', 18)}</button>
      <div>
        <h1 style="display:flex;align-items:center;gap:9px">
          <span class="mono">${esc(m.code)}</span> ${esc(m.name)}
          ${m.retrofit ? retrofitTag() : ''}
        </h1>
        <div class="sub">${esc(m.plant_name)} · ${esc(m.industry)} ·
          ${esc(m.manufacturer || '')} ${esc(m.model || '')} · installed ${m.install_year} ·
          ${m.rated_power_kw} kW · criticality ${esc(m.criticality)}</div>
      </div>
      <div class="actions">
        <button class="btn btn-sm" data-analyze>${icon('cpu', 14)}Re-analyse</button>
      </div>
    </div>

    <div class="grid grid-kpi mb">
      <div class="card tile">
        <div class="label">${icon('gauge', 12)}Health score</div>
        <div class="value num" style="color:${bandColor(m.health_band)}">
          ${m.health_score?.toFixed(0) ?? '—'}<span class="unit">/100</span></div>
        <div class="foot">${bandPill(m.health_band)}</div>
      </div>
      <div class="card tile">
        <div class="label">${icon('alert', 12)}Failure probability</div>
        <div class="value num">${m.failure_prob !== null ? fmt.pct(m.failure_prob) : '—'}</div>
        <div class="foot">Anomaly score ${m.anomaly_score?.toFixed(2) ?? '—'}</div>
      </div>
      <div class="card tile">
        <div class="label">${icon('history', 12)}Remaining useful life</div>
        <div class="value num">${fmt.hours(m.rul_hours)}</div>
        <div class="foot">${m.category_label ? esc(m.category_label) : 'No fault developing'}</div>
      </div>
      <div class="card tile">
        <div class="label">${icon('shield', 12)}Evidence confidence</div>
        <div class="value num">${Math.round((m.confidence || 0) * 100)}<span class="unit">%</span></div>
        <div class="foot">${esc(fmt.title(m.confidence_band))} ·
          ${m.retrofit ? 'fused estimate' : 'direct measurement'}</div>
      </div>
    </div>

    <div class="grid grid-detail mb">
      <div class="card">
        <div class="card-head"><h2>Health and anomaly history</h2></div>
        <div class="card-body"><div data-chart-history></div></div>
      </div>
      <div class="card">
        <div class="card-head"><h2>Root cause</h2></div>
        <div class="card-body">
          ${m.root_cause ? `<p class="secondary" style="font-size:13px;line-height:1.6">
            ${esc(m.root_cause)}</p>` :
            '<p class="muted">No fault mechanism currently developing.</p>'}
          ${m.retrofit ? `<div class="notice" style="margin-top:12px">${icon('antenna', 15)}
            <div>State is inferred from external EdgeSense devices, not measured on the
            machine. Trends are reliable; treat absolute values as estimates.</div></div>` : ''}
        </div>
      </div>
    </div>

    <div class="grid grid-detail mb">
      <div class="card">
        <div class="card-head">
          <h2>Why this prediction</h2>
          <span class="muted" style="font-size:11.5px;margin-left:auto">
            Monte-Carlo Shapley attribution</span>
        </div>
        <div class="card-body"><div data-chart-shap></div></div>
      </div>
      <div class="card">
        <div class="card-head"><h2>Diagnostic coverage</h2></div>
        <div class="card-body">
          ${detect ? `
            <div style="display:flex;align-items:center;gap:10px;margin-bottom:12px">
              <strong style="font-size:22px" class="num">${Math.round(detect.overall * 100)}%</strong>
              <span class="pill ${detect.band === 'good' ? 'pill-good'
                : detect.band === 'marginal' ? 'pill-watch' : 'pill-degraded'}">
                ${icon(detect.band === 'good' ? 'check' : 'info', 11)}${fmt.title(detect.band)}</span>
            </div>
            <div data-chart-detect></div>
            ${detect.recommendation ? `<div class="notice" style="margin-top:12px">
              ${icon('info', 15)}<div>Adding a <strong>${esc(detect.recommendation.device)}</strong>
              would raise coverage by ${Math.round(detect.recommendation.improvement * 100)}
              points, mainly for ${esc(fmt.title(detect.recommendation.channel))}.</div></div>` : ''}
          ` : '<div class="muted">Coverage report unavailable.</div>'}
        </div>
      </div>
    </div>

    <div class="card mb">
      <div class="card-head">
        <h2>${m.retrofit ? 'EdgeSense sensor fusion' : 'Sensors'}</h2>
        <span class="muted" style="font-size:11.5px;margin-left:auto">
          ${detail.sensors.length} devices</span>
      </div>
      <div class="table-wrap">
        <table class="data">
          <thead><tr>
            <th>Tag</th><th>Device</th><th>Placement</th>
            <th class="num">Reading</th><th class="num">Distance</th>
            <th>Status</th><th>Trend</th>
          </tr></thead>
          <tbody>${detail.sensors.map((s) => `
            <tr>
              <td><strong class="mono">${esc(s.tag)}</strong>
                  <div class="muted" style="font-size:11px">${esc(fmt.title(s.kind))}</div></td>
              <td style="font-size:12.5px">${esc(s.device)}</td>
              <td class="muted" style="font-size:11.5px;max-width:220px">${esc(s.placement)}</td>
              <td class="num">${s.current !== null ? `${fmt.num(s.current, 1)} <span class="muted">${esc(s.unit)}</span>` : '—'}</td>
              <td class="num">${s.source === 'edge' ? `${s.distance_m} m` : 'onboard'}</td>
              <td>${sensorStatusPill(s.status)}</td>
              <td data-spark-sensor="${s.id}" style="width:120px"></td>
            </tr>`).join('')}</tbody>
        </table>
      </div>
    </div>

    ${detail.fusion?.channels ? `
    <div class="card mb">
      <div class="card-head"><h2>Fused channel estimates</h2>
        <span class="muted" style="font-size:11.5px;margin-left:auto">
          mode: ${esc(detail.fusion.mode || 'direct')}</span></div>
      <div class="card-body">
        ${Object.entries(detail.fusion.channels).map(([name, c]) => `
          <div class="fusion-row">
            <div>
              <div style="display:flex;align-items:center;gap:8px">
                <strong style="font-size:12.5px">${esc(fmt.title(name))}</strong>
                ${c.direct ? '<span class="pill pill-good" style="font-size:10px">'
                  + icon('check', 10) + 'Direct</span>'
                  : '<span class="pill pill-neutral" style="font-size:10px">'
                  + icon('antenna', 10) + 'Inferred</span>'}
                <span class="muted" style="font-size:11px">${c.sources} source${c.sources > 1 ? 's' : ''}</span>
              </div>
              <div class="fusion-bar-track">
                <div class="fusion-bar-fill" style="width:${Math.min(100, c.confidence * 100)}%"></div>
              </div>
              <div class="weight-parts">
                <span>coverage ${(c.coverage * 100).toFixed(0)}%</span>
                <span>agreement ${(c.agreement * 100).toFixed(0)}%</span>
              </div>
            </div>
            <div style="text-align:right">
              <div class="num" style="font-weight:640">${c.value_ratio.toFixed(2)}×</div>
              <div class="muted" style="font-size:11px">${(c.confidence * 100).toFixed(0)}% conf</div>
            </div>
          </div>`).join('')}
      </div>
    </div>` : ''}

    <div class="grid grid-2">
      <div class="card">
        <div class="card-head"><h2>Alerts</h2></div>
        <div>${detail.alerts.length ? detail.alerts.slice(0, 6).map((a) => `
          <div class="alert-row" data-sev="${a.severity}">
            <div class="stripe"></div>
            <div>
              <div class="title">${esc(a.title)}</div>
              <div class="detail">${esc(a.detail.slice(0, 190))}${a.detail.length > 190 ? '…' : ''}</div>
              <div class="metaline">${severityPill(a.severity)}${statusPill(a.status)}
                <span class="muted" style="font-size:11.5px">${fmt.when(a.ts)}</span></div>
            </div>
            <div class="side"></div>
          </div>`).join('') : emptyState('No alerts for this machine.', 'check')}</div>
      </div>

      <div class="card">
        <div class="card-head"><h2>Maintenance history</h2>
          <span class="muted" style="font-size:11.5px;margin-left:auto">
            ${detail.maintenance_history.length} records</span></div>
        <div class="table-wrap" style="max-height:380px;overflow-y:auto">
          ${detail.maintenance_history.length ? `<table class="data">
            <thead><tr><th>Date</th><th>Type</th><th>Work</th>
              <th class="num">Downtime</th><th class="num">Cost</th></tr></thead>
            <tbody>${detail.maintenance_history.map((r) => `
              <tr>
                <td style="white-space:nowrap">${fmt.date(r.ts)}</td>
                <td><span class="pill ${r.kind === 'corrective' ? 'pill-degraded'
                  : r.kind === 'predictive' ? 'pill-info' : 'pill-neutral'}"
                  style="font-size:10.5px">${esc(fmt.title(r.kind))}</span></td>
                <td style="font-size:12.5px">${esc(r.description)}
                  ${r.failure_mode ? `<div class="muted" style="font-size:11px">
                    mode: ${esc(fmt.title(r.failure_mode))}</div>` : ''}</td>
                <td class="num">${r.downtime_hours.toFixed(1)} h</td>
                <td class="num">${fmt.money(r.cost)}</td>
              </tr>`).join('')}</tbody></table>`
            : emptyState('No maintenance history recorded.', 'history')}
        </div>
      </div>
    </div>`;

  // charts
  const points = detail.health_history.map((r) => ({
    ts: r.ts, health: r.health_score, anomaly: r.anomaly_score * 100,
  }));
  timeSeries(root.querySelector('[data-chart-history]'), {
    points, yMin: 0, yMax: 100, height: 220,
    series: [
      { key: 'health', label: 'Health score', color: 'var(--series-1)', area: true,
        format: (v) => v.toFixed(1) },
      { key: 'anomaly', label: 'Anomaly score ×100', color: 'var(--series-2)',
        format: (v) => (v / 100).toFixed(2) },
    ],
  });

  divergingBars(root.querySelector('[data-chart-shap]'), explanation, {
    valueFormat: (v) => `${v >= 0 ? '+' : ''}${v.toFixed(3)}`,
  });

  if (detect) {
    rankedBars(root.querySelector('[data-chart-detect]'),
      detect.modes.map((mode) => ({
        label: mode.label, value: Math.round(mode.score * 100),
        unit: 'Coverage',
        note: mode.missing.length ? `missing: ${mode.missing.join(', ')}` : 'fully covered',
        color: mode.band === 'good' ? 'var(--st-good)'
          : mode.band === 'marginal' ? 'var(--st-warning)' : 'var(--st-serious)',
      })),
      { valueFormat: (v) => `${v}%` });
  }

  detail.sensors.forEach((s) => {
    const cell = root.querySelector(`[data-spark-sensor="${s.id}"]`);
    const values = (s.series || []).map((p) => p.value).filter((v) => v !== null);
    if (cell && values.length > 1) {
      cell.appendChild(sparkline(values, { width: 110, height: 26 }));
    } else if (cell) {
      cell.innerHTML = '<span class="muted" style="font-size:11px">no data</span>';
    }
  });

  root.querySelector('[data-back]').addEventListener('click', () => ctx.go('fleet'));
  root.querySelector('[data-analyze]').addEventListener('click', async (e) => {
    const btn = e.currentTarget;
    btn.disabled = true;
    btn.innerHTML = '<span class="spinner"></span>Analysing';
    try {
      const result = await api.analyze(machineId);
      toast('Analysis complete',
        `${result.prediction.code}: ${fmt.pct(result.prediction.failure_probability)} failure probability`,
        'good');
      ctx.reload();
    } catch (err) {
      toast('Analysis failed', err.message);
      btn.disabled = false;
      btn.innerHTML = `${icon('cpu', 14)}Re-analyse`;
    }
  });
}

const sensorStatusPill = (status) => {
  const map = {
    ok: ['pill-good', 'check', 'OK'],
    noisy: ['pill-watch', 'info', 'Noisy'],
    degraded: ['pill-degraded', 'alert', 'Degraded'],
    stuck: ['pill-degraded', 'alert', 'Stuck'],
    fault: ['pill-critical', 'alert', 'Fault'],
    offline: ['pill-critical', 'x', 'Offline'],
  };
  const [cls, ic, label] = map[status] || ['pill-neutral', 'info', fmt.title(status)];
  return `<span class="pill ${cls}">${icon(ic, 11)}${label}</span>`;
};

/* ==========================================================================
   Alerts tracker
   ========================================================================== */
export async function alertsView(root, ctx) {
  root.innerHTML = loading();
  const state = { status: '', severity: '' };

  async function paint() {
    const data = await api.alerts({ status: state.status, severity: state.severity });
    const c = data.counts;
    const body = root.querySelector('[data-list]');
    root.querySelector('[data-counts]').innerHTML =
      `${c.open || 0} open · ${c.acknowledged || 0} acknowledged · ${c.resolved || 0} resolved`;

    body.innerHTML = data.alerts.length ? data.alerts.map((a) => `
      <div class="alert-row ${a.status === 'resolved' ? 'resolved' : ''}" data-sev="${a.severity}">
        <div class="stripe"></div>
        <div style="min-width:0">
          <div class="title">${esc(a.title)}</div>
          <div class="detail">${esc(a.detail)}</div>
          <div class="metaline">
            ${severityPill(a.severity)}${statusPill(a.status)}
            <span class="pill pill-neutral">${icon('building', 11)}${esc(a.plant_name)}</span>
            ${a.retrofit ? retrofitTag() : ''}
            ${a.work_order_code ? `<span class="pill pill-info">${icon('clipboard', 11)}${esc(a.work_order_code)}</span>` : ''}
            <span class="muted" style="font-size:11.5px">${fmt.when(a.ts)}</span>
            ${a.ack_by_name ? `<span class="muted" style="font-size:11.5px">
              · acknowledged by ${esc(a.ack_by_name)}</span>` : ''}
          </div>
        </div>
        <div class="side">
          <button class="btn btn-sm btn-ghost" data-open="${a.machine_id}">
            ${esc(a.machine_code)}</button>
          ${a.status === 'open' ? `<button class="btn btn-sm" data-ack="${a.id}">
            ${icon('check', 13)}Acknowledge</button>` : ''}
          ${a.status !== 'resolved' && a.status !== 'suppressed'
            ? `<button class="btn btn-sm" data-resolve="${a.id}">Resolve</button>` : ''}
          ${a.status !== 'suppressed' && a.status !== 'resolved'
            ? `<button class="btn btn-sm btn-ghost" data-fp="${a.id}"
                 title="Report as a false positive — feeds the model feedback loop">
                 ${icon('x', 13)}False positive</button>` : ''}
        </div>
      </div>`).join('') : emptyState('No alerts match these filters.', 'check');

    body.querySelectorAll('[data-ack]').forEach((b) => b.addEventListener('click', async () => {
      await api.acknowledgeAlert(b.dataset.ack);
      toast('Alert acknowledged', 'You are now the owner of this alert.', 'good');
      paint();
    }));
    body.querySelectorAll('[data-resolve]').forEach((b) => b.addEventListener('click', async () => {
      await api.resolveAlert(b.dataset.resolve);
      toast('Alert resolved', '', 'good');
      paint();
    }));
    body.querySelectorAll('[data-fp]').forEach((b) => b.addEventListener('click', () =>
      falsePositiveDialog(b.dataset.fp, paint)));
    body.querySelectorAll('[data-open]').forEach((b) => b.addEventListener('click', () =>
      ctx.go(`machine/${b.dataset.open}`)));
  }

  root.innerHTML = `
    <div class="page-head">
      <div><h1>Alert tracker</h1><div class="sub" data-counts></div></div>
    </div>
    <div class="filter-bar">
      <select class="select" data-status>
        <option value="">All statuses</option>
        <option value="open">Open</option>
        <option value="acknowledged">Acknowledged</option>
        <option value="resolved">Resolved</option>
        <option value="suppressed">Suppressed</option>
      </select>
      <select class="select" data-severity>
        <option value="">All severities</option>
        <option value="critical">Critical</option>
        <option value="high">High</option>
        <option value="medium">Medium</option>
        <option value="low">Low</option>
      </select>
    </div>
    <div class="card"><div data-list></div></div>`;

  root.querySelector('[data-status]').addEventListener('change', (e) => {
    state.status = e.target.value; paint();
  });
  root.querySelector('[data-severity]').addEventListener('change', (e) => {
    state.severity = e.target.value; paint();
  });

  await paint();
  return ctx.onEvent(['alert.raised', 'alert.escalated', 'alert.resolved'], paint);
}

function falsePositiveDialog(alertId, after) {
  openDrawer({
    title: 'Report a false positive',
    body: `
      <p class="secondary">This records your judgement against the prediction that
      raised the alert. False positives are aggregated in the analytics view and
      form the training signal for the next model refit — this is how the platform
      adapts rather than repeating the same mistake.</p>
      <div class="field" style="margin-top:14px">
        <label for="fp-note">What was actually happening?</label>
        <textarea class="textarea" id="fp-note"
          placeholder="e.g. Vibration rise was a temporary process change, not a developing fault."></textarea>
      </div>`,
    footer: `<button class="btn" data-cancel>Cancel</button>
             <button class="btn btn-primary" data-submit>Submit feedback</button>`,
    onMount(drawer) {
      drawer.querySelector('[data-cancel]').addEventListener('click', closeDrawer);
      drawer.querySelector('[data-submit]').addEventListener('click', async () => {
        await api.feedback({
          ref_type: 'alert', ref_id: Number(alertId),
          verdict: 'false_positive',
          note: drawer.querySelector('#fp-note').value,
        });
        closeDrawer();
        toast('Feedback recorded', 'The alert is suppressed and the model will be re-fitted.', 'good');
        after?.();
      });
    },
  });
}

/* ==========================================================================
   Work orders
   ========================================================================== */
export async function workOrdersView(root, ctx) {
  root.innerHTML = loading();
  const COLUMNS = [
    { key: 'pending_approval', label: 'Awaiting approval', ic: 'info' },
    { key: 'scheduled', label: 'Scheduled', ic: 'clipboard' },
    { key: 'in_progress', label: 'In progress', ic: 'wrench' },
    { key: 'completed', label: 'Completed', ic: 'check' },
  ];

  async function paint() {
    const data = await api.workOrders();
    const c = data.counts;
    root.querySelector('[data-counts]').innerHTML =
      `${c.total || 0} total · ${c.pending_approval || 0} awaiting approval ·
       ${fmt.money(c.open_cost)} of open work`;

    const board = root.querySelector('[data-board]');
    board.innerHTML = COLUMNS.map((col) => {
      const items = data.work_orders.filter((w) => w.status === col.key);
      return `<section class="kanban-col">
        <header>${icon(col.ic, 13)}${col.label}<span class="n num">${items.length}</span></header>
        <div class="kanban-body">${items.map((w) => `
          <article class="wo-card" data-wo="${w.id}">
            <div class="row1">
              ${priorityBadge(w.priority)}
              <span class="wo-code">${esc(w.code)}</span>
              ${w.retrofit ? retrofitTag() : ''}
            </div>
            <div style="font-weight:600;font-size:12.5px;margin-bottom:3px">
              ${esc(w.machine_code)} — ${esc(w.machine_name)}</div>
            <div class="action secondary">${esc(w.action)}</div>
            <div class="foot">
              <span>${icon('history', 11)} ${w.est_downtime_h.toFixed(1)} h</span>
              <span>${fmt.money(w.est_cost)}</span>
              ${w.assignee_name ? `<span>${icon('wrench', 11)} ${esc(w.assignee_name)}</span>` : ''}
            </div>
          </article>`).join('') || '<div class="muted" style="padding:10px;font-size:12px">Nothing here.</div>'}
        </div></section>`;
    }).join('');

    board.querySelectorAll('[data-wo]').forEach((card) =>
      card.addEventListener('click', () => {
        const wo = data.work_orders.find((w) => String(w.id) === card.dataset.wo);
        if (wo) workOrderDrawer(wo, ctx, paint);
      }));
  }

  root.innerHTML = `
    <div class="page-head">
      <div><h1>Work orders</h1><div class="sub" data-counts></div></div>
    </div>
    <div class="kanban" data-board></div>`;

  await paint();
  return ctx.onEvent(
    ['workorder.created', 'workorder.approved', 'workorder.rejected', 'workorder.updated'],
    paint);
}

function workOrderDrawer(wo, ctx, after) {
  const canApprove = ['manager', 'admin'].includes(ctx.user.role);
  const parts = wo.parts || [];

  openDrawer({
    title: `${wo.code} · ${wo.machine_code}`,
    body: `
      <div style="display:flex;gap:8px;align-items:center;margin-bottom:14px;flex-wrap:wrap">
        ${priorityBadge(wo.priority)}${statusPill(wo.status)}
        ${wo.retrofit ? retrofitTag() : ''}
      </div>

      <h3 style="margin-bottom:6px">Recommended action</h3>
      <p class="secondary" style="font-size:13px">${esc(wo.action)}</p>

      <h3 style="margin:16px 0 6px">Why this was raised</h3>
      <p class="secondary" style="font-size:12.5px">${esc(wo.rationale || '—')}</p>

      <h3 style="margin:16px 0 8px">Plan</h3>
      <dl class="kv">
        <dt>Machine</dt><dd>${esc(wo.machine_name)}</dd>
        <dt>Plant</dt><dd>${esc(wo.plant_name)}</dd>
        <dt>Skill required</dt><dd style="text-align:right">${esc(wo.skill_required)}</dd>
        <dt>Assignee</dt><dd>${esc(wo.assignee_name || 'Unassigned')}</dd>
        <dt>Estimated downtime</dt><dd>${wo.est_downtime_h.toFixed(1)} h</dd>
        <dt>Estimated cost</dt><dd>${fmt.money(wo.est_cost)}</dd>
        <dt>Scheduled start</dt><dd>${fmt.datetime(wo.scheduled_start)}</dd>
        <dt>Created</dt><dd>${fmt.when(wo.created_at)}</dd>
        ${wo.approved_by_name ? `<dt>Approved by</dt><dd>${esc(wo.approved_by_name)}</dd>` : ''}
      </dl>

      ${parts.length ? `<h3 style="margin:16px 0 8px">Spare parts</h3>
        <table class="data"><thead><tr><th>Part</th><th class="num">Qty</th>
          <th class="num">Cost</th><th>Stock</th></tr></thead>
        <tbody>${parts.map((p) => `<tr>
          <td><strong class="mono" style="font-size:11.5px">${esc(p.sku)}</strong>
            <div class="muted" style="font-size:11px">${esc(p.name)}</div></td>
          <td class="num">${p.quantity}</td>
          <td class="num">${fmt.money(p.unit_cost * p.quantity)}</td>
          <td>${p.in_stock
            ? '<span class="pill pill-good" style="font-size:10.5px">' + icon('check', 10) + 'In stock</span>'
            : `<span class="pill pill-watch" style="font-size:10.5px">${icon('info', 10)}${p.lead_time_days}d lead</span>`}
          </td></tr>`).join('')}</tbody></table>` : ''}

      ${wo.status === 'pending_approval' ? `<div class="notice warn" style="margin-top:16px">
        ${icon('info', 15)}<div><strong>Human approval required.</strong> This work order
        exceeds the platform's autonomous scheduling limits, so the Maintenance agent
        drafted it but did not schedule it. ${canApprove ? 'Approve or reject below.'
        : 'A manager or admin must approve it.'}</div></div>` : ''}`,

    footer: `
      <button class="btn" data-machine>View machine</button>
      ${wo.status === 'pending_approval' && canApprove
        ? `<button class="btn btn-danger" data-reject>Reject</button>
           <button class="btn btn-primary" data-approve>${icon('check', 14)}Approve</button>` : ''}
      ${wo.status === 'scheduled'
        ? '<button class="btn btn-primary" data-start>Start work</button>' : ''}
      ${wo.status === 'in_progress'
        ? '<button class="btn btn-primary" data-complete>Complete</button>' : ''}`,

    onMount(drawer) {
      drawer.querySelector('[data-machine]')?.addEventListener('click', () => {
        closeDrawer();
        ctx.go(`machine/${wo.machine_id}`);
      });
      drawer.querySelector('[data-approve]')?.addEventListener('click', async () => {
        await api.approveWorkOrder(wo.id);
        closeDrawer();
        toast('Work order approved', `${wo.code} is now scheduled.`, 'good');
        after?.();
      });
      drawer.querySelector('[data-reject]')?.addEventListener('click', async () => {
        const note = prompt('Why are you rejecting this work order?') || 'Rejected by planner';
        await api.rejectWorkOrder(wo.id, note);
        closeDrawer();
        toast('Work order rejected', 'Recorded as model feedback.', '');
        after?.();
      });
      drawer.querySelector('[data-start]')?.addEventListener('click', async () => {
        await api.updateWorkOrder(wo.id, { status: 'in_progress' });
        closeDrawer();
        toast('Work started', `${wo.code} is in progress.`, 'good');
        after?.();
      });
      drawer.querySelector('[data-complete]')?.addEventListener('click', async () => {
        const notes = prompt('Resolution notes:', wo.action) || wo.action;
        await api.updateWorkOrder(wo.id, { status: 'completed', resolution_notes: notes });
        closeDrawer();
        toast('Work order completed',
          'Maintenance history updated and the machine returned to service.', 'good');
        after?.();
      });
    },
  });
}

/* ==========================================================================
   Maintenance history (fleet-wide)
   ========================================================================== */
export async function historyView(root, ctx) {
  root.innerHTML = loading();
  const [fleet, overview] = await Promise.all([api.fleet(), api.overview()]);
  const m90 = overview.maintenance_90d;

  const rows = [];
  for (const machine of fleet.machines.slice(0, 30)) {
    const detail = await api.machine(machine.id);
    for (const record of detail.maintenance_history) {
      rows.push({ ...record, code: machine.code, name: machine.name, plant: machine.plant_name });
    }
  }
  rows.sort((a, b) => b.ts - a.ts);

  const byKind = {};
  for (const r of rows) byKind[r.kind] = (byKind[r.kind] || 0) + 1;

  root.innerHTML = `
    <div class="page-head">
      <div><h1>Maintenance history</h1>
        <div class="sub">${rows.length} records · ${m90.jobs} jobs in the last 90 days</div></div>
    </div>

    <div class="grid grid-kpi mb">
      <div class="card tile"><div class="label">${icon('history', 12)}Jobs (90d)</div>
        <div class="value num">${m90.jobs}</div>
        <div class="foot">${m90.planned} planned · ${m90.reactive} reactive</div></div>
      <div class="card tile"><div class="label">${icon('chart', 12)}Spend (90d)</div>
        <div class="value num">${fmt.money(m90.spend)}</div>
        <div class="foot">across all plants</div></div>
      <div class="card tile"><div class="label">${icon('gauge', 12)}Downtime (90d)</div>
        <div class="value num">${fmt.num(m90.downtime_h, 0)}<span class="unit">h</span></div>
        <div class="foot">recorded outage</div></div>
      <div class="card tile"><div class="label">${icon('shield', 12)}Planned ratio</div>
        <div class="value num">${Math.round((m90.planned_ratio || 0) * 100)}<span class="unit">%</span></div>
        <div class="foot">higher is better</div></div>
    </div>

    <div class="grid grid-2 mb">
      <div class="card">
        <div class="card-head"><h2>Work by type</h2></div>
        <div class="card-body"><div data-chart-kind></div></div>
      </div>
      <div class="card">
        <div class="card-head"><h2>Recurring failure modes</h2></div>
        <div class="card-body"><div data-chart-modes></div></div>
      </div>
    </div>

    <div class="card">
      <div class="card-head"><h2>All records</h2></div>
      <div class="table-wrap" style="max-height:560px;overflow-y:auto">
        <table class="data">
          <thead><tr><th>Date</th><th>Machine</th><th>Type</th><th>Work</th>
            <th>Technician</th><th class="num">Downtime</th><th class="num">Cost</th></tr></thead>
          <tbody>${rows.slice(0, 260).map((r) => `
            <tr class="clickable" data-code="${esc(r.code)}">
              <td style="white-space:nowrap">${fmt.date(r.ts)}</td>
              <td><strong class="mono" style="font-size:12px">${esc(r.code)}</strong>
                <div class="muted" style="font-size:11px">${esc(r.plant)}</div></td>
              <td><span class="pill ${r.kind === 'corrective' ? 'pill-degraded'
                : r.kind === 'predictive' ? 'pill-info' : 'pill-neutral'}"
                style="font-size:10.5px">${esc(fmt.title(r.kind))}</span></td>
              <td style="font-size:12.5px;max-width:330px">${esc(r.description)}
                ${r.failure_mode ? `<div class="muted" style="font-size:11px">
                  mode: ${esc(fmt.title(r.failure_mode))}</div>` : ''}</td>
              <td style="font-size:12.5px">${esc(r.technician || '—')}</td>
              <td class="num">${r.downtime_hours.toFixed(1)} h</td>
              <td class="num">${fmt.money(r.cost)}</td>
            </tr>`).join('')}</tbody>
        </table>
      </div>
    </div>`;

  rankedBars(root.querySelector('[data-chart-kind]'),
    Object.entries(byKind)
      .sort((a, b) => b[1] - a[1])
      .map(([k, v]) => ({ label: fmt.title(k), value: v, unit: 'Jobs' })));

  const modeCounts = {};
  for (const r of rows) if (r.failure_mode) modeCounts[r.failure_mode] = (modeCounts[r.failure_mode] || 0) + 1;
  const modeItems = Object.entries(modeCounts)
    .sort((a, b) => b[1] - a[1])
    .map(([k, v]) => ({ label: fmt.title(k), value: v, unit: 'Occurrences' }));
  rankedBars(root.querySelector('[data-chart-modes]'), modeItems, { color: 'var(--series-2)' });

  const byCode = new Map(fleet.machines.map((m) => [m.code, m.id]));
  root.querySelectorAll('[data-code]').forEach((tr) =>
    tr.addEventListener('click', () => {
      const id = byCode.get(tr.dataset.code);
      if (id) ctx.go(`machine/${id}`);
    }));
}

/* ==========================================================================
   AI Copilot
   ========================================================================== */
export async function copilotView(root, ctx) {
  const suggestions = await api.suggestions();
  const history = ctx.copilotHistory;

  root.innerHTML = `
    <div class="page-head">
      <div><h1>AI Copilot</h1>
        <div class="sub">Grounded in live telemetry, predictions and the plant knowledge base.
          ${suggestions.llm.enabled
            ? `Answering with <strong>${esc(suggestions.llm.model)}</strong>.`
            : 'Running the deterministic grounded composer — set <code class="mono">ANTHROPIC_API_KEY</code> for conversational answers over the same evidence.'}
        </div></div>
    </div>

    <div class="copilot">
      <div class="chat-scroll" data-scroll>
        ${history.length ? '' : `
          <div class="card" style="margin-bottom:16px">
            <div class="card-body">
              <h2 style="margin-bottom:6px">Ask about your fleet</h2>
              <p class="secondary" style="font-size:13px">Every answer cites the records it
                came from. Figures are read from the database, never generated — if a number
                cannot be traced to the evidence, the Copilot flags it.</p>
              <div class="chips" style="margin-top:13px">
                ${suggestions.suggestions.map((s) =>
                  `<button class="chip" data-ask="${esc(s)}">${esc(s)}</button>`).join('')}
              </div>
            </div>
          </div>`}
      </div>
      <div class="composer">
        <textarea data-input rows="1" placeholder="Ask about a machine, a risk, or today's alerts…"></textarea>
        <button class="btn btn-primary" data-send>${icon('send', 15)}Ask</button>
      </div>
    </div>`;

  const scroll = root.querySelector('[data-scroll]');
  const input = root.querySelector('[data-input]');

  for (const entry of history) appendMessage(scroll, entry);
  scroll.scrollTop = scroll.scrollHeight;

  async function ask(question) {
    if (!question.trim()) return;
    input.value = '';
    input.style.height = 'auto';

    const userEntry = { role: 'user', text: question };
    history.push(userEntry);
    appendMessage(scroll, userEntry);

    const pending = document.createElement('div');
    pending.className = 'msg ai';
    pending.innerHTML = `<div class="who-av">AI</div>
      <div class="bubble"><div class="typing"><span></span><span></span><span></span></div></div>`;
    scroll.appendChild(pending);
    scroll.scrollTop = scroll.scrollHeight;

    try {
      const answer = await api.ask(question, ctx.currentMachineId);
      pending.remove();
      const entry = { role: 'ai', data: answer };
      history.push(entry);
      appendMessage(scroll, entry);
    } catch (err) {
      pending.remove();
      const entry = { role: 'ai', data: { answer: `I could not answer that: ${err.message}`,
        citations: [], grounded: false, source: 'error', safety: { blocked: false },
        verification: { unverified_numbers: [] }, suggested_followups: [] } };
      history.push(entry);
      appendMessage(scroll, entry);
    }
    scroll.scrollTop = scroll.scrollHeight;
  }

  root.querySelectorAll('[data-ask]').forEach((b) =>
    b.addEventListener('click', () => ask(b.dataset.ask)));
  root.querySelector('[data-send]').addEventListener('click', () => ask(input.value));
  input.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); ask(input.value); }
  });
  input.addEventListener('input', () => {
    input.style.height = 'auto';
    input.style.height = `${Math.min(input.scrollHeight, 132)}px`;
  });
  input.focus();

  // Delegated: follow-up chips are added after this handler is attached.
  scroll.addEventListener('click', (e) => {
    const chip = e.target.closest('[data-followup]');
    if (chip) ask(chip.dataset.followup);
  });
}

function appendMessage(scroll, entry) {
  const node = document.createElement('div');
  if (entry.role === 'user') {
    node.className = 'msg user';
    node.innerHTML = `<div class="who-av">You</div>
      <div class="bubble"><div class="body">${esc(entry.text)}</div></div>`;
    scroll.appendChild(node);
    return;
  }

  const d = entry.data;
  const blocked = d.safety?.blocked;
  const unverified = d.verification?.unverified_numbers || [];

  node.className = 'msg ai';
  node.innerHTML = `
    <div class="who-av">AI</div>
    <div class="bubble">
      ${blocked ? `<div class="notice danger" style="margin-bottom:10px">${icon('shield', 15)}
        <div><strong>Safety guardrail triggered.</strong> The request or the drafted answer
        involved a personnel-safety control, so it was blocked.</div></div>` : ''}
      <div class="body">${markdown(d.answer)}</div>

      ${unverified.length ? `<div class="notice warn" style="margin-top:10px">${icon('alert', 15)}
        <div><strong>Unverified figures:</strong> ${esc(unverified.join(', '))} — these could not
        be traced back to the retrieved records. Check them before acting.</div></div>` : ''}

      <div class="answer-meta">
        <span class="pill ${d.grounded ? 'pill-good' : 'pill-watch'}">
          ${icon(d.grounded ? 'check' : 'info', 11)}
          ${d.grounded ? `Grounded · ${d.citation_count} source${d.citation_count === 1 ? '' : 's'}`
            : 'Unverified — no matching record'}</span>
        ${d.intent ? `<span class="pill pill-neutral">${esc(fmt.title(d.intent))}</span>` : ''}
        <span class="pill pill-neutral">${esc(d.source || 'unknown')}</span>
        ${d.latency_ms ? `<span class="muted" style="font-size:11px">${Math.round(d.latency_ms)} ms</span>` : ''}
      </div>

      ${d.citations?.length ? `<div class="citations">
        ${d.citations.slice(0, 6).map((c) => `<div class="citation">
          <span class="kind">${esc((c.type || '').replace(/_/g, ' '))}</span>
          <span style="flex:1;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap">
            ${esc(c.title)}</span>
          ${c.as_of ? `<span class="muted" style="font-size:10.5px">${esc(c.as_of)}</span>` : ''}
        </div>`).join('')}</div>` : ''}

      ${d.suggested_followups?.length ? `<div class="chips" style="margin-top:11px">
        ${d.suggested_followups.map((s) =>
          `<button class="chip" data-followup="${esc(s)}">${esc(s)}</button>`).join('')}
      </div>` : ''}
    </div>`;
  scroll.appendChild(node);
}

/* ==========================================================================
   Agents & models
   ========================================================================== */
export async function agentsView(root, ctx) {
  root.innerHTML = loading();
  const [agents, models, feedback] = await Promise.all([
    api.agents(), api.models(),
    api.feedbackSummary().catch(() => null),
  ]);

  const p = agents.pipeline;
  const reg = models.registry;
  const llm = models.llm;

  root.innerHTML = `
    <div class="page-head">
      <div><h1>Agents & models</h1>
        <div class="sub">Four agents, one pipeline. Every run is traced.</div></div>
    </div>

    <div class="grid grid-kpi mb">
      <div class="card tile"><div class="label">${icon('cpu', 12)}Pipeline</div>
        <div class="value num">${p.tick}</div>
        <div class="foot">cycles · ${p.last_cycle_ms} ms last pass</div></div>
      <div class="card tile"><div class="label">${icon('gauge', 12)}Escalations</div>
        <div class="value num">${p.escalations}</div>
        <div class="foot">machines sent to Prediction</div></div>
      <div class="card tile"><div class="label">${icon('flask', 12)}Classifier F1</div>
        <div class="value num">${reg.predictor?.f1 ?? '—'}</div>
        <div class="foot">failure type ${reg.predictor?.category_accuracy ?? '—'} accuracy</div></div>
      <div class="card tile"><div class="label">${icon('history', 12)}RUL error</div>
        <div class="value num">${reg.predictor?.rul_mae_hours ?? '—'}<span class="unit">h</span></div>
        <div class="foot">mean absolute error</div></div>
    </div>

    <div class="grid grid-detail mb">
      <div class="card">
        <div class="card-head"><h2>Agent roster</h2></div>
        <div class="card-body">
          ${agents.manifest.map((a) => `
            <div class="agent-card">
              <div class="agent-icon">${icon(
                a.name === 'monitoring' ? 'antenna' : a.name === 'prediction' ? 'flask'
                : a.name === 'maintenance' ? 'wrench' : 'chat', 17)}</div>
              <div style="min-width:0">
                <div style="display:flex;align-items:center;gap:8px">
                  <strong>${esc(a.title)}</strong>
                  <span class="muted" style="font-size:11px">${esc(a.cadence)}</span>
                </div>
                <div class="secondary" style="font-size:12.5px;margin-top:3px">${esc(a.description)}</div>
                <div class="io-tags">
                  ${a.consumes.map((x) => `<span class="io-tag">← ${esc(x)}</span>`).join('')}
                  ${a.produces.map((x) => `<span class="io-tag out">→ ${esc(x)}</span>`).join('')}
                </div>
              </div>
            </div>`).join('')}
        </div>
      </div>

      <div class="card">
        <div class="card-head"><h2>Live agent activity</h2></div>
        <div class="card-body tight" style="max-height:400px;overflow-y:auto" data-runs>
          ${agents.recent_runs.map(runLine).join('')}
        </div>
      </div>
    </div>

    <div class="grid grid-2">
      <div class="card">
        <div class="card-head"><h2>Model registry</h2></div>
        <div class="card-body">
          <h3 style="margin-bottom:8px">Anomaly detector (VAE)</h3>
          <dl class="kv" style="margin-bottom:16px">
            <dt>Version</dt><dd>${esc(reg.vae?.version || '—')}</dd>
            <dt>Architecture</dt><dd>16 → ${reg.vae?.hidden_dim ?? '?'} → ${reg.vae?.latent_dim ?? '?'} latent</dd>
            <dt>Training samples</dt><dd>${fmt.num(reg.vae?.samples)}</dd>
            <dt>Final loss</dt><dd>${reg.vae?.final_loss ?? '—'}</dd>
          </dl>
          <h3 style="margin-bottom:8px">Multi-task predictor</h3>
          <dl class="kv">
            <dt>Version</dt><dd>${esc(reg.predictor?.version || '—')}</dd>
            <dt>Accuracy</dt><dd>${reg.predictor?.accuracy ?? '—'}</dd>
            <dt>Precision / recall</dt>
            <dd>${reg.predictor?.precision ?? '—'} / ${reg.predictor?.recall ?? '—'}</dd>
            <dt>Failure-type accuracy</dt><dd>${reg.predictor?.category_accuracy ?? '—'}</dd>
            <dt>Training samples</dt><dd>${fmt.num(reg.training_samples)}</dd>
            <dt>Trained in</dt><dd>${reg.train_seconds ?? '—'} s</dd>
          </dl>
          <div class="notice" style="margin-top:14px">${icon('info', 15)}
            <div>Models are fitted on physics-based synthetic degradation profiles. They
            require re-fitting on site-specific failure records before production use.</div></div>
        </div>
      </div>

      <div class="card">
        <div class="card-head"><h2>Cost controls</h2></div>
        <div class="card-body">
          <dl class="kv" style="margin-bottom:14px">
            <dt>Copilot mode</dt><dd>${llm.enabled ? esc(llm.model) : 'deterministic composer'}</dd>
            <dt>Effort</dt><dd>${esc(llm.effort)}</dd>
            <dt>Calls</dt><dd>${llm.calls}</dd>
            <dt>Prompt-cache hit ratio</dt><dd>${fmt.pct(llm.tokens?.cache_hit_ratio || 0)}</dd>
            <dt>Response-cache hit rate</dt><dd>${fmt.pct(llm.response_cache?.hit_rate || 0)}</dd>
            <dt>Retrieval index</dt><dd>${models.retrieval?.chunks ?? 0} chunks</dd>
          </dl>
          <ul class="limitations">
            ${Object.entries(models.cost_controls).map(([k, v]) =>
              `<li><strong>${esc(fmt.title(k))}:</strong> ${esc(v)}</li>`).join('')}
          </ul>
          ${feedback ? `<h3 style="margin:16px 0 8px">Human feedback loop</h3>
            <dl class="kv">
              <dt>Total feedback</dt><dd>${feedback.total}</dd>
              <dt>False-positive rate</dt><dd>${fmt.pct(feedback.false_positive_rate)}</dd>
            </dl>` : ''}
        </div>
      </div>
    </div>`;

  return ctx.onEvent(['agent.run'], (payload) => {
    const runs = root.querySelector('[data-runs]');
    if (!runs) return;
    runs.insertAdjacentHTML('afterbegin', runLine({
      agent: payload.agent, summary: payload.summary,
      duration_ms: payload.duration_ms, status: payload.ok ? 'ok' : 'error',
      ts: Date.now() / 1000,
    }));
    while (runs.children.length > 60) runs.lastElementChild.remove();
  });
}

const runLine = (r) => `
  <div class="run-line ${r.status === 'error' ? 'err' : ''}">
    <span class="rl-agent">${esc(r.agent)}</span>
    <span class="rl-sum">${esc(r.summary || '')}</span>
    <span class="rl-ms">${Math.round(r.duration_ms)} ms</span>
  </div>`;

/* ==========================================================================
   Scenario lab
   ========================================================================== */
export async function labView(root, ctx) {
  root.innerHTML = loading();
  const [scenarios, state] = await Promise.all([api.scenarios(), api.simState()]);
  const active = state.machines.filter((m) => m.injected_fault);

  root.innerHTML = `
    <div class="page-head">
      <div><h1>Scenario lab</h1>
        <div class="sub">Drive the fleet into failure states to exercise the full pipeline.
          Every scenario is detectable by the target machine's sensor kit.</div></div>
      <div class="actions">
        <button class="btn btn-sm" data-pause>
          ${icon(state.pipeline.paused ? 'play' : 'pause', 14)}
          ${state.pipeline.paused ? 'Resume' : 'Pause'} pipeline</button>
      </div>
    </div>

    ${active.length ? `<div class="card mb">
      <div class="card-head"><h2>Active scenarios</h2></div>
      <div class="table-wrap"><table class="data">
        <thead><tr><th>Machine</th><th>Injected fault</th><th class="num">Severity</th>
          <th class="num">Progression</th><th></th></tr></thead>
        <tbody>${active.map((m) => `
          <tr>
            <td><strong class="mono">${esc(m.code)}</strong></td>
            <td>${esc(fmt.title(m.injected_fault))}</td>
            <td class="num">${(m.severity * 100).toFixed(0)}%</td>
            <td class="num">${(m.progression * 100).toFixed(2)}%/tick</td>
            <td style="text-align:right">
              <button class="btn btn-sm" data-clear="${m.machine_id}">Clear & heal</button></td>
          </tr>`).join('')}</tbody></table></div>
    </div>` : ''}

    <div class="grid grid-3 mb">
      ${scenarios.presets.map((p) => `
        <div class="card">
          <div class="card-body">
            <div style="display:flex;align-items:center;gap:8px;margin-bottom:8px">
              <strong>${esc(p.title)}</strong>
              ${p.retrofit ? retrofitTag() : ''}
            </div>
            <p class="secondary" style="font-size:12.5px">${esc(p.description)}</p>
            <dl class="kv" style="margin:12px 0">
              <dt>Target</dt><dd>${esc(p.machine_code)}</dd>
              <dt>Machine</dt><dd style="text-align:right;font-size:12px">${esc(p.machine_name)}</dd>
              <dt>Detectability</dt><dd>${Math.round(p.detectability.score * 100)}%
                (${esc(p.detectability.band)})</dd>
            </dl>
            <button class="btn btn-primary btn-block btn-sm" data-preset="${esc(p.id)}">
              ${icon('play', 14)}Run scenario</button>
          </div>
        </div>`).join('')}
    </div>

    <div class="card">
      <div class="card-head"><h2>Custom injection</h2></div>
      <div class="card-body">
        <div class="filter-bar" style="margin-bottom:0">
          <select class="select" data-machine style="min-width:250px">
            ${scenarios.machines.map((m) =>
              `<option value="${m.id}">${esc(m.code)} — ${esc(m.name)}${m.retrofit ? ' (EdgeSense)' : ''}</option>`).join('')}
          </select>
          <select class="select" data-category>
            ${scenarios.failure_categories.map((c) =>
              `<option value="${esc(c.value)}">${esc(c.label)}</option>`).join('')}
          </select>
          <label class="muted" style="font-size:12px">Severity
            <input class="input" type="number" data-severity value="0.35"
                   min="0" max="1" step="0.05" style="width:80px;margin-left:6px"></label>
          <label class="muted" style="font-size:12px">Progression
            <input class="input" type="number" data-progression value="0.006"
                   min="0" max="0.2" step="0.002" style="width:90px;margin-left:6px"></label>
          <button class="btn btn-primary" data-inject>${icon('flask', 14)}Inject</button>
        </div>
      </div>
    </div>`;

  root.querySelectorAll('[data-preset]').forEach((b) =>
    b.addEventListener('click', async () => {
      const preset = scenarios.presets.find((p) => p.id === b.dataset.preset);
      await api.inject({
        machine_id: preset.machine_id, category: preset.category,
        severity: preset.severity, progression: preset.progression,
        label: preset.title,
      });
      toast('Scenario running',
        `${preset.title} injected on ${preset.machine_code}. Watch the dashboard.`, 'good');
      ctx.reload();
    }));

  root.querySelectorAll('[data-clear]').forEach((b) =>
    b.addEventListener('click', async () => {
      await api.clearFault(b.dataset.clear);
      toast('Machine healed', 'Health will recover on the next pipeline cycle.', 'good');
      ctx.reload();
    }));

  root.querySelector('[data-inject]').addEventListener('click', async () => {
    try {
      await api.inject({
        machine_id: Number(root.querySelector('[data-machine]').value),
        category: root.querySelector('[data-category]').value,
        severity: Number(root.querySelector('[data-severity]').value),
        progression: Number(root.querySelector('[data-progression]').value),
      });
      toast('Fault injected', 'The pipeline will pick it up within a few seconds.', 'good');
      ctx.reload();
    } catch (err) {
      toast('Injection failed', err.message);
    }
  });

  root.querySelector('[data-pause]').addEventListener('click', async () => {
    const result = await api.pausePipeline(!state.pipeline.paused);
    toast(result.paused ? 'Pipeline paused' : 'Pipeline resumed', '', 'good');
    ctx.reload();
  });
}

export { hideTip };
