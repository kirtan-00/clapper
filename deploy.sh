#!/usr/bin/env bash
# Deploy Clapper to GitHub Pages, served at the custom domain https://clapboard.duckdns.org
# Usage: ./deploy.sh
set -euo pipefail
cd "$(dirname "$0")"

npx vite build --base=/
touch dist/.nojekyll
# Custom domain marker for GitHub Pages (also copied from public/CNAME).
printf 'clapboard.duckdns.org\n' > dist/CNAME
cd dist
git init -q
git checkout -qb gh-pages
git add -A
git commit -qm "deploy: clapper $(git -C .. rev-parse --short HEAD)"
git push -qf "https://github.com/kirtan-00/clapper.git" gh-pages
cd ..
rm -rf dist/.git
echo "live: https://kirtan-00.github.io/clapper/"
