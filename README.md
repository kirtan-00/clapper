# Clapper

A phone-first PWA for logging shots on set. Start a big timer on "roll", tap
tags and mark moments while rolling, hit CUT to close the shot and bump the
camera clip counter. It runs fully offline, installs to the home screen, and
needs no account. When the shoot wraps, it hands the editor three exports.

## What it is

Clapper is a script supervisor's notebook that lives on your phone. Every shot
is timestamped against the wall clock, so if the cameras are jammed to
time-of-day timecode, the log lines up with the footage directly. All data is
stored on-device in IndexedDB. Nothing leaves the phone unless you share an
export.

## On-set flow

1. **At call time, jam the cameras to time-of-day timecode.** This is the one
   habit that makes the wall-clock columns in the exports worth anything. If the
   camera's TC reads the actual time of day, Clapper's log maps straight onto
   the footage.
2. **Set the clip counter to match the camera's next file number.** In project
   settings, set the clip prefix, digits, and starting number so Clapper's
   clip names (for example `C0042`) match what the camera card will show. The
   counter then advances on every CUT and every DISCARD, because a file lands on
   the card either way.
3. **Roll.** Tap ROLL, or say "roll camera" if the mic is on. The button is the
   contract; voice is a best-effort convenience.
4. **Tag and mark while rolling.** Tap a tag chip (FLUB, GOLD, PICKUP, NOISE, or
   your own) to drop a timestamped point marker, no typing. For a range, tap
   MARK IN then MARK OUT, and add a label by typing or dictation after OUT.
5. **CUT.** Tap CUT, or say "cut". The shot is saved, the clip counter bumps,
   and a summary sheet appears with an optional camera-TC field, an optional
   note, and a DISCARD button. The next shot is armed automatically.
6. **DISCARD** a bad shot from the summary sheet. Discarded shots stay out of
   the exports (except a strikethrough appendix in the PDF) but still consume a
   clip number, so the numbering keeps matching the card.

## Camera presets

When you create a project, pick your camera from the **Camera** dropdown and
Clapper prefills the clip prefix, digit count, and any static suffix to match
how that camera actually names its files. You can still edit any field after
picking, and switching cameras re-prefills. Pick **Custom** to number things
your own way.

| Camera | Example clip | Match |
| --- | --- | --- |
| Sony A7 / FX | `C0001` | exact |
| Canon R5 / R6 | `MVI_0001` | approximate |
| Canon Cinema / R5C | `A001C001` | exact |
| Blackmagic Pocket | `A001_*_C001` | approximate |
| RED | `A001_C001_*` | approximate |
| ARRI | `A001C001_*` | approximate |
| DJI Mini / Mavic / Pocket | `DJI_*_0001_D` | approximate |
| DJI classic | `DJI_0001` | exact |
| GoPro | `GX010001` | exact |
| iPhone | `IMG_0001` | approximate |
| Panasonic Lumix | `P1000001` | exact |
| Custom | `C0001` | exact |

**Exact vs approximate.** An **exact** match means Clapper's clip name is
character-for-character what lands on the card, so you can eyeball the log
against the media. An **approximate** match means the camera embeds parts we
cannot know in advance (record-time stamps, dates, random characters) or shares
its file counter with photos so the numbers can skip. The `*` you see in some
examples is a literal wildcard standing in for those unpredictable parts. In
every case the **incrementing clip number is still correct** — match the footage
to the log by that number rather than the whole string.

- **GoPro chapters.** GoPro splits one long shot across several files that keep
  the same number but change the chapter digits: `GX010001`, `GX020001`,
  `GX030001`. Clapper logs the number once (as `GX010001`); the extra `GX02` /
  `GX03` files belong to the same shot.
- **Canon and iPhone share their counter with stills.** Because photos and video
  draw from the same counter, the video numbers can jump. That is expected, not
  a miscount — the number on the file is still the one to match.
- **Bump the reel when you swap cards.** Cinema cameras (Canon Cinema, RED,
  ARRI, Blackmagic) carry the reel in the prefix, for example the `A001` in
  `A001C001`. When you change the card, bump the reel in the clip prefix to
  `A002`, `A003`, and so on, so clip names stay unique across cards.

## The three exports

All three are generated on-device and download directly; share the file from
your Files/Downloads.

- **Premiere XML (FCP7 xmeml).** Import into Premiere, then relink the media to
  the camera files. You get one sequence per project at the project fps, one
  clip per good shot named exactly as its clip name, and a marker at every
  moment (ranges become markers with a duration). The markers land on the
  footage so you can jump straight to the good bits.
- **CSV.** A flat row per shot and per moment: scene, shot, clip, status, kind,
  tag, label, clip-relative in/out times and timecode, camera in/out timecode,
  and `wall_in` / `wall_out` wall-clock columns. The wall-clock columns are
  local time-of-day timecode at the project fps and line up with cameras jammed
  to time-of-day TC. Open it in any spreadsheet to sort, filter, or pull GOLD
  moments.
- **PDF.** A printable editor report: a cover with project stats and a GOLD
  moments summary, shots grouped by scene in a ruled table with duration, camera
  TC, wall clock, and moments, and a discarded-shots appendix. This is the
  human-readable version to skim or print for the edit bay.

## Development

```
npm install     # install dependencies
npm run dev      # local dev server
npm run build    # type-check and produce the production PWA in dist/
```

Regenerate the PWA icons (needs the installed Playwright Chromium):

```
node scripts/make-icons.mjs
```

## Single-file offline build

There is a second build that bundles the entire app — every script, style, and
icon inlined — into ONE file, `clapper.html`, with no network requests ever.

```
npm run build:single    # produces dist-single/clapper.html
```

That single file is the whole app. Send it over WhatsApp, AirDrop, email, or
drop it in the Files app, then tap to open it on any phone — no install, no
server, no account. It runs the same as the hosted PWA, including the timer,
tags, and all three exports. It even works opened straight from `file://` or
inside a sandboxed in-app webview.

- **Storage.** Data lives in that browser's storage for the file. The app tries
  IndexedDB first and silently falls back to `localStorage` if IndexedDB is
  blocked (as it can be on `file://` or in a private window). Clearing the
  browser's site data, or opening the file in a different browser, starts fresh
  — so hand off your exports at wrap. Nothing ever leaves the phone.
- **Exports.** All three exports work from the single file; they download
  directly to the device — share the file from your Files/Downloads. **PDF is
  the guaranteed export** here — it is the printable editor report and the one to
  rely on.

## Known caveats

- **Voice is best-effort, especially on iOS Safari.** The Web Speech API is
  flaky on iPhone. Treat the buttons as the real control and the mic as a
  convenience. Use the mic toggle to turn listening off.
- **Saying "cut" in conversation while rolling will cut the shot.** If the mic
  is on and someone says "cut" or "roll" in normal talk, Clapper will act on
  it. Toggle the mic off when you are not driving it by voice.
- **Markers land within about a second.** They are for finding moments, not
  frame-accurate cutting. Use them to jump near the action, then trim precisely
  in your editor.
