#!/usr/bin/env bash
set -euo pipefail
# ---------------------------------------------------------------------------
# One-time backend setup for Clapper Script Mode, on YOUR own Supabase project
# "clapper" (ref sqqdivfgdfaztfzrzkhu). Run it once, from anywhere:
#
#     export SUPABASE_ACCESS_TOKEN=sbp_...        # your Supabase access token
#     bash "supabase/setup-backend.sh"
#
# It (1) creates the leads table, (2) sets the GROQ_API_KEY secret, and
# (3) deploys the breakdown edge function. The Groq key is read from your
# Bill-Please creds automatically, or export GROQ_API_KEY yourself.
# ---------------------------------------------------------------------------

REF=sqqdivfgdfaztfzrzkhu
: "${SUPABASE_ACCESS_TOKEN:?export SUPABASE_ACCESS_TOKEN=sbp_... first}"

GROQ_API_KEY="${GROQ_API_KEY:-$(grep '^GROQ_API_KEY=' "$HOME/Desktop/claude/claude projects/Bill-Please/.secrets/credentials.env" 2>/dev/null | sed 's/^GROQ_API_KEY=//' | tr -d "\"' ")}"
: "${GROQ_API_KEY:?Could not find GROQ_API_KEY — export it and re-run}"

echo "1/3  Creating leads table…"
curl -s -X POST "https://api.supabase.com/v1/projects/$REF/database/query" \
  -H "Authorization: Bearer $SUPABASE_ACCESS_TOKEN" -H "Content-Type: application/json" \
  -d '{"query":"create table if not exists public.leads (id uuid primary key default gen_random_uuid(), email text not null, scenes_count int, doc_name text, user_agent text, created_at timestamptz default now()); alter table public.leads enable row level security;"}' \
  -w '\n     [HTTP %{http_code}]\n'

echo "2/3  Setting GROQ_API_KEY secret…"
curl -s -o /dev/null -X POST "https://api.supabase.com/v1/projects/$REF/secrets" \
  -H "Authorization: Bearer $SUPABASE_ACCESS_TOKEN" -H "Content-Type: application/json" \
  -d "[{\"name\":\"GROQ_API_KEY\",\"value\":\"$GROQ_API_KEY\"}]" \
  -w '     [HTTP %{http_code}]\n'

echo "3/3  Deploying breakdown edge function…"
cd "$(cd "$(dirname "$0")/.." && pwd)"
npx --yes supabase@latest functions deploy breakdown --project-ref "$REF" --no-verify-jwt

echo
echo "Done. Test by uploading a PDF in Script Mode: https://kirtan-00.github.io/clapper/"
