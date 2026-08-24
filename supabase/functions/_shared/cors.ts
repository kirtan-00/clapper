// Shared CORS helper for Clapper edge functions. Origins locked to the gh-pages
// app plus local dev. Imported by breakdown and export-gate.

// clapper.in first: index 0 is the fallback returned when an origin is not on
// the list, so it should be the canonical home rather than the old host.
//
// clapboard.duckdns.org STAYS. An installed PWA keeps the origin it was added
// from, so pre-move installs keep calling these functions from the old host;
// removing it here would break Script Mode and every export for exactly the
// people who have been using Clapper longest. Retire it only once the old
// origin is genuinely dead.
//
// THESE ARE EDGE FUNCTIONS. Editing this file changes nothing in production
// until `breakdown` and `export-gate` are redeployed to Supabase - a deploy.sh
// run does NOT touch them.
export const ALLOWED_ORIGINS = [
  "https://clapper.in",
  "https://www.clapper.in",
  "https://clapboard.duckdns.org",
  "https://kirtan-00.github.io",
  "http://localhost:5173",
  "http://localhost:4173",
];

export function cors(origin: string | null): Record<string, string> {
  const allow = origin && ALLOWED_ORIGINS.includes(origin) ? origin : ALLOWED_ORIGINS[0];
  return {
    "Access-Control-Allow-Origin": allow,
    "Access-Control-Allow-Methods": "POST, OPTIONS",
    "Access-Control-Allow-Headers": "content-type, authorization, apikey, x-client-info",
    "Vary": "Origin",
  };
}
