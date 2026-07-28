# Shots inside scenes — design

Date: 2026-07-28
Status: approved, in build

## The problem

Clapper's hierarchy is Project → Scene → Take. Real production is
Project → Scene → **Shot** → Take. A scene is one location+time; a shot is one
setup inside it (`5.31`, MCU, push in); a take is one roll of that setup.

Two consequences today:

1. A 47-shot scene collapses into one undifferentiated pile of takes. The
   operator cannot tell which setups are covered and which are not.
2. The app **calls a take a "shot"** — the PDF prints `Shot 3` for take 3, the
   CSV has a `shot` column holding take numbers, and the UI says "First shot of
   this scene". That word is needed for the real thing.

## Source of truth: the shotlist document

Reference file: `LMD_Shotlist.pdf` — 4 episodes, 5 scenes, 137 shots, numbered
`scene.shot` (`1.1` … `5.47`). Columns: `# | SIZE | ANGLE/MOVE | ACTION |
DIALOGUE/AUDIO | NOTES`.

**Verified**: pdf.js extracts this table in reading order, one row per shot. A
deterministic parser recovers all 5 scenes and all 137 shots, every scene
contiguous `1..N`, zero gaps. **No LLM required for a shotlist.**

Two pre-existing bugs this file exposes, both fixed here:

- `breakdown/index.ts` slices input to 12,000 chars. This file is 17,085 —
  roughly 30% (the back half of scene 5) is silently dropped.
- `pdftext.ts` joins pdf.js text items with `' '`, which splits ligatures:
  `traffic` → `tra ffi c`, `flat` → `fl at`. Garbles model input and on-set chips.

## Model

`Shot` is **nested inside the Slate record**, exactly as `tags: SlateTag[]`
already is. No new IndexedDB store, no DB version bump, no new Supabase table,
no RLS/trigger/index migration, no edits to the four hardcoded sync registries
(`SyncTable`, `SYNC_TABLES`, `buildProjectRows`, the tombstone order).

```ts
interface Shot {
  id: string;
  code: string;       // "5.31" — as printed on the shotlist
  order: number;      // position within the scene
  size?: string;      // "MCU", "XWS", "OTS (over Ansh)"
  move?: string;      // "STATIC, low", "HANDHELD, drifting", "Slow PUSH IN"
  action?: string;    // one-line recognizer shown on the roll screen
  dialogue?: string;  // the line, when the shotlist carries one
  note?: string;      // NOTES column
  tags?: SlateTag[];  // per-shot key-moment chips, when derived
}
```

`Slate` gains `shots?: Shot[]`. `Take` gains `shotId?: string` and keeps
`slateId` denormalized, so every exporter's scene lookup stays a one-line change
and no cascade path has to grow a level.

**Absent means legacy.** A scene with no `shots` behaves exactly as it does
today, matching how `cameras?`, `sound?`, `shootOrder?` and `today?` already
work in this codebase.

### Take numbering

`Take.number` becomes per-**shot** when the take has a `shotId`, per-scene when
it does not. So `5.31` gets takes 1, 2, 3 and `5.32` starts again at 1 — correct
slate practice. Sibling filter changes in `store/idb.ts` and `store/local.ts`.

Consequence for exports: take numbers now repeat inside a scene, so every
`sort(a.number - b.number)` needs `shot.order` as a middle key or the timeline
interleaves setups.

## Terminology fix

Scene → Shot → Take, everywhere. Every string that says "shot" but means take is
corrected: PDF band `Shot 3` → `Take 3`, CSV column `shot` → `take` with a new
`shot` column holding `5.31`, and the CSV `kind` value `'shot'` → `'take'`.

This is a breaking change to the CSV header, taken deliberately: the column was
mislabelled, and two exports currently disagree about what "shot" means.

## Ingest

**Shotlists only. Screenplays are not accepted.** The two halves play to
different strengths:

**Structure is read on the device.** `pdftext.ts` extracts (with ligature
repair), `shotlist.ts` parses the table into scenes and shots — exactly,
offline, instantly. If it can't read the document as a shotlist it says so
plainly rather than importing a breakdown it misread. Nothing here can truncate
a long list or invent a row that was never printed.

**Judgement comes from the model, and only judgement.** It never sees the
script or the PDF. It receives the already-parsed shot division — code, size,
move, action, dialogue — and returns the tappable key-moment chips for each
shot. Small structured payload, no transcription. Zero chips is a correct and
common answer; most setups are one action with nothing to mark mid-take.

This is the server call, so it is what sign-in gates. Enrichment failing does
not lose the parse: only 401 (sign in) and 402 (out of uses) surface, and every
other error keeps the shotlist and skips the chips.

The old `mode: 'script'` branch of the edge function is retired. `mode:
'callsheet'` remains live.

## On-set flow

**List to enter, strip to advance.**

- Tapping a scene opens its shot list — a screen of its own, showing each shot's
  code, size, move, action and take count, with covered/uncovered state.
- Tapping a shot opens the rolling screen for that shot.
- The rolling screen header carries the shot as a pill — `‹ 5.31 MCU · PUSH IN ›`
  — stepping through the scene in order without leaving the screen. Tapping the
  pill reopens the jump list. Locked while rolling, like the scene pager.

## Clip log

The project carries a **clip log**: every clip rolled, newest first, showing the
scene and shot it is filed under. A take rolled against the wrong setup — the
operator forgot to advance the shot — can be reassigned from here.

Reassignment moves the take to a new scene/shot and gives it the next free take
number there. It deliberately leaves a gap behind in the source rather than
renumbering that shot's other takes: an editor may already have the old numbers
written down. The clip name and clip number are never touched — the clip is a
physical fact about what the camera wrote; only the filing is being corrected.

## Out of scope

- Per-shot scheduling / call-sheet matching at shot granularity.
- Re-numbering shots by hand (shot codes come from the document).
- Shots as a first-class synced table. Revisit only if a scene outgrows a row.
