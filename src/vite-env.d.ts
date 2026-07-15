/// <reference types="vite/client" />

interface ImportMetaEnv {
  /** Cloudflare Turnstile public site key. Falls back to the dev key when unset. */
  readonly VITE_TURNSTILE_SITE_KEY?: string;
}

interface ImportMeta {
  readonly env: ImportMetaEnv;
}
