#!/usr/bin/env bash
# Deploy Clapper to GitHub Pages, served at https://clapboard.duckdns.org
# Layout: landing page at /, app (PWA) at /app/
# Usage: ./deploy.sh
set -euo pipefail
cd "$(dirname "$0")"

if [ ! -f landing/fragment.html ]; then
  echo "ERROR: landing/fragment.html missing (the landing page body). Aborting." >&2
  exit 1
fi

# 1. Build the app under /app/ (vite-plugin-pwa derives manifest scope/start_url from base)
npx vite build --base=/app/

# 2. Assemble the site: landing at root, app build in /app/
STAGE=dist-site
rm -rf "$STAGE"
mkdir -p "$STAGE/app"
cp -R dist/. "$STAGE/app/"

# Shared assets also live at the domain root (favicons, og image, robots, sitemap)
for f in favicon.svg favicon-32.png apple-touch-icon.png icon-192.png icon-512.png og.png robots.txt sitemap.xml llms.txt; do
  cp "public/$f" "$STAGE/"
done

# Landing page: head wrapper + body fragment + closing tags
cat landing/head.html landing/fragment.html landing/tail.html > "$STAGE/index.html"

# Free SEO template pages (self-contained HTML + downloadable PDFs) at /templates/<slug>/
if [ -d landing/templates ]; then
  mkdir -p "$STAGE/templates"
  cp -R landing/templates/. "$STAGE/templates/"
fi

# Relink: the standalone XML path-rewriter at /relink/. Self-contained, no build
# step, and deliberately no analytics beacon - it is handed to editors who load a
# client's shot log into it, and the page's own promise is that nothing leaves the
# machine. A tracking pixel would make that sentence a lie.
if [ -d landing/relink ]; then
  mkdir -p "$STAGE/relink"
  cp -R landing/relink/. "$STAGE/relink/"
fi

# Legal: Privacy Policy + Terms + cookie/storage notice at /legal/,
# with /privacy and /terms as canonical redirect entry points.
for d in legal privacy terms; do
  if [ -d "landing/$d" ]; then
    mkdir -p "$STAGE/$d"
    cp -R "landing/$d/." "$STAGE/$d/"
  fi
done

# Self-destructing service worker at the old root scope, so pre-landing PWA installs
# (which registered /sw.js with scope /) clear their caches instead of serving the
# cached app shell over the new landing page.
cp landing/sw-selfdestruct.js "$STAGE/sw.js"

touch "$STAGE/.nojekyll"
printf 'clapboard.duckdns.org\n' > "$STAGE/CNAME"

# 2b. Meta Pixel. The HTML sources carry the placeholder __META_PIXEL_ID__ wrapped in
# <!-- META-PIXEL-START --> ... <!-- META-PIXEL-END --> sentinels. Here we either bake the
# real ID in, or remove the whole block so no pixel ships. The real ID never lives in git.
if [ -n "${META_PIXEL_ID:-}" ]; then
  export META_PIXEL_ID
  find "$STAGE" -type f -name '*.html' -exec \
    perl -0777 -i -pe 's/__META_PIXEL_ID__/$ENV{META_PIXEL_ID}/g' {} +
  echo "meta pixel: baked ID into $STAGE (all .html)"
else
  find "$STAGE" -type f -name '*.html' -exec \
    perl -0777 -i -pe 's/[ \t]*<!-- META-PIXEL-START -->.*?<!-- META-PIXEL-END -->[ \t]*\r?\n?//gs' {} +
  echo "WARNING: META_PIXEL_ID is unset or empty - Meta Pixel block stripped, no pixel will ship."
fi

# 3. Push as orphan gh-pages
cd "$STAGE"
git init -q
git checkout -qb gh-pages
git add -A
git commit -qm "deploy: landing + app $(git -C .. rev-parse --short HEAD 2>/dev/null || echo local)"
git push -qf "https://github.com/kirtan-00/clapper.git" gh-pages
cd ..
rm -rf "$STAGE/.git"
echo "live: https://clapboard.duckdns.org/ (landing) and https://clapboard.duckdns.org/app/ (app)"
