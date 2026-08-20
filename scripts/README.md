# scripts/

Dev tooling. Nothing here ships.

| file | what it does |
|---|---|
| `contrast-audit.mjs` | The rendered-app contrast auditor. Read below before touching the material. |
| `make-icons.mjs` | Regenerates the PWA icon PNGs. |
| `og.svg` | Source for the link-preview card. |
| `test-rebase.mjs`, `test-shootorder.mjs`, `test-sound.mjs` | One-off harnesses kept for re-running by hand. |

---

## `contrast-audit.mjs` — the contrast auditor

### Why it exists

Token arithmetic cannot answer the only question that matters about a
translucent bar: **what is behind it.** That is whatever the list happens to be
showing, blurred, saturated and brightened by `backdrop-filter`. So the auditor
drives the real built app, scrolls real content under every material surface,
makes the type on those surfaces transparent, screenshots, and reads the pixels
left inside each text node's own rectangle. **Those pixels are the composited
backdrop. Everything else is a guess** — including compositing the CSS
`background-color` of the ancestor chain, which is what a token-level checker
does and which is wrong the instant a blur is involved.

Every glass decision in `docs/specs/2026-08-15-premium-standard.md` §3 depends
on this script. Before it was committed it lived in an agent's scratch space,
and one version of it was pointed at a dead worktree comparing a stale `dist`
to itself — so it could return clean on a tree nobody was running.

### It measures the tree it built, or it dies

Three guards, all mechanical:

1. **`ROOT` is resolved from the script's own path** (`scripts/..`), so it always
   audits the checkout it is committed in. Never a sibling worktree, never a
   path someone typed on a command line.
2. **It runs `npm run build` itself** by default. With `--no-build` it refuses to
   start if any file under `src/` (or `index.html`, `vite.config.ts`,
   `package.json`) is newer than `dist/index.html`, and it names the offending
   file.
3. **It asserts the bundle the browser actually loaded** against the one
   `dist/index.html` names — after unregistering the service worker, deleting
   its caches, waiting ~2s, and navigating again as a separate step.

The banner prints the resolved root, the short git rev and whether the tree is
dirty. A run cannot be mistaken for a run of something else.

### Running it

```sh
node scripts/contrast-audit.mjs                        # build, then audit both themes
node scripts/contrast-audit.mjs --no-build             # audit the dist that is there
node scripts/contrast-audit.mjs --theme light          # one theme
node scripts/contrast-audit.mjs --shots ~/Desktop/x    # also save every frame
node scripts/contrast-audit.mjs --headed               # watch it drive
```

Exit code `1` if any text node on a material surface is below its WCAG bar,
`2` if a guard tripped.

**Dependencies.** `playwright-core` and a Chrome install. It is deliberately not
a dependency of this repo — this is a dev tool, not a shipped one. If it is not
resolvable, point `PLAYWRIGHT_PATH` at a `node_modules` that has it:

```sh
mkdir -p /tmp/pw && cd /tmp/pw && npm i playwright-core
PLAYWRIGHT_PATH=/tmp/pw/node_modules node scripts/contrast-audit.mjs
```

It drives a **headless** Chrome at `devices['iPhone 14']`, `deviceScaleFactor: 2`.
It never touches your own browser profile.

### The frames it walks

The ones §11 of the premium standard names, seeded with the bundled 137-shot
"Keep The Take" pack (Home → *Shotlist · from a PDF* → the example), because
at rest there is nothing to blur and the effect is unprovable:

- `project-midscroll`, `project-deep` — the scene list passing under `.topbar`
  and `.tabtray`
- `shots-midscroll` — the 137-shot list, the densest content in the app
- `shots-signal-under-tray` — a saturated chip parked **deliberately** in the
  tray band, rather than wherever a scroll happened to leave one
- `ltop-home` / `-projects` / `-settings` / `-account` — `.ltop` scrolled on
  every tab root
- `sheet-scrolled` — `.sheet__head` over a body that really scrolls

### What the two tables mean

**A. BAND DELTA — does the glass actually read.**
Each surface is rendered twice at the same scroll position: once as built, once
with `backdrop-filter: none` and the opaque fallback token. Then

| column | meaning |
|---|---|
| `FLAT` / `LIVE` | mean grey of the band, flattened and as built |
| `SHIFT` | `LIVE - FLAT`, the difference of means. **The weak one** — pixels the backdrop pushes lighter cancel pixels it pushes darker, so a bar with real structure showing through can read as zero. |
| `MOVE` | mean per-pixel `abs(live - flat)`. **The honest one.** |
| `P95` / `MAX` | where the backdrop shows most. |

A band with nothing behind it correctly moves zero, so the summary line reports
the loaded bands separately and says how many were empty. Do not average the
empty ones in and call it a regression.

**B. CONTRAST — is the type on the glass still legible.**
WCAG ratio of every text node on a material surface against the **sampled**
backdrop. `MEAN` is the ratio against the mean backdrop; **`P10` is the number
that fails** — the 10th-percentile per-pixel ratio inside the text rectangle, so
a saturated chip or a REC dot sliding under tray text counts rather than being
averaged away.

### When to run it

Any change to `--material-*`, `--scrim-*`, the material surface list, or the
signal palette. Also any new bar: the material is mixed in exactly one rule in
`styles.css`, and a surface that does not join that list will not be audited.

### What it cannot tell you

`backdrop-filter` on real iOS Safari, on a real phone, outdoors at full
brightness. Headless Chrome's blur is not WebKit's, and a desktop monitor does
not test the condition the light theme exists for. **Nothing here is proven
until it is looked at on the device it was written for.**
