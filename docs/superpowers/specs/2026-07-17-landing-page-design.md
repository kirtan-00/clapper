# Clapper landing page — design spec

**Date:** 2026-07-17
**Status:** approved (structural + aesthetic direction), building.
**Owner:** Kirtan (via Claude)

## Purpose

A scroll-animated product landing page for Clapper, posted as the value-first
solution when filmmakers ask about on-set logging / editor-handoff pain on Reddit.
Job: land the wound at the top, show the shoot → script-tags → Premiere-XML-payoff
story, end on the app link. Phone-first (Reddit reads on mobile), scales up clean.

## URL architecture (approved)

- Landing page owns the bare domain: `https://clapboard.duckdns.org/`
- App moves to `https://clapboard.duckdns.org/app/`
- PWA `start_url` and service-worker `scope` move to `/app/`.
- Vite multi-page build: landing `index.html` (own chunk, no app code) + app at `/app/`.
- One `./deploy.sh`, one gh-pages push.
- Known cost: an already-installed home-screen PWA opens the landing once until
  reinstalled from `/app/`. Acceptable now (~0 real users).

## Aesthetic direction

Ground everything in the film set's own world (clapperboard, timecode, slate,
grease-pencil marks, camera reports, the Premiere timeline). Keep Clapper's brand
identity but avoid the AI-default "near-black + single acid-green" look by spending
every free axis on warm film-set materials.

### Palette (named tokens)
- `--slate: #0E0F11` — page ground (deeper than app for richer contrast)
- `--panel: #1b1d20` — cards / slate body
- `--cream: #EFE9DB` — film-leader cream, primary text + the warm signature note
- `--green: #57C282` — brand accent, RESTRAINT: go / ROLL / GOLD / final CTA only
- `--amber: #C8A24B` — grease-pencil / marker olive-amber (matches real Premiere marker tags)
- `--muted: #8A857A` — captions, data labels, eyebrows
- Timeline-artifact-only realism colors: video lavender `#A99BE0`, audio green `#6FCF97`

### Type
- Display: Futura-first stack — `Futura, 'Century Gothic', 'Twentieth Century',
  'Avenir Next', system-ui, sans-serif`. Cinematic, non-AI, degrades gracefully.
  Used big, tight tracking, for the wound headlines and beat titles.
- Technical/data: monospace — `ui-monospace, 'SF Mono', 'JetBrains Mono', Menlo,
  'Cascadia Mono', monospace`. For timecode HUD, camera data, eyebrows, tags,
  clip names. This is the domain signature — timecode is monospace everywhere.
- Body: humanist system stack — `system-ui, -apple-system, 'Segoe UI', Roboto, sans-serif`.
- No embedded webfonts (zero license risk, zero weight, self-contained). Execute
  with precise scale/spacing so system stacks read intentional, not default.

### Signature element
1. **Clap on load** — hero is a real clapperboard slate; the striped clapstick
   snaps down (with a small shake + a flash) on page load. The literal clapper.
2. **Timecode HUD** — a thin drop-frame timecode strip (`00;00;16;00`, semicolons =
   drop-frame, matches the app's real TC util) that advances as you scroll, tying
   every beat to film time.

## Scroll story — 5 beats (approved: tight)

Motion is scroll-position-driven (vanilla JS, rAF + per-section progress, no GSAP,
no CDN). `prefers-reduced-motion` collapses animation to instant states.

1. **THE WOUND (hero, vertical).** Clapperboard claps on load. Headline names the
   pain: *"You shot 40 takes. The editor got a folder of C0007, C0011, C0043 and a
   text at 2am saying take 3 was the good one."* Logo resolves, TC HUD starts, one
   scroll cue. No feature list up top — just the wound.
2. **THE SHOOT (vertical).** A phone tilts up; thumb hits ROLL; takes stack into a
   list as you scroll; tag chips (GOLD / FLUB / PICKUP) fly onto takes. Mirrors the
   real rolling screen. Grease-pencil / handwritten annotation feel.
3. **THE SCRIPT (vertical).** A PDF page slides in, dissolves into scene cards, each
   scene sprouts tappable shot tags (WIDE / MID / CU / OTS + script beats). Shows
   Script Mode without explaining it.
4. **THE PAYOFF (HORIZONTAL scroll — the money beat).** Section pins; a real-looking
   Premiere timeline translates horizontally as you scroll — you scrub through time
   like a playhead. Lavender video track + darker header strip, green audio waveform,
   drop-frame ruler `00;00;16;00`. An XML file drags down and drops: clips snap in
   already named by scene/take, olive GOLD markers land on the ruler. Split contrast:
   *what the editor usually gets* (junk clip names + lonely text) vs *what Clapper
   hands over*. This beat is the whole page — everything else supports it.
5. **THE HAND (vertical).** Everything falls away to one brass/green button:
   **Open Clapper — free, works offline** → `/app/`. Small print: no signup to log takes.

## Copy voice
Tom Scott / concrete-first, second person, dry, punchy, film-set vernacular. No AI
hedging, no em-dash overuse, no "unlock/seamless/effortless" SaaS filler. Active voice;
a button says exactly what happens.

## Premiere timeline reference (from real screenshots — build against these)
- Video clips: lavender `~#A99BE0` body with a darker header strip; clip name in the header.
- Audio: green with a waveform.
- Markers: small olive/amber pentagon tags hanging off the ruler.
- Timecode ruler: drop-frame, semicolons (`00;00;16;00`).
- Track headers on the left: stacked V1–V3 / A1–A4, each with a lock icon + M/S buttons.

## Delivery
- Build as a self-contained body fragment (`<style>` + markup + `<script>`, no
  html/head/body wrapper) so it publishes directly as an Artifact for phone preview
  and slots cleanly into `<body>` of the repo's SEO-laden index.html on ship.
- Preview loop: publish Artifact → Kirtan scrolls on phone → revise → redeploy same URL.
- On approval: becomes landing `index.html`, app moves to `/app/`, PWA start_url +
  scope updated, `./deploy.sh` ships both.
- Quality floor: responsive to mobile, visible keyboard focus, reduced-motion respected,
  no broken links, app link points at `/app/`.

## Build/review split (Kirtan's pattern)
- One Opus subagent builds the full page (single file needs unified art direction).
- One Fable subagent reviews adversarially: AI-slop tells, drop-frame TC correctness,
  real Premiere colors, phone safe-area, broken links, `/app/` link.
