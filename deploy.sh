#!/usr/bin/env bash
# Deploy Clapper to GitHub Pages, served at https://clapper.in
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

# Articles at /articles/<slug>/. Same shape as templates above: self-contained
# HTML, no build step. Added when the first articles were written - without
# this step they sit in the repo and never reach the site, which is a silent
# failure (the deploy succeeds, the pages just are not there).
if [ -d landing/articles ]; then
  mkdir -p "$STAGE/articles"
  cp -R landing/articles/. "$STAGE/articles/"
fi

# Relink: the standalone XML path-rewriter at /relink/. Self-contained, no build
# step, and deliberately no analytics beacon - it is handed to editors who load a
# client's shot log into it, and the page's own promise is that nothing leaves the
# machine. A tracking pixel would make that sentence a lie.
if [ -d landing/relink ]; then
  mkdir -p "$STAGE/relink"
  cp -R landing/relink/. "$STAGE/relink/"
fi

# Admin: password-gated (server-side, by Postgres) analytics dashboard at
# /admin/. Self-contained, no build step, same pattern as relink above. The
# gate is public.admins + admin_analytics_summary() in Supabase, not
# anything in this file - see supabase/migrations/20260824090000_admin_analytics.sql.
# No numbers are baked in here; the page ships only the code that asks for
# data, and robots.txt/meta noindex keep it out of search, but the real gate
# is server-side and holds even if this path is guessed or crawled.
if [ -d landing/admin ]; then
  mkdir -p "$STAGE/admin"
  cp -R landing/admin/. "$STAGE/admin/"
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
printf 'clapper.in\n' > "$STAGE/CNAME"

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

# 2c. Google Analytics 4, injected here rather than written into the HTML
# sources. Two reasons, and the second is the important one:
#
#   1. Pages are authored by several hands (landing, templates, articles). A
#      snippet that has to be pasted into every new page is a snippet that
#      will be missing from the next one somebody adds. Injecting at deploy
#      time means every page is covered, including ones not written yet.
#   2. It is NOT behind an env var like META_PIXEL_ID above, on purpose. A
#      GA4 Measurement ID is public by definition - it ships in the source of
#      every page it runs on, so hiding it buys nothing. And an unset env var
#      fails SILENTLY: see the Meta Pixel's own "WARNING: ... no pixel will
#      ship" line, which is exactly what would happen to analytics on every
#      deploy from a shell that had not exported it. Analytics that quietly
#      is not running is worse than no analytics, because you trust the zero.
#
# THREE PATHS ARE DELIBERATELY EXCLUDED:
#   /app/     the PWA has its own first-party analytics (src/net/analytics.ts)
#             writing to Supabase. GA here would double-count every session
#             and add a third-party request to an app whose whole point is
#             working offline on a set with bad wifi.
#   /admin/   the private dashboard. It is gated by Postgres, not obscurity,
#             but there is no reason to send its page views to Google.
#   /relink/  READ THE COMMENT ON THE relink COPY STEP ABOVE BEFORE CHANGING
#             THIS. That page promises editors that a client's shot log never
#             leaves their machine. A tracking tag would make that sentence a
#             lie. This exclusion is a promise, not a preference.
GA4_ID="G-RMLDR8GENF"
cat > "$STAGE/.ga-snippet.html" <<GAEOF
<!-- Google tag (gtag.js) -->
<script async src="https://www.googletagmanager.com/gtag/js?id=${GA4_ID}"></script>
<script>
  window.dataLayer = window.dataLayer || [];
  function gtag(){dataLayer.push(arguments);}
  gtag('js', new Date());
  gtag('config', '${GA4_ID}');
</script>
GAEOF

GA_INJECTED=0
while IFS= read -r page; do
  case "$page" in
    "$STAGE"/app/*|"$STAGE"/admin/*|"$STAGE"/relink/*) continue ;;
  esac
  # Insert before the FIRST </head>. Skip a page that somehow already carries
  # the tag, so a re-run cannot double-fire every pageview.
  if grep -q "$GA4_ID" "$page"; then continue; fi
  GA_SNIPPET_FILE="$STAGE/.ga-snippet.html" perl -0777 -i -pe '
    BEGIN { local $/; open my $fh, "<", $ENV{GA_SNIPPET_FILE} or die; our $snip = <$fh>; close $fh; }
    s{</head>}{$main::snip</head>}i unless $done++;
  ' "$page" && GA_INJECTED=$((GA_INJECTED + 1))
done < <(find "$STAGE" -type f -name '*.html')
rm -f "$STAGE/.ga-snippet.html"
echo "GA4 $GA4_ID: injected into $GA_INJECTED page(s) (app/, admin/, relink/ excluded by design)"

# Fail loudly rather than shipping a site with no analytics and no warning.
if [ "$GA_INJECTED" -eq 0 ]; then
  echo "ERROR: GA4 was injected into ZERO pages. Something is wrong with the stage. Aborting." >&2
  exit 1
fi

# 2d. The first-party landing beacon (landing/beacon.html), injected exactly
# the way GA4 is above and for exactly the same reason - read that comment
# first, it explains why a hand-pasted snippet is the wrong shape.
#
# What went wrong when this WAS hand-pasted, which is the whole argument:
#   - The nine pages under /articles/ never got it. That is the entire SEO
#     surface, the pages most likely to be a stranger's first contact with
#     Clapper, and on 25 Aug 2026 the path breakdown read 272 views on `/`
#     and a flat ZERO on every guide. Not "low traffic" - no instrument.
#   - The five /templates/ pages each carried their own copy, and those copies
#     had already drifted: they sent `landing_view` but never
#     `landing_cta_click`, so a template could not tell "nobody scrolled" from
#     "everybody scrolled and left".
# One file, injected everywhere, and a page added next month is covered on the
# day it ships rather than whenever somebody notices.
#
# SAME THREE EXCLUSIONS AS GA4, and /relink/ is the one that matters: that page
# promises editors a client's shot log never leaves their machine. Any beacon
# on it makes that sentence a lie. This exclusion is a promise, not a
# preference. /app/ has its own first-party analytics (src/net/analytics.ts)
# and would double-count; /admin/ is the private dashboard.
BEACON_MARK="clapper-landing-beacon-v2"
BEACON_INJECTED=0
while IFS= read -r page; do
  case "$page" in
    "$STAGE"/app/*|"$STAGE"/admin/*|"$STAGE"/relink/*) continue ;;
  esac
  # Skip a page that somehow already carries it, so a re-run cannot double-fire
  # every pageview - the same guard GA4 uses.
  if grep -q "$BEACON_MARK" "$page"; then continue; fi
  BEACON_FILE="landing/beacon.html" perl -0777 -i -pe '
    BEGIN { local $/; open my $fh, "<", $ENV{BEACON_FILE} or die; our $snip = <$fh>; close $fh; }
    s{</body>}{$main::snip</body>}i unless $done++;
  ' "$page" && BEACON_INJECTED=$((BEACON_INJECTED + 1))
done < <(find "$STAGE" -type f -name '*.html')
echo "landing beacon: injected into $BEACON_INJECTED page(s) (app/, admin/, relink/ excluded by design)"

# Fail loudly rather than shipping a site that silently measures nothing. A
# zero here reads as "quiet week" forever after, which is worse than an error.
if [ "$BEACON_INJECTED" -eq 0 ]; then
  echo "ERROR: the landing beacon was injected into ZERO pages. Aborting." >&2
  exit 1
fi

# /relink/ must never carry either tag. Assert it rather than trust the case
# statement above, because this is a promise made in writing to users.
if [ -d "$STAGE/relink" ]; then
  if grep -rql "$BEACON_MARK\|$GA4_ID" "$STAGE/relink" 2>/dev/null; then
    echo "ERROR: a tracking tag reached /relink/, which promises no tracking. Aborting." >&2
    exit 1
  fi
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
echo "live: https://clapper.in/ (landing) and https://clapper.in/app/ (app)"
