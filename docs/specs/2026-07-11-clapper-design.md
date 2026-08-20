# Clapper — on-set take logger (design spec)

2026-07-11. Approved by the owner in brainstorming session.

## What it is

Phone-first PWA for logging takes on set. Big timer starts on "roll" (voice or button),
timestamped moments get logged while rolling, one tap on CUT closes the take and
increments the camera clip counter. Exports a PDF for the editor, a Premiere-importable
FCP7 XML with markers, and a CSV. Fully offline, installable, no accounts.

## Architecture

- Vite + React + TypeScript. Static PWA (vite-plugin-pwa), deployable to Vercel.
- All data in IndexedDB (idb wrapper). Every entity has a UUID + `updatedAt` so a
  Supabase sync layer can bolt on in v2 without migration.
- No backend. PDF/XML/CSV generated on-device, shared via Web Share API
  (file share), download fallback.

## Data model

```
Project { id, name, fps (23.976|24|25|29.97|30|50|59.94|60), clipPrefix ("C" | "A001_"),
          nextClipNumber, clipPadding, tags: string[] (default FLUB/GOLD/PICKUP/NOISE),
          createdAt, updatedAt }
Slate   { id, projectId, name, order, createdAt, updatedAt }
Take    { id, slateId, projectId, number, clipName, status: 'good'|'discarded',
          startedAt (epoch ms), durationMs, cameraTC?: "HH:MM:SS:FF",
          createdAt, updatedAt }
Moment  { id, takeId, kind: 'point'|'range', atMs, endMs?, label, tag?,
          createdAt, updatedAt }
```

- Take numbers auto-increment per slate. Clip number auto-increments per project on
  every CUT **and** every DISCARD (the camera file exists either way).
- Discarded takes are excluded from exports except a strikethrough appendix in the PDF,
  so clip numbering always maps to what's on the card.
- Moments store ms-into-take. If `cameraTC` is set on the take, exports show a second
  column with true camera TC (cameraTC + offset at project fps, drop-frame aware for
  29.97/59.94).

## Screens

1. **Projects list** — create/open project. Project settings: name, fps, clip prefix +
   starting number + padding, custom tag chips.
2. **Project screen** — slates list, add slate, per-slate take counts, export buttons
   (PDF / Premiere XML / CSV, per project), TC calculator (add/subtract two timecodes
   at project fps).
3. **Rolling screen** (the core) — dark, huge type, one-thumb:
   - Giant elapsed timer. ROLL button flips to CUT while rolling.
   - Voice: Web Speech API listens while screen on; "roll camera" starts, "cut" stops.
     Best-effort (iOS Safari flaky) — button is the contract. Mic toggle visible.
   - While rolling: tag chips (one tap = timestamped point marker, no typing),
     MARK IN → MARK OUT for ranges; label typed or dictated **after** OUT.
   - On CUT: take saved, clip counter bumps, bottom sheet shows take summary with
     optional camera-TC field, optional note, DISCARD button. Next take armed.
   - Wake lock while on this screen. Timer derives from `Date.now() - startedAt`
     (never setInterval accumulation) so background/lock doesn't drift it.

## Exports

1. **PDF** (pdf-lib) — cover: project, date, take/slate counts, total roll time.
   Grouped by slate; per take: take #, clip name, duration, camera TC if set, moments
   (time or range + label + tag). GOLD moments summarized on the cover. Discarded takes
   in a strikethrough appendix.
2. **Premiere XML** — FCP7 xmeml: one sequence per project (or slate) at project fps;
   one clip element per good take named exactly the clip name; markers at moment
   positions (ranges = marker with duration). Editor imports, relinks media, markers
   land on footage.
3. **CSV** — flat: slate, take, clip, status, moment kind, in, out, label, tag,
   clip-relative TC, camera TC.

## Module boundaries (for parallel build)

- `src/types.ts` — entities + all module interfaces. THE contract, written first.
- `src/store/` — IndexedDB persistence, CRUD, counters. Pure async API.
- `src/engine/` — timer hook, wake lock hook, speech recognition wrapper
  (start/stop/keyword events). No UI.
- `src/export/` — `toPdf(project, data)`, `toFcpXml(...)`, `toCsv(...)`,
  `timecode.ts` (fps math incl. drop-frame). Pure functions: data in, Blob out.
- `src/ui/` — screens + components. Consumes the above only through interfaces.

## Non-goals (v1)

- No sync/accounts, no multicam TC jam, no audio recording, no cloud storage.
- Voice is an enhancement, never a dependency.

## Quality bar

Handmade dark UI (not AI-default, no Claude-orange), click-through verified with
Playwright + phone-size screenshots before calling it done. No em dashes in UI copy.
