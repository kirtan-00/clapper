// Cloudflare Turnstile, Managed mode, invisible + execute-on-demand.
//
// We lazily inject the Turnstile script once, render a single hidden invisible
// widget, and hand back a FRESH single-use token each time a gated (Script Mode)
// call is about to hit the server. The server re-verifies the token (siteverify +
// hostname), so a token is only ever good for one request.

const SCRIPT_SRC =
  'https://challenges.cloudflare.com/turnstile/v0/api.js?render=explicit';

// Public site key. Falls back to Cloudflare's "always passes" dev key.
const SITE_KEY =
  import.meta.env.VITE_TURNSTILE_SITE_KEY || '1x00000000000000000000AA';

const READY_TIMEOUT_MS = 10_000;
const EXECUTE_TIMEOUT_MS = 20_000;

interface TurnstileRenderParams {
  sitekey: string;
  callback?: (token: string) => void;
  'error-callback'?: (code?: string) => void;
  'timeout-callback'?: () => void;
  'expired-callback'?: () => void;
  execution?: 'render' | 'execute';
  appearance?: 'always' | 'execute' | 'interaction-only';
  size?: 'normal' | 'compact' | 'flexible' | 'invisible';
}

interface TurnstileApi {
  render(container: string | HTMLElement, params: TurnstileRenderParams): string;
  execute(container: string | HTMLElement, params?: TurnstileRenderParams): void;
  reset(widgetId?: string): void;
  remove(widgetId?: string): void;
}

declare global {
  interface Window {
    turnstile?: TurnstileApi;
  }
}

let scriptInjected = false;
let widgetId: string | null = null;
let container: HTMLElement | null = null;

// One in-flight token request at a time; render/error callbacks resolve it.
let pending: {
  resolve: (token: string) => void;
  reject: (err: Error) => void;
} | null = null;

function settleError(message: string): void {
  const p = pending;
  pending = null;
  p?.reject(new Error(message));
}

function settleToken(token: string): void {
  const p = pending;
  pending = null;
  p?.resolve(token);
}

/** Inject the Turnstile script once and resolve when `window.turnstile` exists. */
function loadScript(): Promise<TurnstileApi> {
  return new Promise((resolve, reject) => {
    if (window.turnstile) {
      resolve(window.turnstile);
      return;
    }
    if (!scriptInjected) {
      scriptInjected = true;
      const s = document.createElement('script');
      s.src = SCRIPT_SRC;
      s.async = true;
      s.defer = true;
      s.onerror = () => reject(new Error('Turnstile failed to load.'));
      document.head.appendChild(s);
    }
    // Poll for readiness — the script may load after this promise is created.
    const started = Date.now();
    const id = window.setInterval(() => {
      if (window.turnstile) {
        window.clearInterval(id);
        resolve(window.turnstile);
      } else if (Date.now() - started > READY_TIMEOUT_MS) {
        window.clearInterval(id);
        reject(new Error('Turnstile took too long to load.'));
      }
    }, 100);
  });
}

/** Ensure the single hidden invisible widget exists; returns its id. */
function ensureWidget(api: TurnstileApi): string {
  if (widgetId !== null) return widgetId;

  container = document.createElement('div');
  container.style.position = 'fixed';
  container.style.left = '-9999px';
  container.style.top = '-9999px';
  container.style.width = '0';
  container.style.height = '0';
  container.setAttribute('aria-hidden', 'true');
  document.body.appendChild(container);

  widgetId = api.render(container, {
    sitekey: SITE_KEY,
    execution: 'execute',
    appearance: 'execute',
    size: 'invisible',
    callback: (token: string) => settleToken(token),
    'error-callback': () => {
      settleError('Verification failed. Please try again.');
    },
    'timeout-callback': () => {
      settleError('Verification timed out. Please try again.');
    },
    'expired-callback': () => {
      settleError('Verification expired. Please try again.');
    },
  });

  return widgetId;
}

/**
 * Resolve a fresh, single-use Turnstile token. Call immediately before each
 * Script Mode request. Rejects on load/render/challenge error or timeout.
 */
export async function getTurnstileToken(): Promise<string> {
  if (pending) {
    throw new Error('A verification is already in progress.');
  }

  const api = await loadScript();
  const id = ensureWidget(api);

  return new Promise<string>((resolve, reject) => {
    const timeout = window.setTimeout(() => {
      settleError('Verification timed out. Please try again.');
    }, EXECUTE_TIMEOUT_MS);

    pending = {
      resolve: (token) => {
        window.clearTimeout(timeout);
        resolve(token);
      },
      reject: (err) => {
        window.clearTimeout(timeout);
        reject(err);
      },
    };

    try {
      // Fresh token every call: clear any prior token, then trigger the challenge.
      api.reset(id);
      api.execute(id, { sitekey: SITE_KEY });
    } catch {
      settleError('Could not start verification. Please try again.');
    }
  });
}
