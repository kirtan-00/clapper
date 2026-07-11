# Clapper

A phone-first PWA for logging shots on set. Start a big timer on "action", tap
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
3. **Roll.** Tap ACTION, or say "action" if the mic is on. The button is the
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

## The three exports

All three are generated on-device and shared via the share sheet on mobile, or
downloaded on desktop.

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

## Known caveats

- **Voice is best-effort, especially on iOS Safari.** The Web Speech API is
  flaky on iPhone. Treat the buttons as the real control and the mic as a
  convenience. Use the mic toggle to turn listening off.
- **Saying "cut" in conversation while rolling will cut the shot.** If the mic
  is on and someone says "cut" or "action" in normal talk, Clapper will act on
  it. Toggle the mic off when you are not driving it by voice.
- **Markers land within about a second.** They are for finding moments, not
  frame-accurate cutting. Use them to jump near the action, then trim precisely
  in your editor.
</content>
</invoke>
