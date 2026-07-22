# Clapper landing v4 — "The Editor's Monday"

**Date:** 2026-07-18 · **Status:** approved (Kirtan: #1 + #3's timecode rail as spine).
**Why every prior version failed:** dark + cinematic + dramatic scroll IS the AI look in
2026, and you cannot out-cinema filmmakers. v4 flips it: LIGHT mode, real interfaces,
deadpan honesty. The mind-blow is the product's actual magic in its native habitat —
"one file and every take arrives named with markers."

## Concept
The page IS the editor's desktop, the morning after your shoot. Before/after told
entirely in pixel-faithful interface recreations (Finder, iMessage, Premiere-style
timeline) sitting on a light paper page. A drop-frame timecode rail runs the page's
edge — scrolling the page IS scrubbing the day's one good take; at the end the rail's
tags become the timeline's markers.

## World / look
- Paper ground `#FAF9F6` (warm, not pure white), ink `#17181A`, secondary `#6E6A63`.
- Brass `#B08D57`/`#e3b24a` register for GOLD/markers/rail ticks only; green `#38d178`
  ONLY on the final CTA (and tiny ROLL dot in the app screenshot); Premiere panel is
  the one dark object on the page (real because Premiere IS dark) — the light page /
  dark app-window contrast is exactly how human product pages look.
- Type: Bricolage Grotesque (voice, sentence case, ends with periods) + IBM Plex Mono
  (ALL data: filenames, timecode, tags) + system UI faces inside the interface mocks
  (SF-style stack for Finder/iMessage chrome). No Inter. No icon fonts — draw the few
  needed glyphs as inline SVG hairlines.
- Soft-structuralism materiality: airy floating windows with very diffused ambient
  shadows (no harsh drops), double-bezel window chrome (outer hairline ring + inner
  content), massive whitespace (sections breathe), subtle paper grain ≤3% fixed layer.
- Interface fidelity is the craft bar: macOS window traffic lights, Finder list-view
  column headers (Name / Date Modified / Size), row zebra, iMessage grey bubble with
  tail + timestamp, Premiere-ish dark panel with V1/A1 headers, DF ruler, lavender
  clips, brass pentagon markers, red playhead.

## The spine: timecode rail
Thin fixed mono rail (right edge desktop / top edge mobile if cleaner) running
`00;00;00;00 → 00;00;47;12` (drop-frame semicolons, tabular-nums) mapped to scroll.
Small ticks; four labeled tag ticks pass as you scroll (`alarm stops`, `stretch / wake`,
`FIRST SIP ★` gold, `walk to window`). At the payoff the rail's ticks visually feed the
timeline markers (the rail rotates/hands off — Jhey moment, the ONE flourish). Reduced
motion: rail static at final state.

## Scroll story (6 moments, vertical, no pinning tricks required)
1. **THE FOLDER (hero).** Small dry kicker `MONDAY, 9:04 AM`. A Finder window:
   `SUNDAY_SHOOT` — rows `C0001.MOV … C0043.MOV`, identical sizes, no names. Headline:
   "Forty takes. Zero names." Sub: "Somewhere in here is the film."
2. **THE TEXT.** An iMessage thread, one grey bubble, timestamp 2:14 AM: "take 3 was
   the one. or maybe the one after. the one where she actually laughs". Line: "You've
   sent this text. Or received it."
3. **MONDAY, WITH CLAPPER.** A single file card slides in: `sunday_shoot.xml`
   (Plex Mono, small XML glyph). Line: "Same shoot. One extra file." Beneath, the
   Premiere-style window; as you scroll, the XML 'drops' and the timeline POPULATES
   under your thumb: clips renaming C0007→`SC04_CU_T03` one by one (mono, fast,
   satisfying), brass markers popping onto the ruler at the rail's tag positions,
   GOLD starred. Snap-line flash once. Playhead parks on FIRST SIP. This is the
   mind-blow beat — give it scroll room.
4. **HOW THE NAMES HAPPENED (features, in context).** Three quiet rows, each a small
   real-UI vignette + one line (no grid, no icons):
   - Phone rolling screen screenshot-style mock (green ROLL, tag chips): "Tap ROLL when
     camera rolls. Tap the moment when it happens. Nothing to type."
   - Script Mode micro-demo: three Courier phrases highlight → become chips → the SAME
     labels shown as the markers from beat 3: "Feed it the script. It becomes tappable
     beats. The beats become markers."
   - Export row: `sunday_shoot.xml · shotlog.pdf · takes.csv` in mono: "XML for
     Premiere. PDF for the producer. CSV for you. Works offline. Free."
5. **THE RECEIPT.** Small before/after ledger, two mono columns: Sunday (C0007.MOV ·
   2:14 AM text · 3 hrs of scrubbing) vs Monday (SC04_CU_T03 · FIRST SIP ★ 00;00;36;12
   · open the cut). Dry. No adjectives.
6. **CTA.** Paper, calm: "Your editor deserves Monday off." Button (green pill, the
   page's only green): `GET CLAPPER — FREE` → `/app/`. Mono small print: "No signup to
   log takes. Phone-first. Works offline."

## Motion law (from design-motion-principles, Jakub primary / Emil interfaces / Jhey rail-flip only)
- Scroll-linked population of the timeline (progress-driven, not time-triggered);
  entries elsewhere: gentle fade-up 12px + slight blur→0, 300–500ms,
  cubic-bezier(0.32,0.72,0,1), staggered ≤80ms, once.
- Interfaces behave like real software: instant states, no bouncing windows. Renames
  tick instantly row-by-row as scroll crosses thresholds.
- NO: pulsing/breathing/glow loops, scale(0) entries, bare ease/ease-in-out, parallax
  (none at all in v4), scroll-jack, dark-mode drama.
- prefers-reduced-motion: everything at final state, story fully legible.
- transform/opacity/filter only; IntersectionObserver + one rAF for the rail/timeline;
  no scroll-thrash.

## Copy voice
Dry, concrete, second person, zero SaaS words, headlines end with periods. All
known-good lines above are final unless improved.

## Constraints
Self-contained body fragment (one <style>, markup, one <script>); no external
resources; fonts embedded (reuse Bricolage + Plex Mono base64 blocks); phone-first
390px; 100svh; safe areas; no horizontal scroll; tap targets ≥44px; visible focus;
≤400KB; CTA → /app/. Artifact preview first; ships to clapboard.duckdns.org later.
