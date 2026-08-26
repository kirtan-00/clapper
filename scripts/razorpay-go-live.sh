#!/usr/bin/env bash
# Swaps Clapper's Razorpay credentials from TEST to LIVE.
#
# THIS IS THE LAST STEP, NOT AN EARLY ONE. It must run only after a test-card
# purchase has been observed granting a credit end to end, because after it
# runs the next person through the flow is paying real money into a code path
# that has, until then, only ever handled fake cards.
#
# The webhook secret does NOT change. Razorpay shares one webhook secret
# across test and live, and the endpoint registered in the dashboard is
# already an api-live webhook, so nothing about signature verification moves
# when this runs.
#
# Reversible: run with `test` to swap back.
#   ./scripts/razorpay-go-live.sh live
#   ./scripts/razorpay-go-live.sh test

set -euo pipefail
MODE="${1:-}"
case "$MODE" in live|test) ;; *) echo "usage: $0 live|test" >&2; exit 2;; esac

REF="sqqdivfgdfaztfzrzkhu"
export SUPABASE_ACCESS_TOKEN=$(grep -m1 "sbp_" credentials.md | grep -oE "sbp_[a-zA-Z0-9]+")

if [ "$MODE" = "live" ]; then
  KID=$(grep -m1 "^RAZORPAY_LIVE_KEY_ID="     credentials.md | cut -d= -f2)
  KSEC=$(grep -m1 "^RAZORPAY_LIVE_KEY_SECRET=" credentials.md | cut -d= -f2)
else
  KID=$(grep -m1 "^RAZORPAY_KEY_ID="     credentials.md | cut -d= -f2)
  KSEC=$(grep -m1 "^RAZORPAY_KEY_SECRET=" credentials.md | cut -d= -f2)
fi
[ -n "$KID" ] && [ -n "$KSEC" ] || { echo "Keys for mode $MODE not found in credentials.md" >&2; exit 1; }

# Confirm the keys work BEFORE installing them. Creating an order charges
# nobody; it just proves the credentials authenticate. Installing a dead key
# would take payments offline with no obvious symptom.
echo "Checking $MODE keys against api.razorpay.com ..."
CHECK=$(curl -s -u "$KID:$KSEC" -X POST https://api.razorpay.com/v1/orders \
  -H "Content-Type: application/json" \
  -d '{"amount":100,"currency":"INR","receipt":"clapper_keycheck"}')
echo "$CHECK" | grep -q '"status":"created"' || { echo "Key check FAILED:"; echo "$CHECK" | head -c 300; exit 1; }
echo "Keys authenticate."

npx supabase@latest secrets set "RAZORPAY_KEY_ID=$KID" "RAZORPAY_KEY_SECRET=$KSEC" --project-ref "$REF" >/dev/null
echo "Installed $MODE credentials."
echo ""
echo "Edge functions cache secrets per instance. Redeploy so they pick these up:"
echo "  npx supabase@latest functions deploy razorpay-order razorpay-verify razorpay-webhook --project-ref $REF"
