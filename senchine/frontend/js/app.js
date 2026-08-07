/* Application shell: auth gate, router, realtime wiring, chrome. */

import { api, ApiError, auth, Realtime } from './api.js';
import { esc, fmt, icon, theme, toast } from './ui.js';
import { hideTip } from './charts.js';
import {
  agentsView, alertsView, copilotView, dashboard, fleetView, historyView,
  labView, machineView, workOrdersView,
} from './views.js';

theme.init();

const app = document.getElementById('app');

const ROUTES = [
  { id: 'dashboard', label: 'Overview', icon: 'gauge', group: 'Monitor', render: dashboard },
  { id: 'fleet', label: 'Machines', icon: 'grid', group: 'Monitor', render: fleetView },
  { id: 'alerts', label: 'Alerts', icon: 'bell', group: 'Respond', render: alertsView, counter: 'alerts' },
  { id: 'workorders', label: 'Work orders', icon: 'clipboard', group: 'Respond', render: workOrdersView, counter: 'workorders' },
  { id: 'history', label: 'History', icon: 'history', group: 'Respond', render: historyView },
  { id: 'copilot', label: 'AI Copilot', icon: 'chat', group: 'Intelligence', render: copilotView },
  { id: 'agents', label: 'Agents & models', icon: 'cpu', group: 'Intelligence', render: agentsView },
  { id: 'lab', label: 'Scenario lab', icon: 'flask', group: 'Intelligence', render: labView },
];

const state = {
  user: null,
  realtime: null,
  route: 'dashboard',
  param: null,
  cleanup: null,
  listeners: new Map(),   // event name -> Set(handler)
  counts: { alerts: 0, workorders: 0, notifications: 0 },
  copilotHistory: [],
  currentMachineId: null,
  wsConnected: false,
};

/* ---------- event bus for realtime ---------- */
function onEvent(names, handler) {
  const list = Array.isArray(names) ? names : [names];
  for (const name of list) {
    if (!state.listeners.has(name)) state.listeners.set(name, new Set());
    state.listeners.get(name).add(handler);
  }
  return () => list.forEach((name) => state.listeners.get(name)?.delete(handler));
}

function emit(name, payload) {
  state.listeners.get(name)?.forEach((fn) => {
    try { fn(payload); } catch { /* a broken view must not stop the stream */ }
  });
}

/* ==========================================================================
   Login
   ========================================================================== */
async function renderLogin(message = '') {
  let demo = { accounts: [], password: 'senchine' };
  try { demo = await api.demoAccounts(); } catch { /* server may still be booting */ }

  app.innerHTML = `
    <div class="login-screen">
      <div class="login-brandside">
        <div class="brand">
          <div class="brand-mark">${icon('antenna', 20)}</div>
          <div><div class="brand-name">Senchine AI</div>
            <div class="brand-sub">Predictive maintenance</div></div>
        </div>
        <div class="pitch">
          <h2>Every machine on the floor, including the ones nobody can see.</h2>
          <p>A multi-agent platform that predicts equipment failure from IoT telemetry —
             and from legacy machines that have no sensors at all.</p>
          <ul class="pitch-points">
            <li><span class="dot"></span><div>
              <strong>EdgeSense retrofit</strong>
              <span>Fuses external vibration, thermal, acoustic, ultrasonic and electrical
                devices to estimate the health of machines built before IoT existed.</span></div></li>
            <li><span class="dot"></span><div>
              <strong>Four cooperating agents</strong>
              <span>Monitoring, Prediction, Maintenance and an AI Copilot — each traced,
                each explainable.</span></div></li>
            <li><span class="dot"></span><div>
              <strong>Explained, not asserted</strong>
              <span>Every prediction ships with Shapley attributions, a calibrated confidence
                and a plain statement of its own limitations.</span></div></li>
          </ul>
        </div>
        <div class="muted" style="font-size:11.5px">
          Reusable across automotive, steel, chemical, cement, pharmaceutical,
          food processing, mining, electronics, FMCG and energy.</div>
      </div>

      <div class="login-formside">
        <div class="login-card">
          <h1>Sign in</h1>
          <p>Access the plant intelligence console.</p>
          ${message ? `<div class="notice danger" style="margin-bottom:14px">
            ${icon('alert', 15)}<div>${esc(message)}</div></div>` : ''}
          <form data-form>
            <div class="field">
              <label for="email">Work email</label>
              <input class="input" id="email" type="email" autocomplete="username"
                     value="engineer@senchine.ai" required>
            </div>
            <div class="field">
              <label for="password">Password</label>
              <input class="input" id="password" type="password"
                     autocomplete="current-password" value="senchine" required>
            </div>
            <button class="btn btn-primary btn-block" type="submit" data-submit>Sign in</button>
          </form>

          <div class="demo-accounts">
            <h3>Demo accounts · password <span class="mono">${esc(demo.password)}</span></h3>
            <div class="demo-grid">
              ${demo.accounts.map((a) => `
                <button class="demo-btn" data-email="${esc(a.email)}">
                  <span><strong>${esc(a.name)}</strong>
                    <div class="muted" style="font-size:11.5px">${esc(a.email)}</div></span>
                  <span class="role">${esc(a.role)}</span>
                </button>`).join('')}
            </div>
          </div>
        </div>
      </div>
    </div>`;

  app.querySelectorAll('[data-email]').forEach((b) =>
    b.addEventListener('click', () => {
      app.querySelector('#email').value = b.dataset.email;
      app.querySelector('#password').value = demo.password;
      app.querySelector('[data-form]').requestSubmit();
    }));

  app.querySelector('[data-form]').addEventListener('submit', async (ev) => {
    ev.preventDefault();
    const btn = app.querySelector('[data-submit]');
    btn.disabled = true;
    btn.innerHTML = '<span class="spinner"></span>Signing in';
    try {
      const result = await api.login(
        app.querySelector('#email').value,
        app.querySelector('#password').value
      );
      auth.set(result.access_token, result.user);
      state.user = result.user;
      await boot();
    } catch (err) {
      btn.disabled = false;
      btn.textContent = 'Sign in';
      renderLogin(err instanceof ApiError ? err.message : 'Sign-in failed.');
    }
  });
}

/* ==========================================================================
   Shell
   ========================================================================== */
function renderShell() {
  const groups = [...new Set(ROUTES.map((r) => r.group))];
  const initials = (state.user.name || '?')
    .split(' ').map((p) => p[0]).slice(0, 2).join('').toUpperCase();

  app.innerHTML = `
    <div class="app">
      <aside class="sidebar" data-sidebar>
        <div class="sidebar-head">
          <div class="brand">
            <div class="brand-mark">${icon('antenna', 20)}</div>
            <div><div class="brand-name">Senchine AI</div>
              <div class="brand-sub">Predictive maintenance</div></div>
          </div>
        </div>
        <nav class="nav">
          ${groups.map((g) => `
            <div class="nav-group-label">${esc(g)}</div>
            ${ROUTES.filter((r) => r.group === g).map((r) => `
              <button class="nav-item" data-route="${r.id}">
                ${icon(r.icon, 17)}<span>${esc(r.label)}</span>
                ${r.counter ? `<span class="nav-count" data-counter="${r.counter}" hidden>0</span>` : ''}
              </button>`).join('')}`).join('')}
        </nav>
        <div class="sidebar-foot">
          <div class="pipeline-chip">
            <span class="live-dot" data-live></span>
            <span data-pipeline>Connecting…</span>
          </div>
        </div>
      </aside>

      <div class="main">
        <header class="topbar">
          <button class="icon-btn" data-menu aria-label="Toggle navigation"
                  style="display:none">${icon('menu', 18)}</button>
          <div class="topbar-title" data-title>Overview</div>
          <div class="topbar-spacer"></div>
          <div class="searchbox">
            ${icon('search', 15)}
            <input data-search placeholder="Search machines…" aria-label="Search machines">
          </div>
          <button class="icon-btn" data-theme aria-label="Toggle colour theme">
            ${icon(theme.isDark() ? 'sun' : 'moon', 18)}</button>
          <button class="icon-btn" data-notifications aria-label="Notifications">
            ${icon('bell', 18)}
            <span class="badge" data-notif-badge hidden>0</span></button>
          <button class="user-chip" data-user>
            <span class="avatar">${esc(initials)}</span>
            <span class="meta">
              <span class="who">${esc(state.user.name)}</span>
              <span class="role">${esc(state.user.role)}</span></span>
          </button>
        </header>
        <main class="content" data-view></main>
      </div>
    </div>`;

  app.querySelectorAll('[data-route]').forEach((b) =>
    b.addEventListener('click', () => {
      go(b.dataset.route);
      app.querySelector('[data-sidebar]')?.classList.remove('open');
    }));

  app.querySelector('[data-theme]').addEventListener('click', (ev) => {
    const mode = theme.toggle();
    ev.currentTarget.innerHTML = icon(mode === 'dark' ? 'sun' : 'moon', 18);
  });

  app.querySelector('[data-menu]').addEventListener('click', () =>
    app.querySelector('[data-sidebar]').classList.toggle('open'));

  app.querySelector('[data-notifications]').addEventListener('click', showNotifications);
  app.querySelector('[data-user]').addEventListener('click', showAccount);

  const search = app.querySelector('[data-search]');
  search.addEventListener('keydown', (ev) => {
    if (ev.key === 'Enter' && ev.target.value.trim()) {
      go('fleet', null, ev.target.value.trim());
      ev.target.value = '';
    }
  });

  if (window.matchMedia('(max-width: 860px)').matches) {
    app.querySelector('[data-menu]').style.display = 'grid';
  }
}

/* ---------- routing ---------- */
function go(routeId, param = null, search = '') {
  location.hash = param ? `#/${routeId}/${param}` : `#/${routeId}`;
  renderRoute(routeId, param, search);
}

async function renderRoute(routeId, param = null, search = '') {
  const route = ROUTES.find((r) => r.id === routeId) || ROUTES[0];
  state.route = route.id;
  state.param = param;
  state.currentMachineId = routeId === 'machine' ? Number(param) : null;

  // Tear down the previous view's realtime subscriptions.
  state.cleanup?.();
  state.cleanup = null;
  hideTip();

  app.querySelectorAll('[data-route]').forEach((b) =>
    b.classList.toggle('active', b.dataset.route === route.id));
  const titleEl = app.querySelector('[data-title]');
  if (titleEl) titleEl.textContent = routeId === 'machine' ? 'Machine detail' : route.label;

  const view = app.querySelector('[data-view]');
  const ctx = {
    go: (path) => {
      const [id, p] = path.split('/');
      go(id, p);
    },
    reload: () => renderRoute(state.route, state.param, search),
    onEvent,
    user: state.user,
    search,
    copilotHistory: state.copilotHistory,
    currentMachineId: state.currentMachineId,
  };

  try {
    state.cleanup = routeId === 'machine'
      ? await machineView(view, ctx, Number(param))
      : await route.render(view, ctx);
  } catch (err) {
    if (err instanceof ApiError && err.status === 401) return;
    view.innerHTML = `<div class="empty">${icon('alert', 34)}
      <div><strong>Could not load this view.</strong></div>
      <div class="muted" style="margin-top:6px">${esc(err.message)}</div>
      <button class="btn btn-sm" style="margin-top:14px" onclick="location.reload()">Reload</button>
    </div>`;
  }
}

function routeFromHash() {
  const raw = location.hash.replace(/^#\/?/, '');
  const [id, param] = raw.split('/');
  if (id === 'machine' && param) return { id: 'machine', param };
  const known = ROUTES.find((r) => r.id === id);
  return { id: known ? known.id : 'dashboard', param: null };
}

window.addEventListener('hashchange', () => {
  const { id, param } = routeFromHash();
  if (id !== state.route || param !== state.param) renderRoute(id, param);
});

/* ---------- realtime ---------- */
function handleRealtime(message) {
  const { event, data } = message;

  switch (event) {
    case 'pipeline.cycle': {
      const el = app.querySelector('[data-pipeline]');
      if (el) {
        el.textContent = `Live · cycle ${data.tick} · ${Math.round(data.cycle_ms)} ms`;
      }
      break;
    }
    case 'alert.raised':
      state.counts.alerts += 1;
      updateCounters();
      toast(
        `${data.severity === 'critical' ? 'Critical' : 'New'} alert · ${data.machine_code}`,
        data.title, data.severity === 'critical' ? 'critical' : ''
      );
      break;
    case 'alert.escalated':
      toast(`Alert escalated · ${data.machine_code}`, data.title, 'critical');
      break;
    case 'alert.acknowledged':
    case 'alert.resolved':
      state.counts.alerts = Math.max(0, state.counts.alerts - 1);
      updateCounters();
      break;
    case 'workorder.created':
      state.counts.workorders += 1;
      updateCounters();
      toast(`Work order ${data.code}`,
        `${data.priority} on ${data.machine_code}${data.requires_approval ? ' — needs approval' : ''}`);
      break;
    case 'notification.new':
      state.counts.notifications += 1;
      updateCounters();
      break;
    default:
      break;
  }
  emit(event, data);
}

function updateCounters() {
  for (const [key, value] of Object.entries(state.counts)) {
    const el = app.querySelector(`[data-counter="${key}"]`);
    if (el) {
      el.hidden = !value;
      el.textContent = value;
      el.classList.toggle('alarm', key === 'alerts' && value > 0);
    }
  }
  const badge = app.querySelector('[data-notif-badge]');
  if (badge) {
    badge.hidden = !state.counts.notifications;
    badge.textContent = state.counts.notifications > 99 ? '99+' : state.counts.notifications;
  }
}

window.addEventListener('senchine:ws', (ev) => {
  state.wsConnected = ev.detail.connected;
  const dot = app.querySelector('[data-live]');
  const label = app.querySelector('[data-pipeline]');
  if (dot) dot.classList.toggle('off', !ev.detail.connected);
  if (label && !ev.detail.connected) label.textContent = 'Reconnecting…';
});

window.addEventListener('senchine:signed-out', () => {
  state.realtime?.close();
  state.realtime = null;
  renderLogin('Your session expired. Please sign in again.');
});

/* ---------- panels ---------- */
async function showNotifications() {
  const { openDrawer, closeDrawer } = await import('./ui.js');
  const data = await api.notifications();
  state.counts.notifications = 0;
  updateCounters();

  openDrawer({
    title: `Notifications${data.unread ? ` · ${data.unread} unread` : ''}`,
    body: data.notifications.length ? data.notifications.map((n) => `
      <div style="padding:11px 0;border-bottom:1px solid var(--border);
                  ${n.read_at ? 'opacity:.62' : ''}">
        <div style="display:flex;align-items:center;gap:8px;margin-bottom:4px">
          <span class="pill ${n.severity === 'critical' ? 'pill-critical'
            : n.severity === 'high' ? 'pill-degraded' : 'pill-neutral'}"
            style="font-size:10.5px">${icon(n.severity === 'critical' ? 'alert' : 'info', 10)}
            ${esc(n.channel)}</span>
          <span class="muted" style="font-size:11px;margin-left:auto">${fmt.when(n.created_at)}</span>
        </div>
        <div style="font-weight:600;font-size:12.5px">${esc(n.subject)}</div>
        <div class="secondary" style="font-size:12px;white-space:pre-wrap;margin-top:3px">
          ${esc(n.body)}</div>
      </div>`).join('')
      : '<div class="empty">No notifications yet.</div>',
    footer: '<button class="btn" data-all>Mark all read</button>',
    onMount(drawer) {
      drawer.querySelector('[data-all]')?.addEventListener('click', async () => {
        await api.markAllRead();
        closeDrawer();
        toast('All notifications marked read', '', 'good');
      });
    },
  });
}

async function showAccount() {
  const { openDrawer, closeDrawer } = await import('./ui.js');
  openDrawer({
    title: 'Account',
    body: `
      <dl class="kv">
        <dt>Name</dt><dd>${esc(state.user.name)}</dd>
        <dt>Email</dt><dd>${esc(state.user.email)}</dd>
        <dt>Role</dt><dd>${esc(state.user.role)}</dd>
        <dt>Skills</dt><dd>${(state.user.skills || []).join(', ') || '—'}</dd>
      </dl>
      <h3 style="margin:18px 0 8px">Appearance</h3>
      <div class="seg" data-theme-seg>
        <button data-mode="light">Light</button>
        <button data-mode="dark">Dark</button>
        <button data-mode="system">System</button>
      </div>
      <h3 style="margin:18px 0 8px">Permissions</h3>
      <p class="secondary" style="font-size:12.5px">
        Your role determines what you can act on. Acknowledging alerts and progressing
        work orders requires <strong>technician</strong> or above; approving a held work
        order requires <strong>manager</strong> or above; injecting scenarios requires
        <strong>engineer</strong> or above.</p>`,
    footer: '<button class="btn btn-danger" data-signout>Sign out</button>',
    onMount(drawer) {
      const current = theme.get();
      drawer.querySelectorAll('[data-mode]').forEach((b) => {
        b.classList.toggle('on', b.dataset.mode === current);
        b.addEventListener('click', () => {
          theme.apply(b.dataset.mode);
          drawer.querySelectorAll('[data-mode]').forEach((x) =>
            x.classList.toggle('on', x === b));
          const btn = app.querySelector('[data-theme]');
          if (btn) btn.innerHTML = icon(theme.isDark() ? 'sun' : 'moon', 18);
        });
      });
      drawer.querySelector('[data-signout]').addEventListener('click', () => {
        closeDrawer();
        state.realtime?.close();
        auth.clear();
        state.copilotHistory.length = 0;
        renderLogin();
      });
    },
  });
}

/* ---------- boot ---------- */
async function boot() {
  renderShell();

  state.realtime = new Realtime(handleRealtime);
  state.realtime.connect();

  try {
    const [alerts, orders, notifications] = await Promise.all([
      api.alerts({ status: 'open' }),
      api.workOrders({ status: 'pending_approval' }),
      api.notifications(true),
    ]);
    state.counts.alerts = alerts.alerts.length;
    state.counts.workorders = orders.work_orders.length;
    state.counts.notifications = notifications.unread;
    updateCounters();
  } catch { /* counters are cosmetic — never block the shell on them */ }

  const { id, param } = routeFromHash();
  await renderRoute(id, param);
}

async function start() {
  if (!auth.token) return renderLogin();
  try {
    const me = await api.me();
    state.user = me.user;
    await boot();
  } catch {
    auth.clear();
    renderLogin();
  }
}

start();
