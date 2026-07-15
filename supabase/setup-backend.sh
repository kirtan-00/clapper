#!/usr/bin/env bash
set -euo pipefail
# ---------------------------------------------------------------------------
# Backend setup for Clapper (accounts + quotas + abuse protection), on YOUR own
# Supabase project "clapper" (ref sqqdivfgdfaztfzrzkhu). Re-runnable.
#
#     export SUPABASE_ACCESS_TOKEN=sbp_...   # your Supabase personal access token
#     bash "supabase/setup-backend.sh"
#
# It (1) applies the accounts/quotas migration (idempotent), (2) sets the edge
# secrets (GROQ_API_KEY, TURNSTILE_SECRET, IP_PEPPER), and (3) deploys the
# breakdown + export-gate edge functions.
#
# Prereqs you do ONCE in the dashboards (see docs/specs + the go-live notes):
#   - Google OAuth provider enabled in Supabase Auth (client id/secret).
#   - Supabase Auth URL config: Site URL + Redirect URLs for /clapper/.
#   - A Cloudflare Turnstile widget -> its SECRET goes in TURNSTILE_SECRET below.
# Until a real TURNSTILE_SECRET is set, the function falls back to Cloudflare's
# dev/test secret (all tokens pass) so nothing is blocked while you wire it up.
# ---------------------------------------------------------------------------

REF=sqqdivfgdfaztfzrzkhu
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
: "${SUPABASE_ACCESS_TOKEN:?export SUPABASE_ACCESS_TOKEN=sbp_... first}"
API="https://api.supabase.com/v1/projects/$REF"
AUTH=(-H "Authorization: Bearer $SUPABASE_ACCESS_TOKEN" -H "Content-Type: application/json")

# --- secrets (env overrides; else Bill-Please creds; TURNSTILE falls back to dev) ---
BP="$HOME/Desktop/claude/claude projects/Bill-Please/.secrets/credentials.env"
GROQ_API_KEY="${GROQ_API_KEY:-$(grep '^GROQ_API_KEY=' "$BP" 2>/dev/null | sed 's/^GROQ_API_KEY=//' | tr -d "\"' ")}"
: "${GROQ_API_KEY:?Could not find GROQ_API_KEY — export it and re-run}"
# Cloudflare dev/test secret: every token validates. Replace by exporting the real one.
TURNSTILE_SECRET="${TURNSTILE_SECRET:-1x0000000000000000000000000000000AA}"
# Stable pepper for hashing client IPs (privacy: raw IPs are never stored).
IP_PEPPER="${IP_PEPPER:-clapper-$REF}"

echo "1/3  Applying accounts/quotas migration…"
MIGRATION="$ROOT/supabase/migrations/20260715120000_accounts_quotas.sql"
[ -f "$MIGRATION" ] || { echo "  ! migration file missing: $MIGRATION"; exit 1; }
jq -Rs '{query: .}' "$MIGRATION" | curl -s -X POST "$API/database/query" "${AUTH[@]}" --data @- \
  -w '\n     [HTTP %{http_code}]\n'

echo "2/3  Setting edge secrets (GROQ_API_KEY, TURNSTILE_SECRET, IP_PEPPER)…"
[ "$TURNSTILE_SECRET" = "1x0000000000000000000000000000000AA" ] && \
  echo "     ! TURNSTILE_SECRET not set — using Cloudflare DEV secret (all tokens pass). Set the real one before launch."
curl -s -o /dev/null -X POST "$API/secrets" "${AUTH[@]}" \
  -d "[{\"name\":\"GROQ_API_KEY\",\"value\":\"$GROQ_API_KEY\"},{\"name\":\"TURNSTILE_SECRET\",\"value\":\"$TURNSTILE_SECRET\"},{\"name\":\"IP_PEPPER\",\"value\":\"$IP_PEPPER\"}]" \
  -w '     [HTTP %{http_code}]\n'

echo "3/3  Deploying edge functions (breakdown, export-gate)…"
cd "$ROOT"
# --no-verify-jwt: the functions verify the user themselves via getUser() and
# need to answer the browser's CORS preflight, so the gateway JWT gate is off.
npx --yes supabase@latest functions deploy breakdown   --project-ref "$REF" --no-verify-jwt
npx --yes supabase@latest functions deploy export-gate --project-ref "$REF" --no-verify-jwt

echo
echo "Done. Sign in with Google, then try Script Mode: https://kirtan-00.github.io/clapper/"
