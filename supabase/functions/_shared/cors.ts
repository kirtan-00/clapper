// Shared CORS helper for Clapper edge functions. Origins locked to the gh-pages
// app plus local dev. Imported by breakdown and export-gate.

export const ALLOWED_ORIGINS = [
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
