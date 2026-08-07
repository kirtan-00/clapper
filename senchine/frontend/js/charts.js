/* Inline-SVG chart primitives.
 *
 * No charting library and no CDN — the pages must render with zero external
 * requests. Each chart reads its colours from CSS custom properties, so light
 * and dark mode are one token swap rather than two code paths.
 *
 * Every plotted chart ships a hover layer (crosshair + tooltip on time series,
 * per-mark tooltip on bars). Sparklines are the deliberate exception: they are
 * glanceable context inside a stat tile, not a chart to interrogate.
 */

const NS = 'http://www.w3.org/2000/svg';

/* ---------- tooltip singleton ---------- */
let tipEl = null;
function tooltip() {
  if (!tipEl) {
    tipEl = document.createElement('div');
    tipEl.className = 'chart-tooltip';
    document.body.appendChild(tipEl);
  }
  return tipEl;
}
function showTip(html, x, y) {
  const t = tooltip();
  t.innerHTML = html;
  t.classList.add('on');
  const r = t.getBoundingClientRect();
  let left = x + 14;
  let top = y - r.height / 2;
  if (left + r.width > window.innerWidth - 10) left = x - r.width - 14;
  top = Math.max(8, Math.min(top, window.innerHeight - r.height - 8));
  t.style.left = `${left}px`;
  t.style.top = `${top}px`;
}
export function hideTip() {
  if (tipEl) tipEl.classList.remove('on');
}

/* ---------- helpers ---------- */
function el(name, attrs = {}, parent = null) {
  const node = document.createElementNS(NS, name);
  for (const [k, v] of Object.entries(attrs)) {
    if (v !== null && v !== undefined) node.setAttribute(k, String(v));
  }
  if (parent) parent.appendChild(node);
  return node;
}

function svgRoot(width, height) {
  const svg = el('svg', {
    class: 'chart',
    viewBox: `0 0 ${width} ${height}`,
    preserveAspectRatio: 'none',
    role: 'img',
  });
  svg.style.height = `${height}px`;
  return svg;
}

function niceTicks(min, max, count = 4) {
  if (!isFinite(min) || !isFinite(max) || min === max) return [min];
  const span = max - min;
  const raw = span / count;
  const mag = Math.pow(10, Math.floor(Math.log10(raw)));
  const norm = raw / mag;
  const step = (norm >= 7.5 ? 10 : norm >= 3.5 ? 5 : norm >= 1.5 ? 2 : 1) * mag;
  const out = [];
  for (let v = Math.ceil(min / step) * step; v <= max + step * 0.001; v += step) {
    out.push(Number(v.toFixed(10)));
  }
  return out;
}

const fmtTime = (ts) =>
  new Date(ts * 1000).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });

/* ==========================================================================
   Sparkline — glanceable trend inside a stat tile. No axes, no hover.
   ========================================================================== */
export function sparkline(values, { width = 150, height = 32, color = 'var(--series-1)' } = {}) {
  const svg = svgRoot(width, height);
  const pts = (values || []).filter((v) => typeof v === 'number' && isFinite(v));
  if (pts.length < 2) return svg;

  const min = Math.min(...pts);
  const max = Math.max(...pts);
  const span = max - min || 1;
  const pad = 3;
  const x = (i) => (i / (pts.length - 1)) * width;
  const y = (v) => height - pad - ((v - min) / span) * (height - pad * 2);

  const line = pts.map((v, i) => `${i ? 'L' : 'M'}${x(i).toFixed(2)},${y(v).toFixed(2)}`).join(' ');
  el('path', {
    d: `${line} L${width},${height} L0,${height} Z`,
    fill: color, class: 'series-area',
  }, svg);
  el('path', { d: line, class: 'series-line', stroke: color }, svg);
  // Terminal marker: the eye needs an anchor for "where it is now".
  el('circle', { cx: x(pts.length - 1), cy: y(pts[pts.length - 1]), r: 2.5, fill: color }, svg);
  return svg;
}

/* ==========================================================================
   Time series — one y-axis, always. Crosshair + tooltip.
   ========================================================================== */
export function timeSeries(container, { points, series, height = 210, yLabel = '', yMin, yMax }) {
  container.innerHTML = '';
  if (!points || points.length < 2) {
    container.innerHTML = '<div class="empty">Not enough data yet.</div>';
    return;
  }

  const W = 720;
  const H = height;
  const M = { top: 12, right: 14, bottom: 26, left: 40 };
  const iw = W - M.left - M.right;
  const ih = H - M.top - M.bottom;

  const all = series.flatMap((s) => points.map((p) => p[s.key]).filter((v) => isFinite(v)));
  let lo = yMin !== undefined ? yMin : Math.min(...all);
  let hi = yMax !== undefined ? yMax : Math.max(...all);
  if (lo === hi) { lo -= 1; hi += 1; }
  const padY = (hi - lo) * 0.08;
  lo = yMin !== undefined ? yMin : lo - padY;
  hi = yMax !== undefined ? yMax : hi + padY;

  const xOf = (i) => M.left + (i / (points.length - 1)) * iw;
  const yOf = (v) => M.top + ih - ((v - lo) / (hi - lo)) * ih;

  const svg = svgRoot(W, H);
  svg.setAttribute('preserveAspectRatio', 'xMidYMid meet');
  svg.style.width = '100%';
  svg.setAttribute('aria-label', yLabel || 'time series');

  // recessive grid + ticks
  for (const t of niceTicks(lo, hi, 4)) {
    if (t < lo || t > hi) continue;
    const y = yOf(t);
    el('line', { class: 'grid-line', x1: M.left, x2: W - M.right, y1: y, y2: y }, svg);
    el('text', { class: 'tick', x: M.left - 7, y: y + 3.5, 'text-anchor': 'end' }, svg)
      .textContent = String(Math.round(t * 100) / 100);
  }
  el('line', { class: 'axis-line', x1: M.left, x2: W - M.right, y1: M.top + ih, y2: M.top + ih }, svg);

  const tickCount = Math.min(5, points.length);
  for (let k = 0; k < tickCount; k++) {
    const i = Math.round((k / (tickCount - 1 || 1)) * (points.length - 1));
    el('text', {
      class: 'tick', x: xOf(i), y: H - 8,
      'text-anchor': k === 0 ? 'start' : k === tickCount - 1 ? 'end' : 'middle',
    }, svg).textContent = fmtTime(points[i].ts);
  }

  // series
  for (const s of series) {
    const valid = points.map((p, i) => ({ i, v: p[s.key] })).filter((d) => isFinite(d.v));
    if (valid.length < 2) continue;
    const d = valid.map((p, k) => `${k ? 'L' : 'M'}${xOf(p.i).toFixed(2)},${yOf(p.v).toFixed(2)}`).join(' ');
    if (s.area) {
      el('path', {
        d: `${d} L${xOf(valid[valid.length - 1].i)},${M.top + ih} L${xOf(valid[0].i)},${M.top + ih} Z`,
        fill: s.color, class: 'series-area',
      }, svg);
    }
    el('path', { d, class: 'series-line', stroke: s.color }, svg);
  }

  // hover layer
  const crosshair = el('line', {
    class: 'crosshair', y1: M.top, y2: M.top + ih, x1: -99, x2: -99,
  }, svg);
  const dots = series.map((s) =>
    el('circle', { class: 'marker', r: 4, fill: s.color, stroke: 'var(--surface-1)',
      'stroke-width': 2, cx: -99, cy: -99 }, svg));

  const band = el('rect', {
    class: 'hover-band', x: M.left, y: M.top, width: iw, height: ih,
  }, svg);

  band.addEventListener('pointermove', (ev) => {
    const rect = svg.getBoundingClientRect();
    const scale = W / rect.width;
    const px = (ev.clientX - rect.left) * scale;
    const ratio = Math.max(0, Math.min(1, (px - M.left) / iw));
    const i = Math.round(ratio * (points.length - 1));
    const p = points[i];

    crosshair.setAttribute('x1', xOf(i));
    crosshair.setAttribute('x2', xOf(i));

    const rows = series.map((s, k) => {
      const v = p[s.key];
      if (isFinite(v)) {
        dots[k].setAttribute('cx', xOf(i));
        dots[k].setAttribute('cy', yOf(v));
      } else {
        dots[k].setAttribute('cx', -99);
      }
      return `<div class="tt-row"><span class="tt-sw" style="background:${s.color}"></span>
              <span>${s.label}</span><span class="tt-val">${
                isFinite(v) ? (s.format ? s.format(v) : v.toFixed(2)) : '—'
              }</span></div>`;
    }).join('');

    showTip(`<div class="tt-title">${fmtTime(p.ts)}</div>${rows}`, ev.clientX, ev.clientY);
  });
  band.addEventListener('pointerleave', () => {
    hideTip();
    crosshair.setAttribute('x1', -99);
    crosshair.setAttribute('x2', -99);
    dots.forEach((d) => d.setAttribute('cx', -99));
  });

  container.appendChild(svg);

  // Legend for >= 2 series; a single series is named by the card title.
  if (series.length >= 2) {
    const legend = document.createElement('div');
    legend.className = 'legend';
    legend.innerHTML = series.map((s) =>
      `<span class="legend-item"><span class="legend-sw" style="background:${s.color}"></span>${s.label}</span>`
    ).join('');
    container.appendChild(legend);
  }
}

/* ==========================================================================
   Diverging bars — SHAP attribution. Polarity, so two hues + neutral centre.
   ========================================================================== */
export function divergingBars(container, items, { height = null, valueFormat } = {}) {
  container.innerHTML = '';
  if (!items || !items.length) {
    container.innerHTML = '<div class="empty">No attribution available.</div>';
    return;
  }

  const rowH = 30;
  const W = 640;
  const M = { top: 6, right: 76, bottom: 20, left: 178 };
  const H = height || M.top + M.bottom + items.length * rowH;
  const iw = W - M.left - M.right;

  const maxAbs = Math.max(...items.map((d) => Math.abs(d.value))) || 1;
  const mid = M.left + iw / 2;
  const scale = (v) => (v / maxAbs) * (iw / 2);

  const svg = svgRoot(W, H);
  svg.setAttribute('preserveAspectRatio', 'xMidYMid meet');
  svg.style.width = '100%';

  // neutral centre line — "no contribution"
  el('line', {
    class: 'axis-line', x1: mid, x2: mid, y1: M.top, y2: H - M.bottom,
  }, svg);

  items.forEach((d, i) => {
    const y = M.top + i * rowH;
    const w = Math.abs(scale(d.value));
    const positive = d.value >= 0;
    const x = positive ? mid : mid - w;
    const color = positive ? 'var(--div-pos)' : 'var(--div-neg)';

    const bar = el('rect', {
      class: 'bar', x, y: y + 7, width: Math.max(w, 2), height: rowH - 15,
      fill: color, rx: 4,
    }, svg);

    el('text', {
      class: 'bar-label', x: M.left - 10, y: y + rowH / 2 + 3.5, 'text-anchor': 'end',
    }, svg).textContent = d.label.length > 26 ? `${d.label.slice(0, 25)}…` : d.label;

    // Direct value labels: these are few and each one matters.
    el('text', {
      class: 'value-label',
      x: positive ? Math.min(x + w + 7, W - M.right + 60) : Math.max(x - 7, 4),
      y: y + rowH / 2 + 3.5,
      'text-anchor': positive ? 'start' : 'end',
    }, svg).textContent = valueFormat ? valueFormat(d.value) : d.value.toFixed(3);

    bar.addEventListener('pointermove', (ev) => {
      showTip(
        `<div class="tt-title">${d.label}</div>
         <div class="tt-row"><span>Contribution</span>
           <span class="tt-val">${d.value >= 0 ? '+' : ''}${d.value.toFixed(4)}</span></div>
         ${d.observed !== undefined
            ? `<div class="tt-row"><span>Observed</span><span class="tt-val">${d.observed.toFixed(2)}× nominal</span></div>` : ''}
         ${d.deviation !== undefined
            ? `<div class="tt-row"><span>vs baseline</span><span class="tt-val">${d.deviation > 0 ? '+' : ''}${d.deviation.toFixed(0)}%</span></div>` : ''}
         <div class="tt-row"><span>${d.value >= 0 ? 'Increases risk' : 'Reduces risk'}</span></div>`,
        ev.clientX, ev.clientY
      );
    });
    bar.addEventListener('pointerleave', hideTip);
  });

  container.appendChild(svg);

  const legend = document.createElement('div');
  legend.className = 'legend';
  legend.innerHTML =
    `<span class="legend-item"><span class="legend-sw" style="background:var(--div-pos)"></span>Increases failure risk</span>
     <span class="legend-item"><span class="legend-sw" style="background:var(--div-neg)"></span>Reduces failure risk</span>`;
  container.appendChild(legend);
}

/* ==========================================================================
   Horizontal magnitude bars — one hue, ranked. Hover tooltip.
   ========================================================================== */
export function rankedBars(container, items, { color = 'var(--series-1)', valueFormat } = {}) {
  container.innerHTML = '';
  if (!items || !items.length) {
    container.innerHTML = '<div class="empty">No data.</div>';
    return;
  }
  const rowH = 27;
  const W = 560;
  const M = { top: 4, right: 54, bottom: 4, left: 152 };
  const H = M.top + M.bottom + items.length * rowH;
  const iw = W - M.left - M.right;
  const max = Math.max(...items.map((d) => d.value)) || 1;

  const svg = svgRoot(W, H);
  svg.setAttribute('preserveAspectRatio', 'xMidYMid meet');
  svg.style.width = '100%';

  items.forEach((d, i) => {
    const y = M.top + i * rowH;
    const w = Math.max((d.value / max) * iw, 2);

    el('rect', {
      class: 'bar', x: M.left, y: y + 6, width: iw, height: rowH - 13,
      fill: 'var(--surface-sunken)', rx: 4,
    }, svg);
    const bar = el('rect', {
      class: 'bar', x: M.left, y: y + 6, width: w, height: rowH - 13,
      fill: d.color || color, rx: 4,
    }, svg);

    el('text', {
      class: 'bar-label', x: M.left - 10, y: y + rowH / 2 + 3.5, 'text-anchor': 'end',
    }, svg).textContent = d.label.length > 22 ? `${d.label.slice(0, 21)}…` : d.label;

    el('text', {
      class: 'value-label', x: M.left + iw + 8, y: y + rowH / 2 + 3.5,
    }, svg).textContent = valueFormat ? valueFormat(d.value) : String(d.value);

    bar.addEventListener('pointermove', (ev) => {
      showTip(
        `<div class="tt-title">${d.label}</div>
         <div class="tt-row"><span>${d.unit || 'Value'}</span>
         <span class="tt-val">${valueFormat ? valueFormat(d.value) : d.value}</span></div>
         ${d.note ? `<div class="tt-row"><span>${d.note}</span></div>` : ''}`,
        ev.clientX, ev.clientY
      );
    });
    bar.addEventListener('pointerleave', hideTip);
  });

  container.appendChild(svg);
}

/* ==========================================================================
   Health band distribution — a stacked ribbon with a 2px surface gap.
   Status colours, each with a text label beside it.
   ========================================================================== */
export function bandRibbon(container, bands) {
  container.innerHTML = '';
  const order = [
    { key: 'healthy',  label: 'Healthy',  color: 'var(--st-good)' },
    { key: 'watch',    label: 'Watch',    color: 'var(--st-warning)' },
    { key: 'degraded', label: 'Degraded', color: 'var(--st-serious)' },
    { key: 'critical', label: 'Critical', color: 'var(--st-critical)' },
  ];
  const total = order.reduce((sum, b) => sum + (bands[b.key] || 0), 0);
  if (!total) {
    container.innerHTML = '<div class="empty">No machines monitored yet.</div>';
    return;
  }

  const W = 560;
  const H = 26;
  const svg = svgRoot(W, H);
  svg.setAttribute('preserveAspectRatio', 'none');
  svg.style.width = '100%';

  let x = 0;
  for (const b of order) {
    const n = bands[b.key] || 0;
    if (!n) continue;
    const w = (n / total) * W;
    const seg = el('rect', {
      class: 'bar', x, y: 0, width: Math.max(w - 2, 1), height: H, fill: b.color, rx: 4,
    }, svg);
    seg.addEventListener('pointermove', (ev) => {
      showTip(
        `<div class="tt-title">${b.label}</div>
         <div class="tt-row"><span>Machines</span><span class="tt-val">${n}</span></div>
         <div class="tt-row"><span>Share</span><span class="tt-val">${((n / total) * 100).toFixed(0)}%</span></div>`,
        ev.clientX, ev.clientY);
    });
    seg.addEventListener('pointerleave', hideTip);
    x += w;
  }
  container.appendChild(svg);

  const legend = document.createElement('div');
  legend.className = 'legend';
  legend.innerHTML = order
    .filter((b) => bands[b.key])
    .map((b) =>
      `<span class="legend-item"><span class="legend-sw"
        style="background:${b.color};width:11px;height:11px;border-radius:3px"></span>
        ${b.label} <strong class="num">${bands[b.key]}</strong></span>`)
    .join('');
  container.appendChild(legend);
}
