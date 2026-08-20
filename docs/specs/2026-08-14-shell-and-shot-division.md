# Clapper: iPhone shell + the shot division that failed on set

Plan, 2026-08-14. Two phases live. Folders, podcast mode, payments and the new
logo are sketched at the end and deliberately not in this build.

Scope came from the owner: "solve ui and the llm thing which did not allow last
shoot's shot division", shell first, then features.

---

## Phase 0 — tidy the tree (30 min, do first)

The working tree has 13 changed files sitting uncommitted on
`feat/accounts-quotas`, which is still unmerged, and `deploy.sh` builds from the
working directory. Restructuring the app shell on top of that means a bad build
has no clean state to fall back to.

- Commit the 13 files as-is (pdf export, analytics, pixel, legal page, the
  hand-built `src/ui/packs/hu-kon-chu.json`).
- Merge `feat/accounts-quotas` into `main`. It has been live in prod since
  2026-07-16; the branch is fiction at this point.
- Branch `feat/app-shell` off main.

---

## Phase 1 — the shell (the visible half)

### What it looks like

An iPhone app: a bottom tab tray that is always there, large titles that shrink
as you scroll, grouped inset rows with chevrons, sheets that rise from the
bottom. It inherits the app's own tokens, not the landing page's. The landing
page is ivory/ink/mint; the app is near-black/chalk/green. They are different
registers and the app's is the correct one for a phone at 5am under a work
light. One token fix folded in: brass `#e3b24a` goes to `#d8b23c`, which is the
corrected value already in every mockup and stale in the shipped CSS.

Rules that stay: dark only, no daylight toggle, no orange, system fonts only
(offline PWA), 44px minimum taps, mono + tabular numerals for every number.

### The four tabs

**Home** is the gateway. It does not exist today and gets composed new:

- **New roll** as the primary action. One tap from cold app to a rolling screen,
  no project setup ceremony. If there is an open shoot day it resumes that; if
  there is not, it makes a scratch project and drops you in. This is the whole
  point of the tab.
- **Shot division** — upload a shotlist. Currently buried on the projects list.
- **Podcast mode** — placeholder until Phase 4, hidden rather than shown greyed.
- A resume strip: the last project, the open shoot day, take count.
- `InstallNudge` moves here.

**Projects** is the list plus its whole navigation stack. Project detail, shot
list, clip log all push inside this tab and keep the tray visible. `New project`
and its sheet move here. Folders land here in Phase 3.

**Settings** takes the things currently welded to the bottom of the projects
list: the "How to use" guide (1103-1462 of ProjectsScreen), Restore from backup,
Feedback, plus app version and legal links.

**Account** takes `AccountRow` (282-338), sign-in and out, the usage and quota
counters, and `ProCta`.

### The technical rules (these are where it breaks if ignored)

`App.tsx` today is a `switch` over a `Screen` union with no wrapping shell, so
nothing persists across screen swaps. A new `AppShell` wraps it and nav state
becomes `{ tab, stack }` per tab.

- **z-index 30** for the tray. Below `.scrim` at 40, so sheets rise over it. (The
  first draft of this audit said 50, which would have put the tray on top of
  every sheet.) The ladder is: rows 5, tray 30, scrim 40, guide and toast 60,
  ProCta confetti 80.
- **Unmount, do not hide, on `rolling`.** `.roll` is `position:fixed; inset:0`
  and the CUT button is `sticky; bottom:0` with a written contract that CUT is
  never allowed off screen. A surviving tray element eats the vertical budget
  that has already caused real bugs. Same for the `.guide` overlay.
- `.app` gains `padding-bottom: calc(var(--bar-h) + var(--safe-bottom) + 24px)`.
  Without it the last row of every screen renders under the tray: the export bar
  on project detail, the account row on projects.
- `.toast` at styles.css:1602 is `bottom: calc(var(--safe-bottom) + 22px)`. It
  lands exactly on the tray. Raise by `--bar-h`.
- **Tray hides when the keyboard is up.** `main.tsx` already sets `--kb` from
  `visualViewport`; the tray reads it the same way `.sheet` does. Otherwise it
  floats mid-keyboard on every text field in the create-project sheet.
- `--bar-h: 56px` plus safe-bottom, new token. There is no spacing scale in this
  codebase; every value is hand-picked, so match the 14/16 house rhythm.
- Active tab is `--go`. Not `--rec` (reserved for recording and destructive) and
  not `--brass` (GOLD and Pro).

### The one thing to watch

`ExportBar` (ProjectScreen 1317-1479) is the highest-value action on the project
screen and it sits at the bottom of a long scroll, exactly where the tray now
lives permanently. It is not a CSS collision, it is a reachability problem.
Decide during the build whether it becomes a sticky action row or moves up.

### Done means

Built, service worker cleared, bundle hash confirmed against `dist/index.html`,
then clicked through on a real phone: every tab, every push and back, a sheet
over the tray, the keyboard up, and a full roll with CUT reachable. The stale
service worker has produced a wrong "verified" once before.

---

## Phase 2 — shot division that accepts real documents

### The actual failure

the example film’s own breakdown was rejected on set. `shotlist.ts` is strict by
design and that strictness is the selling point: on-device, free, instant,
offline, exact, nothing uploaded. It is not the thing to loosen. It rejects at:

- line 199: shot codes must be dotted decimals. His were `S1-01`.
- line 199: a size cell is mandatory on every row. His document has no size
  column at all. This was the real blocker.
- line 210: fewer than 4 matching rows returns null.
- line 272: shot indices must run contiguously from 1 in at least half the
  scenes.
- line 181: scene headings must read `SC 1 · INT./EXT. ...`.

### The fix

An LLM fallback that fires **only** when `parseShotlist()` returns `null`. The
strict parser stays the first path and is untouched. When it returns null, the
sheet stops saying "that does not look like a shotlist" and instead offers to
read it, with an explicit tap. Not silent, because the tap is also the privacy
consent.

Target shape is the existing `ScriptPack`. It already passes `isPack()` and the
field clamps (200 shots, code 12, size 24, move 40, action 160, dialogue 200).
No schema change anywhere.

New edge mode `divide` in `supabase/functions/breakdown/index.ts`, alongside
`shots` and `callsheet`:

- Input cap 45,000 chars, not the callsheet's 12,000. The LMD file alone is
  17,085 and a 12k cap silently ate the back half of a real upload once already.
- Output 12,000 tokens, not 3,000. A full extraction reply is much bigger than
  key-moment chips.
- Over the cap, split on scene-heading boundaries and batch, the way `shots`
  mode already batches 40.
- Reuse the existing `script` quota bucket rather than inventing a kind. Five
  free imports is a number users already understand, and it needs no migration.
  Same `consume_quota` / `refund_quota` / `script_mode_gate` RPCs, same
  refund-on-failure discipline.
- Fail closed, unlike `enrichShotMoments`. This path is the import.

Prompt rules taken from the real document, not invented:

- Accept `1.1`, `1-1`, `S1-01`, `Scene 1 / Shot 1`, bare tables, plain text.
- **Never fabricate a size or a move.** No size column means `size: undefined`.
- Per-shot location must survive. Real breakdowns change location inside one
  scene number (the example film scene 1 runs Rahul's Home, then Bedroom, then
  Transition). Clapper holds one name per scene, so the location goes at the
  **start** of `action`, because `action` truncates at 160 chars and a trailing
  location gets cut.
- Skip summary and notes pages. Pages 6-7 of that document are a location
  summary, not shots. They must not import as shots.
- Location-summary notes make better scene `Look:` lines than the first shot's
  action.

### Privacy copy that becomes false and must change

The claim "the model never sees the document" is currently true and stops being
true the moment this ships on a rejected file.

- `landing/legal/index.html:141-146` — the section literally headed "the most
  important point" says imported PDFs are "not uploaded to us and we cannot see
  it". Must be qualified.
- `README.md:13` — unqualified "nothing leaves the phone".
- `ProjectsScreen.tsx:1023-1027` — the sheet's own intro copy.
- A line at the moment of the fallback tap saying what is about to be sent.
- Code comments at `shotlist.ts:9`, `breakdown.ts:1-11`,
  `breakdown/index.ts:13`.
- `legal/index.html:172-176` and `:277-279` already describe text going to Groq.
  They are stale leftovers from the retired `script` mode and become accurate
  again, but need a pass to match what `divide` actually does.

### Done means both of these, not one

1. `~/Desktop/ExampleFilm-shotlist-clapper.pdf` imports end to end through the
   fallback. Ground truth already exists: the hand-built
   `src/ui/packs/hu-kon-chu.json`, 10 scenes and 76 shots. The output should
   match it structurally.
2. `LMD_Shotlist.pdf` still parses 137 of 137 shots on device with **zero
   network calls**. Without this check you can pass the first by quietly
   breaking the thing that makes the feature worth having.

Deploy prerequisite: the `sbp` token in `credentials.md` is real and verified
working today (Supabase API returned 200), so the edge function deploy is not
blocked.

---

## Later, sketched only

**Phase 3, folders (premium).** Cheapest shape is `Project.folderId?: string`
plus a small `Folder` entity. That needs IndexedDB v2 to v3, a mirrored map in
`local.ts`, `'folders'` added to `SYNC_TABLES`, and one Supabase migration that
is a copy-paste of the `slates` table block with the same four RLS policies. No
export path changes at all. Files inside folders is a separate feature: the app
stores no blobs today, no Storage bucket is configured, and the shotlist PDF is
parsed and discarded. Ship folders-for-projects first.

**Phase 4, podcast mode.** `Project.mode?: 'film' | 'podcast'`, absent meaning
film. This is the cheapest possible addition the codebase supports: no schema
bump, no migration, no sync change, because a Project is already stored and
synced whole. The only real work is the UI branch.

**Parked.** Payment gateway (Razorpay) and the new logo, both on the owner's word.
Note that `is_pro` is already server-authoritative and only writable by
service_role, so until billing exists the gate is a SQL update, which is fine
for the first paying users.
