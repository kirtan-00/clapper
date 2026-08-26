# Clapper - Product Hunt relaunch creative asset list

Live product: https://clapper.in (app at `/app/`). Demo link only in every asset below, never the source repo.

Grounded against the real app: `src/ui/HomeScreen.tsx`, `RollingScreen.tsx`, `ProjectScreen.tsx`, `ProjectsScreen.tsx`, `ClipLogScreen.tsx`, `ShotDeck.tsx`, `SettingsScreen.tsx`, `AccountScreen.tsx`, `StudioSheet.tsx`/`StudioRow.tsx`, `NewProjectSheet.tsx`, and rendered output already sitting in `.shots/` and `.shots-studio/`. Everything proposed below is either a screen that exists today or a real-world photo of the phone in use. Nothing here requires a screen that hasn't been built.

Visual identity is locked and not revisited in this doc: acid yellow `#e6ff2b` accent, pale green `#e2f0cc` day ground / true black night ground, flat buttons (no gradients, no drop shadows, no 3D), the clapperboard mark (black slate body, cream diagonal stripes, acid-yellow open-lens ring - see `public/icon-512.png`).

---

## 1. Product Hunt gallery set (6 assets)

Product Hunt's gallery crops to roughly **1270 x 760px** (about 5:3) for the thumbnail that represents the whole listing, and displays the rest at the same ratio in the post gallery. Build all six at **1270 x 760px, PNG**, phone screenshot centered in a plain flat device outline (no glossy bezel render, no drop shadow - matches the "flat, no 3D" rule), on the app's own pale green day ground, not a designed background. Reserve the top ~25% of the canvas for a one-line headline set in the app's own type; never crop the phone screen itself.

Order below is gallery order, slot 1 is the thumbnail (also covered in depth in section 2).

### Asset 1 - Hero / thumbnail: the live multi-cam take
- **Dimensions:** 1270 x 760px, PNG.
- **In frame:** the Rolling screen mid-take, multi-camera: `A + B + C + SOUND · ROLLING · 24 FPS`, all four unit cards showing `REC 0:01`, the tag pad (`WIDE`, `CU`, `OTS` chips + two key-moment labels), the `GOLD` pill lit, and the full-width red `CUT` bar at the bottom. This is a real, seen state - `.shots/rollfix/assert.day.multi.rolling.844.png` is this exact frame.
- **Screen:** RollingScreen, multi-cam state.
- **Headline baked in:** "Tap CUT. Not a notebook." in the reserved top band.
- **Cost:** the screenshot itself is free - `scripts/shoot-roll.mjs` already renders this exact state (`multi`, day theme) at phone size. New work is only the compositing pass (device outline + headline band), roughly an hour.

### Asset 2 - Crash recovery: "Take recovered"
- **Dimensions:** 1270 x 760px, PNG.
- **In frame:** the recovery sheet over a dimmed Home screen: **"Take recovered"**, body copy **"You were rolling C0001. Started 8s ago."**, a disclosure row **"STILL ROLLING - TAKE 1 CARRIES ON"**, and two buttons, `Discard` (red) and `Cut it now` (dark teal). This is a real captured state, `.shots/rollrecovery/02-recovery-prompt.png`.
- **Screen:** the crash-recovery prompt (`RollRecovery.tsx`), reached after the app is killed mid-take and reopened.
- **Headline baked in:** "Phone dies mid-take. The take doesn't."
- **Cost:** `scripts/roll-recovery-check.mjs` already exists in `scripts/` and produces this exact PNG (it isn't one of the six named harnesses in the brief but it's already there and already does the job) - zero new capture work, only the same compositing pass as Asset 1.

### Asset 3 - Script Mode: PDF screenplay to shot list
- **Dimensions:** 1270 x 760px, PNG.
- **In frame:** the Shots (breakdown) screen - scenes and shots grouped in the on-device hierarchy, the same one `scripts/shoot-screens.mjs` captures as `day.03-shots.png`, seeded from a real parsed shot list (`No Mans Hero`, 24fps project, in the script's own seed data).
- **Screen:** `ShotsScreen.tsx` / the shots breakdown reached from Project.
- **Headline baked in:** "Upload the screenplay. Get a shot list."
- **Cost:** free - `scripts/shoot-screens.mjs` already produces this frame in both themes. Compositing pass only.

### Asset 4 - Multi-camera, named crew
- **Dimensions:** 1270 x 760px, PNG.
- **In frame:** the New Project camera stage mid-setup: four camera units (A through D) each with an `Operator` field filled in (real placeholders used in the app's own copy: `e.g. Rohan`), plus the sound stage with a recorder field (`e.g. MixPre-6`) and its own operator (`e.g. Priya`). Sells "multi-camera with named operators" with the app's real onboarding wording, not an invented mock.
- **Screen:** `NewProjectSheet.tsx`, camera + sound stages.
- **Headline baked in:** "Four cameras. One crew. One log."
- **Cost:** free - `scripts/shoot-newproject.mjs`'s own "FOUR CAMERAS AND SOUND" walk builds and shoots exactly this setup (named operators, camera B/C/D added, a recorder) end to end, in both themes. Compositing pass only.

### Asset 5 - Your production house, on every export
- **Dimensions:** 1270 x 760px, PNG.
- **In frame:** the "Who's shooting?" sheet - title **"Who's shooting?"**, body **"Your production house goes on every PDF and CSV you export. You can change it any time in Settings."**, fields **Your name** and **Production house** (placeholders `e.g. Kirtan` / `e.g. Fourside Studio`), `Save` and `Not now` buttons. This is a real captured state, `.shots-studio/light-sheet.png`.
- **Screen:** `StudioSheet.tsx`, reached both as the one-time prompt and again from the Settings "Production house" row.
- **Headline baked in:** "Your name goes out with every file."
- **Cost:** free - `scripts/shoot-studio.mjs` already renders this sheet, plus the Settings row in set/unset states, in both themes. Compositing pass only.

### Asset 6 - The clip log: nothing gets lost
- **Dimensions:** 1270 x 760px, PNG.
- **In frame:** the Clip Log screen, full chronological list of takes with auto-numbered clip names, statuses and the disclosure-row correction pattern (tap a row, it opens into Move / Edit / the destructive action on its own line). This is what an editor never has to reverse-engineer from a paper log.
- **Screen:** `ClipLogScreen.tsx`.
- **Headline baked in:** "Every clip. Numbered. Findable."
- **Cost:** free - `scripts/shoot-screens.mjs` already captures this as `day.07-cliplog.png` / `night.07-cliplog.png`. Compositing pass only.

**Total new-capture cost across all 6:** zero. Every screenshot already exists or is one script run away. The only real work is the compositing pass (device outline, headline band, export at 1270x760) - call it 4-6 hours for all six done well, less if templated after the first.

---

## 2. The hero / thumbnail, in depth

This is the single highest-leverage asset in the whole set - it's what shows in the daily/weekly PH feed before anyone clicks in, and most launches waste it on a logo on a gradient. Three concepts:

**Concept A - Real hand, real set, real screen.** A photo of an actual hand holding the phone on an actual set, mid-tap on the `CUT` bar, the Rolling screen live behind the thumb (multi-cam state, same content as Asset 1 above), with gear (a C-stand, a monitor, a slate) softly out of focus behind it. Headline overlaid in the reserved band, same as the rest of the gallery set for consistency. The point isn't the phone, it's proof this thing exists in a hand on an actual shoot, not just in Figma. Composition has to survive a small thumbnail crop: phone fills 55-65% of the frame, held close to flat-on to camera, screen readably bright.

**Concept B - Screenshot-only, zero new photography.** The same Rolling screen multi-cam frame from Asset 1, in a flat device outline on the pale green ground, no photography involved at all - everything already rendered by `scripts/shoot-roll.mjs`. Fast, guaranteed-legible at thumbnail size, completely safe, but reads like every other dev-tool PH launch: a screenshot in a frame.

**Concept C - Before/after split.** Left half a photo of a messy handwritten continuity log or paper sides packet (the thing Clapper replaces), right half the Rolling screen live. Direct visual argument for "no more deciphering handwriting," but needs a genuinely messy, genuinely real paper log to shoot (not a prop), or it reads as staged, which is worse than not making the point at all.

**Recommendation: Concept A.** The product's whole pitch is that it survives contact with a real set - offline, one-handed, thumb-reachable at 5am with a slate in the other hand. A clean screenshot (Concept B) proves the UI is nice; it doesn't prove any of that. Concept A does, and it's the one asset in this whole brief where "authentic photography over stock" actually changes what the image argues, not just how it looks. It also directly sets up the demo video's opening beat and reuses the same photography session as the IG/story assets in section 4, so it isn't a one-off cost. Fall back to Concept B only if the photo session in section 5 doesn't happen before the launch date - it's a safe, zero-risk substitute, not a compromise on message, just a smaller one.

---

## 3. Demo video (30-45s, silent-readable)

Muted-first: every beat needs on-screen text carrying it, sound is a bonus. Opens on the actual on-set problem, not the logo - the logo only shows up at the very end.

| Timecode | On screen | On-screen text |
|---|---|---|
| 0:00-0:03 | Real photo/video (from section 5): a messy handwritten continuity log, pen mid-scribble, on an actual set | "Still logging takes by hand?" |
| 0:03-0:06 | Cut to phone: Home screen, thumb taps the "New roll" hero button | "Clapper." |
| 0:06-0:09 | Mode picker sheet opens (Director mode / Podcast mode), thumb taps Director mode | "Upload a shot list PDF" |
| 0:09-0:14 | New Project camera stage: Camera B, C, D added one tap at a time, operator names typed in, sound recorder added | "Multi-camera. Named crew." |
| 0:14-0:19 | Rolling screen: big ROLL tap, all units (A+B+C+SOUND) lock into ROLLING together, timer counting up | "One tap rolls every camera." |
| 0:19-0:24 | Same screen: thumb taps the GOLD chip mid-take, then MARK IN → MARK OUT with a typed label | "Tag the good stuff live." |
| 0:24-0:28 | Thumb taps CUT. Clip number visibly bumps, C0001 to C0002, camera clip cards reset to REC 0:00 | "CUT. It numbers itself." |
| 0:28-0:32 | Crash recovery beat: app force-quit mid-take, reopened, "Take recovered - you were rolling C0001" sheet appears | "Phone dies mid-take? Nothing's lost." |
| 0:32-0:36 | Clip Log screen scrolling through a full day's takes, one row opened to correct a clip number | "Full log. Fix anything, after." |
| 0:36-0:41 | Export sheet: the four tiles (PDF "Print and hand round on set.", Premiere "Timeline, XML.", Resolve "Timeline, FCPXML.", CSV "Spreadsheet."), thumb taps PDF | "Wrap. Export to your editor." |
| 0:41-0:43 | PDF cover page render, the production house name visible under the project title | "Your production house, on every page." |
| 0:43-0:45 | End card: the clapperboard mark, wordmark "Clapper," acid-yellow underline, on true black | "clapper.in - free to try" |

Everything after 0:41 needs one piece of new work not covered by an existing script: a rendered sample PDF page (run `exporter.pdf()` on a seeded project via a short one-off script, screenshot page 1). Everything before that is stitched entirely from existing screenshot-harness output plus the section 5 photography.

---

## 4. Supporting social assets, launch day

**Instagram feed post - 1080 x 1350px (4:5).** The Asset 1 hero composition (or the real-photo hero from section 2 if it's ready), recropped taller, headline "Tap CUT. Not a notebook." at top, mark bottom-right, pale green ground.

**Instagram story - 1080 x 1920px.** Full-bleed vertical phone screenshot of the Rolling screen in the true black night theme (the app's own night ground, not a treatment applied after the fact), headline in the top third, bottom third left clear for the link sticker on launch day.

**X/Twitter card - 1200 x 675px (16:9).** Split composition: left third is the mark plus a two-line headline ("Log every take. Wrap with a real shot log.") on true black, right two-thirds is the Asset 1 multi-cam screenshot, no device outline needed at this size.

**LinkedIn image - 1200 x 627px.** Pitched at producers and production companies rather than crew: the Asset 5 "Who's shooting?" / production-house screen, headline "Your production house, on every export the editor gets." LinkedIn's audience here skews toward the people who'd actually license or recommend the tool to a crew, not the person holding the slate.

---

## 5. What to photograph for real

The single most persuasive asset available is a real phone, in a real hand, on a real set, and CrayWingz shoots often enough that this is a realistic ask rather than a wish list. One session covers the hero (section 2), the demo video's live-action beats (section 3), and the IG story (section 4).

1. **Hand holding the phone, Rolling screen live, multi-cam.** Practical/available set light (not a softbox on white seamless - that reads as stock). Gear visibly out of focus behind the phone: a C-stand, a monitor cart, a slate. Phone held close to flat toward camera, screen brightness cranked so it reads in-camera. Thumb mid-press on the `CUT` bar or a tag chip. Shoot both portrait (for the gallery/social crops) and a couple of landscape safety frames.
2. **Over-the-shoulder at a monitor cart:** phone lying flat beside an actual paper sides/continuity packet, both in frame, the contrast doing the work without a caption. This is the raw material for Concept C in section 2 and the video's opening beat - needs a genuinely messy, real paper log, not a staged one.
3. **Phone in motion:** walking across a set holding the phone, background in motion blur, phone and screen sharp. Handheld, natural walking pace, no gimbal needed. Feeds the IG story and reel cutaways.
4. **Macro close-up on the thumb pressing CUT**, screen visible but slightly out of focus behind the thumb, shallow depth of field. This is a strong standalone story frame and a good video insert at the 0:24 beat.
5. **Wide crew/set shot** with the phone visible in someone's hand alongside a director's monitor, for context and credibility - this is the one aimed at the LinkedIn audience, proof it's actually in use on a real production, not a solo indie toy.
6. **Night version of shot 1**, on an actual night shoot if one is on the calendar before launch, to show the true-black night theme in its natural habitat rather than just as a toggle in Settings.

Shoot on whatever CrayWingz production is next on the calendar - no need to schedule a dedicated session if a real shoot day is already booked.

---

## 6. Priority order

| Asset | Why it matters | Effort | Blocks launch? |
|---|---|---|---|
| Hero/thumbnail (Concept B, screenshot-only) | Every PH visitor sees this first; safest guaranteed version | 1 hr | Yes - ship this if nothing else is ready |
| Gallery assets 2-6 (compositing only, all screenshots already exist) | Fills out the gallery, each proves a different real claim | 4-5 hrs total | Yes, but can launch with as few as 3 (hero + 2) if short on time |
| Photo session (section 5) | Upgrades the hero to Concept A, feeds the video and IG story | 2-3 hrs on an already-scheduled shoot day | No - upgrades what's already shippable |
| Hero/thumbnail (Concept A, with real photo) | The actual recommended hero, once the photo exists | 2 hrs compositing on top of the shoot | No, but do it if the photo session happens before launch |
| PDF sample render (for asset 5/video) | One new script run, small but not yet automated | 1 hr | No |
| Demo video | Strong conversion asset, but PH does not require a video to launch | 6-10 hrs (stitching, captions, real B-roll edit) | No |
| IG feed + story | Launch-day amplification | 1-2 hrs | No |
| X card | Launch-day amplification | 30 min | No |
| LinkedIn image | Launch-day amplification, smaller audience overlap | 30 min | No |

**If there are only two days:** cut the demo video first, it's the single most expensive item and PH does not require one. Ship the hero (Concept B if the photo session hasn't happened, Concept A if it has) plus 3-4 of the 6 gallery assets, in this order: hero, multi-cam setup, crash recovery, production-house branding - those three make the strongest distinct claims (works on a real multi-cam set, survives a crash, brands the editor handoff). Script Mode and the clip log are the two to drop first if time runs out; they're real features but the weakest thumbnail-sized story of the six. Social assets are cheap enough to do same-day at launch and don't need to be pre-built.
