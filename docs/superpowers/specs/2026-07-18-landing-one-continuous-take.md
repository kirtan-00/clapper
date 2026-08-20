# Clapper landing v2 — "One Continuous Take"

**Date:** 2026-07-18 · **Status:** approved direction (the owner picked Lane 1) · **Supersedes** the 5-beat page (2026-07-17 spec) as the creative direction; URL architecture and delivery mechanics from that spec still stand (landing at `/`, app at `/app/`, body-fragment artifact→repo flow).

## The concept in one line
The page is a night shoot you scroll through; the scroll is the dolly; at "CUT." the
shot you were standing in becomes a clip in the editor's daylight timeline — with the
beats you tapped arriving as the markers.

## Governing test
Pause the page anywhere, screenshot it: it must read as a still from a film about this
film set. If it reads "website," re-light the frame.

## Structure: one pinned stage (~700vh), no sections
Content never "arrives on scroll" — the world changes state. Hold–move–hold pacing:
pinned moves get ~20% dead hold, ~60% move, ~20% resolved hold.

### The scroll score
1. **0–8% · Cold open (THE HOOK).** No logo, no nav, no headline. Slate night. A green
   ROLL pill at thumb height (~60vw), hairline chalk ring, `SC 12 · TK 4` in mono above,
   frozen timecode `00;00;00;00` top-right (drop-frame semicolons). Line under it, after
   0.8s: **"Go on. Roll."** Ring breathes (scale 1→1.015 over 3s). Four elements total.
   INTERACTIVE: tapping ROLL starts the take (green floods ring 120ms, timecode runs,
   status chip `SC 12 · TK 4 · ROLLING` + red record dot pins top). Escape hatch:
   any scroll before tapping counts as the tap — nobody is stranded.
2. **8–14% · Inside the shot.** Full-bleed set world: blue-black night, one tungsten
   light cone from above frame, silhouettes (C-stand, boom dipping once, tripod legs,
   director's chair). 3 parallax depth layers (bg silhouettes pre-blurred, mid cone+bokeh,
   fg sharp) — the ONLY parallax on the page. Screenplay caption bottom-left:
   `INT. BEDROOM — MORNING`. The phone (flat-on, in a hand silhouette, lit by the cone —
   never floating/tilted) rises into the lower third showing the running Clapper UI.
3. **14–52% · The take: four beats, four taps.** No character animation ever — beats are
   light + screenplay captions only:
   - 22–28%: cool blue dims → caption `alarm stops` → chip `WIDE` taps → brass tick #1
     pins to the BOTTOM EDGE of the viewport.
   - 28–36%: cone widens/warms → `stretch, wake` → chip `CU` taps → tick #2.
   - 36–46%: steam curl over a cup, warm flare → `first sip` → **GOLD** taps (brass
     flash, screen rim glow) → tick #3 is a filled brass pentagon, slightly larger.
   - 46–52%: window shape brightens → `walk to window` → chip `BEAT` taps → tick #4.
   The frame's bottom edge is secretly the marker lane. Chips are genuinely tappable
   (extra taps add extra ticks); the four scripted beats fire on scroll regardless.
4. **52–58% · CUT (the pause).** Caption `CUT.` Set light drops flat. 1px chalk hairline
   draws around the whole viewport — the frame becomes an object. Phone lowers away;
   its red record dot DETACHES and floats. Then a full 3% of scroll animates NOTHING.
5. **58–72% · The crux: hard cut + contraction.** ONE FRAME, no fade: page flips to the
   editor's daylight world — chalk paper `#F2EFE7`, near-black type `#14171B`, grain
   drops to 2%. (The scroll IS an edit; the page performs the product.) In that daylight
   world the bordered night-frame — still playing its night scene inside — SHRINKS
   toward center, corners rounding, cross-tinting lavender at the end, the four brass
   ticks riding its bottom edge the whole way. Filename types on (the page's only
   type-on): `S12_T04_CU_GOLD`. A Premiere-style timeline (light UI) sits below:
   ruler, `V1 / A1` headers with lock + M/S.
6. **72–80% · The dock.** Clip descends into V1; 1px white snap-line flash at the
   in-point. On contact the ticks pop 2px up and resolve as brass pentagon markers
   under the ruler with chalk labels: `alarm stops · stretch · FIRST SIP ★ · window`.
   Green audio waveform draws in A1 (Premiere realism). The floating red dot slides to
   the GOLD marker and STRETCHES into the red playhead — parks on *first sip*. It never
   scrubs.
7. **80–86% · Every take, one settle.** Timeline scales to ~85%; the day's other takes
   cascade into V1 named (`S12_T01_WIDE`, `S12_T02_WIDE`, `S12_T03_CU`) in one motion.
   Small program monitor top-right: static bright-window frame (same scene — proof).
   One line: `One XML. Every take named. Every moment marked.`
8. **86–100% · CTA in daylight.** Timeline dims to 30% as backdrop. Headline (large,
   sentence case, ends with a period): **`Shot to sequence.`** Sub: `Tap on set. Drop
   one file in Premiere.` One pill button — exact shape+green of ROLL: `GET CLAPPER — FREE`
   → `/app/`. Small mono print: `No signup to log takes. PDF, CSV, Premiere XML.`
   No footer grid, no second CTA.

### Only two travelers
The frame (→ clip) and the red dot (→ playhead). Everything else is born and dies in
its own world. The slate never returns; the phone leaves and stays gone.

## Art direction system
**Night grade:** base `#0B0E12`, lifted `#12161C`; pure #000 only inside cone shadows.
**Chalk text** `#E8E4DA` (never #FFF), secondary `#9BA1A8`. **Tungsten** `#FFB45C` /
hot `#FFD9A0` (cones, warmth). **Moon fill** `#7FA8C9` / `#33506B` (the 20 of 80/20).
**Brass `#e3b24a`** = tapped moments only: ticks, GOLD, markers, slate hinge hairlines.
(App-brand brass wins over the palette-doc's `#B08D57`.) **Green `#38d178`** = exactly
twice: ROLL and CTA (brand law; plus Premiere-realism audio waveform inside the
timeline only). **Red `#E5484D`** = one dot → playhead; nothing else red.
**Daylight world:** paper `#F2EFE7`, ink `#14171B`, lavender clip `#A99BE0` w/ darker
header, timeline chrome light-grey Premiere-ish.

**Light cones:** one per scene max; SVG polygon gradient, opacity 8–12%, screen blend,
radial-mask edges (no filter:blur), source above frame. **Bokeh:** 5–7 discs max,
40–120px, radial-gradient paint, 5–15% opacity, edges only, never behind text.
**DOF:** three pre-blurred planes; foreground text/UI always pixel-sharp; runtime blur
≤2 elements ≤24px, never mid-animation; backdrop-filter ≤1 or zero. **Grain:** 256px
canvas noise tile, overlay blend, 3–5% dark / 2–3% light, 3 tiles cycled at ≤8fps,
static under reduced-motion (it also dithers gradient banding on OLED).

**Type (Bricolage = director's voice; Plex Mono = set paperwork; never swap jobs):**
Display XL Bricolage 800: 52px/0.98 @390 → 116px/0.95 @1280, −0.03em, sentence case,
ends with a period. Display L 700: 38→72px. Deck 500: 20→27px. Body 400: 17→19px,
≤58ch. Mono kicker 500 12–13px +0.08em CAPS. Mono data-large 500 tabular 22→34px.
CTA Plex 600 14px +0.06em CAPS. No 300 weight. Bricolage never in caps. Mono only for
timecode/slate data/filenames/kickers/buttons. Max two type sizes per frame, adjacent
sizes ≥2.5x apart.

**Motion:** scroll-scrubbed only (zero time-triggered entrances; ROLL-tap feedback +
1.6s clap-equivalents exempt as direct responses). One ease family
`cubic-bezier(0.22,1,0.36,1)`; 600–900ms-equivalent scroll spans for big moves; no
bounce. One type-on (filename), one flash (snap-line).

**Forbidden:** two-hue gradients; glassmorphism cards; glow box-shadows; 3×2 feature
grid; centered orb-bloom hero; floating tilted phone with reflection; animated conic
borders; logo strips/testimonials/star ratings; "seamless/supercharge/revolutionize/
it's that simple/in seconds", exclamation marks, all emoji; AOS fade-up cards; elastic
eases; uniform 16px radius; lens flares + sprocket borders + countdown leaders; chalk/
handwriting fonts; pure #000/#FFF; cursor spotlights.

## Constraints & delivery (unchanged mechanics)
Self-contained body fragment (one `<style>`, markup, one `<script>`; no doctype/html/
head/body). Strict CSP: no external anything, no libraries — CSS/SVG/canvas + vanilla
JS single-rAF scroll loop. Reuse the ALREADY-EMBEDDED fonts (Bricolage Grotesque var
200–800 + IBM Plex Mono 400/500/600 base64 @font-faces from the current index.html).
Phone-first 390px; 100svh; safe areas; no horizontal body scroll ever; tap targets
≥44px; visible focus; ≤400KB total; 60fps on a 2022 mid-ranger; transform/opacity only
in the scroll loop; IntersectionObserver sleeps offstage scenes.

**Reduced motion:** comic-strip degrade — static composed stills stacked vertically:
(1) night set + phone + four edge ticks, (2) the lavender clip w/ filename + markers,
(3) daylight timeline w/ parked playhead + CTA. The hard cut still cuts (it was never
motion). Grain static. Everything legible, nothing mid-animation.

**Timecode:** drop-frame semicolons `00;00;16;00`, 29.97 DF, tabular-nums, in-world
(phone + top-right data), no fixed HUD strip in this version.

**CTA:** `/app/`. Voice: dry, concrete, second person; headlines end with a period.

## Feature text (the owner: "showing features with text required wherever")
The story carries the pitch, but the product must be EXPLAINED in text at the right
moments — short mono kicker + one chalk line each, one idea per frame, never a grid:
- In the shot (beat 3): `VOICE TRIGGER` — "Say 'roll'. Hands stay on the camera."
- After a tap: `NOTHING TO TYPE` — "Tap the beat. Clapper stamps the timecode."
- At CUT: `CLIP NUMBERS` — "It counted the camera files too. C0007 has a name now."
- In the editor world (dock): `ONE XML` — "Takes named. Markers placed. Premiere relinks
  by filename."
- Near CTA: `ALSO` — "PDF shot log. CSV. Works offline in a basement. Free."
Each appears/holds with its scroll range; copy voice rules apply.

## Hover + cursor (the owner's ask; desktop only, touch never depends on it)
- **Cursor moment:** replace the cursor with a small chalk **viewfinder ring** (12px,
  1px hairline, tiny center dot; mix-blend-difference so it reads on night and daylight).
  It trails position with a 120ms weighted follow (single rAF, transform-only). Over
  interactives it becomes **magnetic**: snaps to and gently pulls ROLL/chips/CTA
  (translate ≤6px), the ring expands to wrap the target as corner brackets — a focus
  mark, not a spotlight — with a 10px mono micro-label beneath (`ROLL` / `TAG` / `OPEN`).
  Native cursor hidden only while the follower is live. Hidden entirely on touch/coarse
  pointers, under reduced-motion, and it never blocks hit-testing (pointer-events:none).
- **Hovers (each ≤200ms, transform/opacity only, one ease family):** chips lift 2px +
  brass hairline brightens (GOLD flashes brass fill); timeline clips reveal Premiere
  trim-bracket ends + a mono tooltip of take meta (`S12_T04 · CU · GOLD · 00;00;36;12`);
  markers grow 1.2x showing their beat label; ROLL/CTA ring-glow via border color (no
  box-shadow glow) + magnetic pull; the docked clip nudges 1px against the snap-line.
  No cursor-spotlight-on-card effects — the forbidden list still applies; this cursor
  is a viewfinder, not a flashlight.
