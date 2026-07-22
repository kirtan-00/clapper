# Clapper landing v3 — "Rendered Cinema" (photography + restrained scroll craft)

**Date:** 2026-07-18 · **Status:** research-approved direction, pre-render.
**Why v1/v2 failed:** CSS cosplaying as photography — the eye isn't fooled. v3 uses
AI-rendered cinematic plates (Higgsfield) with real HTML type/UI composited on top,
and only three restrained scroll techniques. Script Mode is now a mandatory spine beat
(founder called out its absence).

## Technique kit (both researchers converged)
- **2.5D parallax hero** — hero plate cut into 4 depth layers (window-light bg / bed
  mid / C-stand+cables fg / drifting crew silhouette), gentle dolly-push on scroll.
- **Match-cut morph** — bedroom framed as a clip thumbnail → same rectangle becomes the
  clip in a Premiere timeline. The product metaphor as a film cut. Two stills, scale+fade.
- **Clapperboard mask-reveal** — clip-path clapper silhouette wipes between beats
  (GTA-VI move wearing our brand).
- **Scrub sequence: SPARINGLY** — max 6 locked img2img frames on ONE beat (dolly push-in);
  if AI drift shows between frames, collapse to a 2-frame match dissolve. Never scrub
  the whole page. No scroll-jacking.
- **Skip real 3D planes** — parallax wins on ROI; 3D only as micro-tilt on device mock.

## NEVER-RENDER LIST (the anti-AI-look armor — non-negotiable)
1. Readable text (scripts, slates, timecode, UI) — render BLANK surfaces, overlay real
   type in HTML (Courier for screenplay).
2. Faces in focus — crew are backlit out-of-focus silhouettes only.
3. Hands operating the phone — device rendered with dark/blank screen, real Clapper UI
   composited in HTML.
4. Anything needing pixel-identity across frames unless img2img-locked off the master.
8–12 renders max; hero plate rendered FIRST, everything else img2img children of it.

## Look bible (append to every prompt)
"shot on ARRI Alexa, 35mm anamorphic feel, teal-shadow / warm-brass-highlight grade,
soft dawn haze, fine 35mm grain, shallow depth of field, no text, no readable faces,
cinematic, photoreal."
Grade: slate/chalk = cool base; brass = the only warm (motivated by dawn window);
green NEVER in photography except one motivated practical in the wrap shot — UI green
(ROLL/CTA) stays sacred. One LUT across all plates. World duality IS the product:
a warm dawn scene inside a cool night shoot = between the take and the cut.

## Script Mode beat (4 scroll steps; labels byte-identical card→marker)
1. Screenplay page (blank aged paper render #4 + real Courier HTML):
   `INT. BEDROOM — DAWN. She wakes. Reaches for the phone. First sip of cold coffee.`
   3 phrases highlighted. "Feed it the script."
2. Phrases lift off and reflow into beat chips `SHE WAKES · REACHES FOR PHONE ·
   FIRST SIP` (chalk on slate, brass outline). "It becomes cards. Tap a beat as it lands."
3. Set photo (#3), ROLL running, tap flares FIRST SIP brass, tick drops to a scrub bar.
   "You tap. It remembers when."
4. Timeline (#7): same three labels as brass markers at drop-frame TC.
   "Open Premiere. FIRST SIP is already marked."

## Shot list (10 renders, one world: INT. BEDROOM — DAWN on a night soundstage)
1. HERO PLATE 9:16 — dawn bedroom (rumpled bed, window haze, lamp, coffee mug) inside
   darkness; C-stand/flag/cables frame edge, one OOF crew silhouette; 35mm wide low,
   headroom for copy. → parallax (4 layers)
2. SLATE MACRO 9:16/1:1 — wooden clapperboard sticks open, brass hinge, BLANK chalk
   columns; 50mm macro warm rim. → mask reveal + hook
3. THE TAKE 9:16 — over-set angle, bed in focus, phone on stand DARK SCREEN, silhouette
   behind; 40mm dawn key. → tags beat (real UI composited)
4. SCREENPLAY FLATLAY 4:5 — aged BLANK page, set-worn table, coffee ring, pencil,
   raking practical. → Script Mode 1
5. SCENE CARD 1:1 — chalk-white card, slate backing, brass paperclip. → Script Mode 2
6. DOLLY PUSH-IN — 2–6 locked frames off #1, wide→medium bed+mug. → short scrub/dissolve
7. EDIT BAY 9:16 — dark suite, monitor glow, BLANK NLE screen, warm key. → cut + morph target
8. MATCH-CUT SOURCE 16:9 — hero bedroom framed clean as clip thumbnail (comp of #1).
9. MATERIAL TILE — extreme macro brass + chalk dust on slate. → dividers
10. THE WRAP 9:16 — set at end of day, lights lowered, ONE green practical. → CTA bg

## Page in 6 beats
1. HOOK — slate macro full-bleed, green ROLL dot, DF timecode ticking. "You'll shoot 40
   takes today. Your editor gets 40 mystery files." Tap → sticks snap.
2. SET THE WORLD — parallax hero; silhouette drifts. "This is the scene. Around it:
   cables, chaos, a call sheet."
3. THE TAKE — over-set angle, ROLL running, brass tags drop on scroll (GOLD, first sip).
   "Tap ROLL. Tap the moment. Gold means keeper."
4. SCRIPT MODE — the 4-step spine above.
5. THE CUT/ARRIVAL — match-cut morph into the timeline; beats arrive as named brass
   markers at real TC. "Open Premiere. Your takes are named. Your beats are already
   marked."
6. CTA — wrap shot, timecode freezes, the only other green button:
   "Point Clapper at your next take." Sub: free, no login. → /app/

## Constraints carried forward
Phone-first 390 / 100svh / safe areas; no horizontal body scroll; sticky over
scroll-jack; pre-decode image bursts; reduced-motion = graded stills + crossfades
(story survives motionless); brass=tapped moments, green=ROLL+CTA only; DF semicolon
timecode; dry second-person copy; CTA → /app/. Artifact preview = compressed embedded
images; final deploy on clapboard.duckdns.org = real image files, no CSP limit.
Fonts: Bricolage Grotesque + IBM Plex Mono (embedded) + Courier stack for screenplay.

## Render pipeline note
Higgsfield (nano_banana_pro fallback per Kirtan's standing preference). Render #1
first → approve → img2img the children. One LUT pass after.
