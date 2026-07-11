#!/usr/bin/env bash
# Deploy Clapper to the sportified droplet at /clapper/.
# Usage: ./deploy.sh
set -euo pipefail
cd "$(dirname "$0")"

npx vite build --base=/clapper/
ssh sportified "mkdir -p /var/www/clapper"
scp -rq dist/* sportified:/var/www/clapper/
echo "live: https://sportified.thedeepdivemarketing.com/clapper/"
