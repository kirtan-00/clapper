#!/usr/bin/env bash
# Applies ONE migration file to Clapper's production database.
#
# It exists because the obvious instruction - "paste the connection URI" -
# turned out to be three ways to get it wrong: paste the prose along with the
# command, paste the example URI with the word REGION still in it, or paste a
# URI whose password is still the literal [YOUR-PASSWORD]. So this asks for
# ONE thing, the password, and builds every other part itself.
#
# Host order is deliberate. Supabase's direct host is IPv6-only on this project
# and fails with "network unreachable" on a v4-only network, so the IPv4
# session pooler is tried first and the direct host is the fallback. The
# pooler's account prefix is postgres.<ref>, not plain postgres.
#
# ON_ERROR_STOP=1 and a single transaction, together: without the first, psql
# plows past a failed statement and still exits 0, which is how a half-applied
# migration gets mistaken for a finished one. Without the second, a failure
# halfway leaves the schema in a state nobody designed.
#
# Usage:
#   ./scripts/apply-migration.sh supabase/migrations/20260826170000_entitlements.sql

set -euo pipefail

FILE="${1:-}"
if [ -z "$FILE" ] || [ ! -f "$FILE" ]; then
  echo "usage: $0 <path-to-migration.sql>" >&2
  exit 2
fi

REF="sqqdivfgdfaztfzrzkhu"
REGION="ap-southeast-2"

printf 'Database password (nothing will appear as you type): '
stty -echo 2>/dev/null || true
IFS= read -r PGPASS
stty echo 2>/dev/null || true
printf '\n'

if [ -z "$PGPASS" ]; then echo "No password entered. Nothing was run." >&2; exit 2; fi
case "$PGPASS" in
  *'[YOUR-PASSWORD]'*|*'PASTE'*|*'PASSWORD'*)
    echo "That looks like the placeholder text, not the password. Reveal it on the" >&2
    echo "database settings page and copy the password only." >&2
    exit 2;;
esac

# URL-encode the password: a password containing @ / : ? or # silently
# truncates or misroutes a connection URI, and Supabase generates those.
ENC=$(PW="$PGPASS" python3 -c 'import os,urllib.parse;print(urllib.parse.quote(os.environ["PW"],safe=""))')

# PORT 6543 FIRST, and this was a real bug the first time round: the pooler
# host is right but 5432 is the SESSION pooler, which is not what this project
# exposes. The Management API's own pooler config names 6543 (transaction
# mode). Asking the API beats guessing - the answer is
# aws-0-ap-southeast-2.pooler.supabase.com:6543, user postgres.<ref>.
#
# 5432 stays as a second attempt because session mode is the better fit for a
# DDL migration where it is available, and the direct host stays last because
# it resolves AAAA only - no A record at all - so it is unreachable from any
# IPv4-only network and fails identically to a wrong password.
CANDIDATES=(
  "postgresql://postgres.${REF}:${ENC}@aws-0-${REGION}.pooler.supabase.com:6543/postgres"
  "postgresql://postgres.${REF}:${ENC}@aws-0-${REGION}.pooler.supabase.com:5432/postgres"
  "postgresql://postgres.${REF}:${ENC}@aws-1-${REGION}.pooler.supabase.com:6543/postgres"
  "postgresql://postgres:${ENC}@db.${REF}.supabase.co:5432/postgres"
)
LABELS=("pooler aws-0 :6543 (transaction)" "pooler aws-0 :5432 (session)" "pooler aws-1 :6543" "direct host :5432 (IPv6 only)")

URI=""
for i in "${!CANDIDATES[@]}"; do
  printf 'Trying %s ... ' "${LABELS[$i]}"
  if psql "${CANDIDATES[$i]}" -Atqc 'select 1' >/dev/null 2>&1; then
    echo "connected."
    URI="${CANDIDATES[$i]}"
    break
  fi
  echo "no."
done

if [ -z "$URI" ]; then
  echo "" >&2
  echo "Could not reach the database on any host. The password is the usual cause;" >&2
  echo "a wrong one fails identically to an unreachable host here. Paste the SQL" >&2
  echo "into the dashboard SQL editor instead - it needs no password at all." >&2
  exit 1
fi

echo ""
echo "Applying $(basename "$FILE") in a single transaction."
psql "$URI" -v ON_ERROR_STOP=1 --single-transaction -f "$FILE"
echo ""
echo "Applied. Verifying the tables actually exist rather than trusting exit 0:"
psql "$URI" -Atc "select table_name from information_schema.tables where table_schema='public' and table_name in ('purchases','project_entitlements') order by 1"
psql "$URI" -Atc "select column_name from information_schema.columns where table_schema='public' and table_name='profiles' and column_name in ('credits','subscription_intro_bonus_granted') order by 1"
