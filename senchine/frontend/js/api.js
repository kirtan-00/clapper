/* API client — one place that knows about auth, errors and the wire format. */

const TOKEN_KEY = 'senchine.token';
const USER_KEY = 'senchine.user';

export const auth = {
  get token() { return localStorage.getItem(TOKEN_KEY); },
  get user() {
    try { return JSON.parse(localStorage.getItem(USER_KEY) || 'null'); }
    catch { return null; }
  },
  set(token, user) {
    localStorage.setItem(TOKEN_KEY, token);
    localStorage.setItem(USER_KEY, JSON.stringify(user));
  },
  clear() {
    localStorage.removeItem(TOKEN_KEY);
    localStorage.removeItem(USER_KEY);
  },
};

export class ApiError extends Error {
  constructor(message, status) {
    super(message);
    this.status = status;
  }
}

async function request(path, { method = 'GET', body, auth: needsAuth = true } = {}) {
  const headers = { 'Content-Type': 'application/json' };
  if (needsAuth && auth.token) headers.Authorization = `Bearer ${auth.token}`;

  let response;
  try {
    response = await fetch(path, {
      method,
      headers,
      body: body === undefined ? undefined : JSON.stringify(body),
    });
  } catch {
    throw new ApiError('Cannot reach the Senchine server.', 0);
  }

  if (response.status === 401 && needsAuth) {
    auth.clear();
    window.dispatchEvent(new CustomEvent('senchine:signed-out'));
    throw new ApiError('Your session expired. Please sign in again.', 401);
  }

  const text = await response.text();
  let payload = null;
  if (text) {
    try { payload = JSON.parse(text); } catch { payload = { detail: text }; }
  }

  if (!response.ok) {
    const detail = payload?.detail;
    const message = Array.isArray(detail)
      ? detail.map((d) => d.msg || String(d)).join('; ')
      : detail || `Request failed (${response.status})`;
    throw new ApiError(message, response.status);
  }
  return payload;
}

export const api = {
  // auth
  login: (email, password) =>
    request('/api/auth/login', { method: 'POST', body: { email, password }, auth: false }),
  register: (payload) =>
    request('/api/auth/register', { method: 'POST', body: payload, auth: false }),
  demoAccounts: () => request('/api/auth/demo-accounts', { auth: false }),
  me: () => request('/api/auth/me'),

  // fleet
  fleet: (params = {}) => {
    const qs = new URLSearchParams(
      Object.entries(params).filter(([, v]) => v !== undefined && v !== null && v !== '')
    ).toString();
    return request(`/api/fleet${qs ? `?${qs}` : ''}`);
  },
  plants: () => request('/api/plants'),
  machine: (id) => request(`/api/machines/${id}`),
  analyze: (id) => request(`/api/machines/${id}/analyze`, { method: 'POST' }),
  fusion: (id) => request(`/api/machines/${id}/fusion`),
  detectability: (id) => request(`/api/machines/${id}/detectability`),
  sensorReadings: (id, limit = 120) => request(`/api/sensors/${id}/readings?limit=${limit}`),

  // workflow
  alerts: (params = {}) => {
    const qs = new URLSearchParams(
      Object.entries(params).filter(([, v]) => v !== undefined && v !== null && v !== '')
    ).toString();
    return request(`/api/alerts${qs ? `?${qs}` : ''}`);
  },
  acknowledgeAlert: (id, note = '') =>
    request(`/api/alerts/${id}/acknowledge`, { method: 'POST', body: { note } }),
  resolveAlert: (id, note = '') =>
    request(`/api/alerts/${id}/resolve`, { method: 'POST', body: { note } }),

  workOrders: (params = {}) => {
    const qs = new URLSearchParams(
      Object.entries(params).filter(([, v]) => v !== undefined && v !== null && v !== '')
    ).toString();
    return request(`/api/work-orders${qs ? `?${qs}` : ''}`);
  },
  approveWorkOrder: (id) => request(`/api/work-orders/${id}/approve`, { method: 'POST' }),
  rejectWorkOrder: (id, note) =>
    request(`/api/work-orders/${id}/reject`, { method: 'POST', body: { note } }),
  updateWorkOrder: (id, patch) =>
    request(`/api/work-orders/${id}`, { method: 'PATCH', body: patch }),
  technicians: () => request('/api/technicians'),

  notifications: (unreadOnly = false) =>
    request(`/api/notifications?unread_only=${unreadOnly}`),
  markRead: (id) => request(`/api/notifications/${id}/read`, { method: 'POST' }),
  markAllRead: () => request('/api/notifications/read-all', { method: 'POST' }),

  feedback: (payload) => request('/api/feedback', { method: 'POST', body: payload }),
  feedbackSummary: () => request('/api/feedback/summary'),

  // insights
  ask: (question, machineId = null) =>
    request('/api/copilot/ask', { method: 'POST', body: { question, machine_id: machineId } }),
  suggestions: () => request('/api/copilot/suggestions'),
  overview: () => request('/api/analytics/overview'),
  trends: (hours = 6) => request(`/api/analytics/trends?hours=${hours}`),
  industries: () => request('/api/analytics/industries'),
  agents: () => request('/api/agents'),
  models: () => request('/api/models'),
  audit: () => request('/api/audit'),

  // simulation
  scenarios: () => request('/api/sim/scenarios'),
  inject: (payload) => request('/api/sim/inject', { method: 'POST', body: payload }),
  clearFault: (machineId) => request(`/api/sim/clear/${machineId}`, { method: 'POST' }),
  failSensor: (payload) => request('/api/sim/sensor-fault', { method: 'POST', body: payload }),
  pausePipeline: (paused) => request(`/api/sim/pause?paused=${paused}`, { method: 'POST' }),
  simState: () => request('/api/sim/state'),
};

/* ---------- realtime ---------- */
export class Realtime {
  constructor(onMessage) {
    this.onMessage = onMessage;
    this.socket = null;
    this.retries = 0;
    this.closed = false;
    this.connected = false;
  }

  connect() {
    if (!auth.token) return;
    this.closed = false;
    const scheme = location.protocol === 'https:' ? 'wss' : 'ws';
    this.socket = new WebSocket(
      `${scheme}://${location.host}/ws?token=${encodeURIComponent(auth.token)}`
    );

    this.socket.onopen = () => {
      this.retries = 0;
      this.connected = true;
      window.dispatchEvent(new CustomEvent('senchine:ws', { detail: { connected: true } }));
    };
    this.socket.onmessage = (event) => {
      try { this.onMessage(JSON.parse(event.data)); } catch { /* ignore malformed frame */ }
    };
    this.socket.onclose = () => {
      this.connected = false;
      window.dispatchEvent(new CustomEvent('senchine:ws', { detail: { connected: false } }));
      if (this.closed) return;
      // Exponential backoff, capped — a reconnect storm helps nobody.
      const delay = Math.min(1000 * 2 ** this.retries++, 15000);
      setTimeout(() => this.connect(), delay);
    };
    this.socket.onerror = () => this.socket?.close();
  }

  send(payload) {
    if (this.socket?.readyState === WebSocket.OPEN) {
      this.socket.send(JSON.stringify(payload));
    }
  }

  subscribe(topic) { this.send({ action: 'subscribe', topic }); }
  unsubscribe(topic) { this.send({ action: 'unsubscribe', topic }); }

  close() {
    this.closed = true;
    this.socket?.close();
  }
}
