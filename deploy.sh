#!/usr/bin/env bash
# Deploy Clapper to GitHub Pages: https://kirtan-00.github.io/clapper/
# Usage: ./deploy.sh
set -euo pipefail
cd "$(dirname "$0")"

npx vite build --base=/clapper/
touch dist/.nojekyll
cd dist
git init -q
git checkout -qb gh-pages
git add -A
git commit -qm "deploy: clapper $(git -C .. rev-parse --short HEAD)"
git push -qf "https://github.com/kirtan-00/clapper.git" gh-pages
cd ..
rm -rf dist/.git
echo "live: https://kirtan-00.github.io/clapper/"
