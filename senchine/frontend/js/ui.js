/* Shared UI vocabulary: formatting, status rendering, icons, toasts, theme.
 *
 * Status is always colour + icon + text. A colour alone is not a status — it is
 * invisible to a colourblind reader and to anyone printing the page.
 */

export const ICONS = {
  gauge: '<path d="M12 14a2 2 0 100-4 2 2 0 000 4z"/><path d="M13.4 10.6L19 5"/><path d="M20.5 15a9 9 0 10-17 0"/>',
  grid: '<rect x="3" y="3" width="7" height="7" rx="1.5"/><rect x="14" y="3" width="7" height="7" rx="1.5"/><rect x="3" y="14" width="7" height="7" rx="1.5"/><rect x="14" y="14" width="7" height="7" rx="1.5"/>',
  bell: '<path d="M18 8a6 6 0 10-12 0c0 7-3 9-3 9h18s-3-2-3-9"/><path d="M13.7 21a2 2 0 01-3.4 0"/>',
  clipboard: '<rect x="8" y="2" width="8" height="4" rx="1"/><path d="M16 4h2a2 2 0 012 2v14a2 2 0 01-2 2H6a2 2 0 01-2-2V6a2 2 0 012-2h2"/><path d="M9 13l2 2 4-4"/>',
  chat: '<path d="M21 15a2 2 0 01-2 2H7l-4 4V5a2 2 0 012-2h14a2 2 0 012 2z"/>',
  cpu: '<rect x="4" y="4" width="16" height="16" rx="2"/><rect x="9" y="9" width="6" height="6"/><path d="M9 2v2M15 2v2M9 20v2M15 20v2M2 9h2M2 15h2M20 9h2M20 15h2"/>',
  history: '<path d="M3 3v5h5"/><path d="M3.05 13A9 9 0 106 5.3L3 8"/><path d="M12 7v5l4 2"/>',
  flask: '<path d="M9 3h6M10 3v6.5L4.6 18a2 2 0 001.7 3h11.4a2 2 0 001.7-3L14 9.5V3"/><path d="M7 15h10"/>',
  search: '<circle cx="11" cy="11" r="7"/><path d="M21 21l-4.3-4.3"/>',
  sun: '<circle cx="12" cy="12" r="4"/><path d="M12 2v2M12 20v2M4.9 4.9l1.4 1.4M17.7 17.7l1.4 1.4M2 12h2M20 12h2M4.9 19.1l1.4-1.4M17.7 6.3l1.4-1.4"/>',
  moon: '<path d="M21 12.8A9 9 0 1111.2 3a7 7 0 009.8 9.8z"/>',
  check: '<path d="M20 6L9 17l-5-5"/>',
  x: '<path d="M18 6L6 18M6 6l12 12"/>',
  alert: '<path d="M10.3 3.9L1.8 18a2 2 0 001.7 3h17a2 2 0 001.7-3L14.7 3.9a2 2 0 00-3.4 0z"/><path d="M12 9v4M12 17h.01"/>',
  info: '<circle cx="12" cy="12" r="9"/><path d="M12 16v-4M12 8h.01"/>',
  shield: '<path d="M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10z"/>',
  antenna: '<path d="M12 12v9"/><circle cx="12" cy="9" r="2"/><path d="M7.8 13.2a6 6 0 010-8.4M16.2 4.8a6 6 0 010 8.4M4.9 16.1a10 10 0 010-14.2M19.1 1.9a10 10 0 010 14.2"/>',
  wrench: '<path d="M14.7 6.3a4 4 0 105.4 5.4l-9 9a2.8 2.8 0 01-4-4l9-9z"/>',
  send: '<path d="M22 2L11 13"/><path d="M22 2l-7 20-4-9-9-4 20-7z"/>',
  refresh: '<path d="M3 12a9 9 0 0115.5-6.2L21 8"/><path d="M21 3v5h-5"/><path d="M21 12a9 9 0 01-15.5 6.2L3 16"/><path d="M3 21v-5h5"/>',
  menu: '<path d="M3 6h18M3 12h18M3 18h18"/>',
  arrowLeft: '<path d="M19 12H5"/><path d="M12 19l-7-7 7-7"/>',
  play: '<path d="M6 4l14 8-14 8z"/>',
  pause: '<rect x="6" y="4" width="4" height="16" rx="1"/><rect x="14" y="4" width="4" height="16" rx="1"/>',
  logout: '<path d="M9 21H5a2 2 0 01-2-2V5a2 2 0 012-2h4"/><path d="M16 17l5-5-5-5"/><path d="M21 12H9"/>',
  chart: '<path d="M3 3v18h18"/><path d="M7 15l4-5 4 3 5-7"/>',
  building: '<rect x="4" y="2" width="16" height="20" rx="2"/><path d="M9 7h.01M15 7h.01M9 12h.01M15 12h.01M9 17h6"/>',
};

export const icon = (name, size = 16) =>
  `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.9"
     stroke-linecap="round" stroke-linejoin="round" width="${size}" height="${size}"
     aria-hidden="true">${ICONS[name] || ''}</svg>`;

/* ---------- formatting ---------- */
export const fmt = {
  num: (v, digits = 0) =>
    v === null || v === undefined || !isFinite(v)
      ? '—'
      : Number(v).toLocaleString(undefined, {
          minimumFractionDigits: digits, maximumFractionDigits: digits }),

  money: (v) =>
    v === null || v === undefined || !isFinite(v)
      ? '—'
      : `$${Number(v).toLocaleString(undefined, { maximumFractionDigits: 0 })}`,

  pct: (v, digits = 0) =>
    v === null || v === undefined || !isFinite(v) ? '—' : `${(v * 100).toFixed(digits)}%`,

  hours: (h) => {
    if (h === null || h === undefined || !isFinite(h)) return '—';
    if (h >= 1800) return '> 75 days';
    if (h >= 72) return `${Math.round(h / 24)} days`;
    if (h >= 1) return `${Math.round(h)} h`;
    return '< 1 h';
  },

  when: (ts) => {
    if (!ts) return '—';
    const secs = Date.now() / 1000 - ts;
    if (secs < 60) return 'just now';
    if (secs < 3600) return `${Math.floor(secs / 60)}m ago`;
    if (secs < 86400) return `${Math.floor(secs / 3600)}h ago`;
    if (secs < 2592000) return `${Math.floor(secs / 86400)}d ago`;
    return new Date(ts * 1000).toLocaleDateString();
  },

  datetime: (ts) =>
    !ts ? '—' : new Date(ts * 1000).toLocaleString([], {
      month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' }),

  date: (ts) =>
    !ts ? '—' : new Date(ts * 1000).toLocaleDateString([], {
      year: 'numeric', month: 'short', day: 'numeric' }),

  title: (s) => (s || '').replace(/_/g, ' ').replace(/\b\w/g, (c) => c.toUpperCase()),
};

/* ---------- status rendering: colour + icon + label ---------- */
const BAND_META = {
  healthy:  { cls: 'pill-good',     ic: 'check', label: 'Healthy' },
  watch:    { cls: 'pill-watch',    ic: 'info',  label: 'Watch' },
  degraded: { cls: 'pill-degraded', ic: 'alert', label: 'Degraded' },
  critical: { cls: 'pill-critical', ic: 'alert', label: 'Critical' },
  unknown:  { cls: 'pill-neutral',  ic: 'info',  label: 'Unknown' },
};

export function bandPill(band) {
  const m = BAND_META[band] || BAND_META.unknown;
  return `<span class="pill ${m.cls}">${icon(m.ic, 11)}${m.label}</span>`;
}

const SEV_META = {
  critical: { cls: 'pill-critical', ic: 'alert', label: 'Critical' },
  high:     { cls: 'pill-degraded', ic: 'alert', label: 'High' },
  medium:   { cls: 'pill-watch',    ic: 'info',  label: 'Medium' },
  low:      { cls: 'pill-neutral',  ic: 'info',  label: 'Low' },
};

export function severityPill(severity) {
  const m = SEV_META[severity] || SEV_META.low;
  return `<span class="pill ${m.cls}">${icon(m.ic, 11)}${m.label}</span>`;
}

export function statusPill(status) {
  const map = {
    open: { cls: 'pill-critical', ic: 'alert', label: 'Open' },
    acknowledged: { cls: 'pill-watch', ic: 'info', label: 'Acknowledged' },
    resolved: { cls: 'pill-good', ic: 'check', label: 'Resolved' },
    suppressed: { cls: 'pill-neutral', ic: 'x', label: 'Suppressed' },
    pending_approval: { cls: 'pill-watch', ic: 'info', label: 'Needs approval' },
    scheduled: { cls: 'pill-info', ic: 'check', label: 'Scheduled' },
    in_progress: { cls: 'pill-info', ic: 'wrench', label: 'In progress' },
    completed: { cls: 'pill-good', ic: 'check', label: 'Completed' },
    cancelled: { cls: 'pill-neutral', ic: 'x', label: 'Cancelled' },
  };
  const m = map[status] || { cls: 'pill-neutral', ic: 'info', label: fmt.title(status) };
  return `<span class="pill ${m.cls}">${icon(m.ic, 11)}${m.label}</span>`;
}

export const priorityBadge = (p) =>
  `<span class="prio prio-${p}" title="Priority ${p}">${p}</span>`;

export const retrofitTag = () =>
  `<span class="retrofit-tag" title="Legacy asset monitored via EdgeSense retrofit — no onboard sensors">
     ${icon('antenna', 10)}EdgeSense</span>`;

export function confidenceMeter(value, band) {
  const pct = Math.round((value || 0) * 100);
  const cls = band === 'insufficient' ? 'insufficient' : band === 'low' ? 'low' : '';
  return `<span class="meter" title="Evidence confidence: ${band || 'unknown'}">
      <span class="meter-track"><span class="meter-fill ${cls}" style="width:${pct}%"></span></span>
      <span class="meter-val">${pct}%</span>
    </span>`;
}

export const bandColor = (band) => ({
  healthy: 'var(--st-good)',
  watch: 'var(--st-warning)',
  degraded: 'var(--st-serious)',
  critical: 'var(--st-critical)',
}[band] || 'var(--ink-muted)');

/* ---------- escaping & lightweight markdown ---------- */
export const esc = (s) =>
  String(s ?? '').replace(/[&<>"']/g, (c) =>
    ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

/** Render the restricted markdown subset the Copilot emits. Escapes first, so
 *  model output can never inject markup. */
export function markdown(text) {
  const lines = esc(text).split('\n');
  const out = [];
  let inList = false;

  const inline = (s) =>
    s.replace(/\*\*(.+?)\*\*/g, '<strong>$1</strong>')
     .replace(/(^|[\s(])\*([^*\n]+)\*(?=[\s.,;:)]|$)/g, '$1<em>$2</em>')
     .replace(/`([^`]+)`/g, '<code class="mono">$1</code>');

  for (const raw of lines) {
    const line = raw.trimEnd();
    if (/^\s*[-•]\s+/.test(line)) {
      if (!inList) { out.push('<ul>'); inList = true; }
      out.push(`<li>${inline(line.replace(/^\s*[-•]\s+/, ''))}</li>`);
      continue;
    }
    if (/^\s*\d+\.\s+/.test(line)) {
      if (!inList) { out.push('<ul>'); inList = true; }
      out.push(`<li>${inline(line.replace(/^\s*\d+\.\s+/, ''))}</li>`);
      continue;
    }
    if (inList) { out.push('</ul>'); inList = false; }
    if (!line.trim()) continue;
    out.push(`<p>${inline(line)}</p>`);
  }
  if (inList) out.push('</ul>');
  return out.join('');
}

/* ---------- toasts ---------- */
let toastStack = null;
export function toast(title, body = '', variant = '') {
  if (!toastStack) {
    toastStack = document.createElement('div');
    toastStack.className = 'toast-stack';
    document.body.appendChild(toastStack);
  }
  const node = document.createElement('div');
  node.className = `toast ${variant}`;
  node.innerHTML = `<div class="t-title">${esc(title)}</div>${
    body ? `<div class="t-body">${esc(body)}</div>` : ''}`;
  toastStack.appendChild(node);
  setTimeout(() => {
    node.style.transition = 'opacity .25s, transform .25s';
    node.style.opacity = '0';
    node.style.transform = 'translateX(18px)';
    setTimeout(() => node.remove(), 260);
  }, 4800);
}

/* ---------- theme ---------- */
const THEME_KEY = 'senchine.theme';

export const theme = {
  get() { return localStorage.getItem(THEME_KEY) || 'system'; },
  apply(mode) {
    if (mode === 'system') document.documentElement.removeAttribute('data-theme');
    else document.documentElement.setAttribute('data-theme', mode);
    localStorage.setItem(THEME_KEY, mode);
  },
  isDark() {
    const mode = theme.get();
    if (mode === 'dark') return true;
    if (mode === 'light') return false;
    return window.matchMedia('(prefers-color-scheme: dark)').matches;
  },
  toggle() {
    const next = theme.isDark() ? 'light' : 'dark';
    theme.apply(next);
    return next;
  },
  init() { theme.apply(theme.get()); },
};

/* ---------- drawer ---------- */
export function openDrawer({ title, body, footer = '', onMount }) {
  closeDrawer();
  const scrim = document.createElement('div');
  scrim.className = 'drawer-scrim';
  scrim.dataset.drawer = '1';

  const drawer = document.createElement('aside');
  drawer.className = 'drawer';
  drawer.dataset.drawer = '1';
  drawer.setAttribute('role', 'dialog');
  drawer.setAttribute('aria-modal', 'true');
  drawer.innerHTML = `
    <div class="drawer-head">
      <h2>${esc(title)}</h2>
      <button class="icon-btn" data-close aria-label="Close" style="margin-left:auto">
        ${icon('x', 18)}</button>
    </div>
    <div class="drawer-body">${body}</div>
    ${footer ? `<div class="drawer-foot">${footer}</div>` : ''}`;

  document.body.appendChild(scrim);
  document.body.appendChild(drawer);
  scrim.addEventListener('click', closeDrawer);
  drawer.querySelector('[data-close]').addEventListener('click', closeDrawer);
  document.addEventListener('keydown', escClose);
  onMount?.(drawer);
  return drawer;
}

function escClose(ev) { if (ev.key === 'Escape') closeDrawer(); }

export function closeDrawer() {
  document.querySelectorAll('[data-drawer]').forEach((n) => n.remove());
  document.removeEventListener('keydown', escClose);
}

export const emptyState = (message, iconName = 'info') =>
  `<div class="empty">${icon(iconName, 34)}<div>${esc(message)}</div></div>`;

export const loading = () => '<div class="loading-page"><div class="spinner"></div></div>';
