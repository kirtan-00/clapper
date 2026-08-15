# Clapper: the clear theme

Direction change from Kirtan, 2026-08-14, mid-build:

> "ui like apple blurry translucent not glass ui but clear theme this dark
> theme looks bad for outside part"

Confirmed with him: **both** things are wrong. Dark is unreadable shooting
outdoors, *and* the chrome reads heavy. And: **light is the default, with a
manual night toggle.**

This overrules the "dark only, no daylight toggle" rule in
`2026-08-14-shell-and-shot-division.md`. Every structural rule in that spec
still stands untouched — this is a repaint, not a re-architecture.

---

## Why light, in one line

A phone at midday holds about 1,000 nits against roughly 10,000 lux of
sunlight. A dark UI in that light stops being a screen and becomes a mirror
of the person holding it. Light backgrounds win outdoors because the panel is
*adding* light to a bright field instead of trying to stay darker than it.

The 5am call time is real too, which is why the night toggle exists — but it
is the exception, not the default. A toggle rather than `prefers-color-scheme`
because the OS switches on a clock, not on where the unit actually is: a 2pm
interior and a 2pm exterior want opposite things.

---

## The measured problem: accents do not survive inversion

Contrast of the CURRENT signal colours as text on paper `#FBFAF7`:

| token | current value | ratio | verdict as text |
|---|---|---|---|
| `--go` | `#38D178` | **1.91:1** | fails, badly |
| `--brass` | `#D8B23C` | **1.94:1** | fails, badly |
| `--sound` | `#4F9FD1` | **2.79:1** | fails |
| `--rec` | `#FF3B30` | **3.40:1** | fails |

So a repaint that only swaps the surfaces produces an app whose every signal
colour is illegible in the exact conditions that motivated it. Each signal
therefore gets **two** roles:

- **Bright value — FILLS ONLY.** Filled buttons, the rolling pulse, tag chips,
  status dots. Never text, never an icon on paper.
- **Deep value — TEXT AND ICONS.** Labels, the active tab, inline meta.

This split does not exist on the dark theme, where the bright values are the
text colour. Components must read the semantic token, not pick.

---

## Tokens

Both themes define the same names. Repainting is this block only; no component
CSS changes. Light lives on `:root`, night on `[data-theme="night"]`.

### Light (default)

```
--paper            #FBFAF7   page ground. Warm, not #fff — ties to the landing
                             page's ivory and stops the screen reading clinical
--paper-raised     #FFFFFF   cards, grouped inset rows
--paper-sunk       #F2F0EA   wells, inputs, the scrubbed track
--ink              #14151A   primary text        17.47:1 on paper
--ink-dim          #5A5E68   secondary            6.22:1
--ink-faint        #7C808A   non-essential only   3.79:1 — never for a number
--hairline         #DDD9D0
--hairline-soft    #EBE8E1

--go               #38D178   FILL  (unchanged, still the brand green)
--go-text          #0E7A43   TEXT/ICON            5.18:1
--rec              #FF3B30   FILL  (unchanged)
--rec-text         #C0261D   TEXT/ICON            5.69:1
--brass            #D8B23C   FILL  (unchanged)
--brass-text       #7A5F0E   TEXT/ICON            5.80:1
--sound            #4F9FD1   FILL  (unchanged)
--sound-text       #1F6187   TEXT/ICON            6.45:1
```

White on a filled `--go-text` button is 5.41:1; on `--rec-text`, 5.94:1. Both
pass. White on the BRIGHT values does not — filled buttons tint with the deep
value and keep the bright one for the resting/indicator state.

### Night (toggle)

Keep the existing ramp exactly as shipped — it is already tuned and nobody has
complained about it in the dark. `--go`/`--rec`/`--brass`/`--sound` collapse
back so that `*-text` aliases the bright value, because on near-black the
bright value IS the legible one.

### Semantic mapping

Unchanged names, so no component churn:

```
--bg              -> --paper            (night: --ink-950)
--surface         -> --paper-raised     (night: --ink-900)
--surface-raised  -> --paper-sunk       (night: --ink-850)
--text            -> --ink              (night: --chalk)
--text-dim        -> --ink-dim          (night: --chalk-dim)
--text-faint      -> --ink-faint        (night: --chalk-faint)
--hairline        -> --hairline         (night: --line)
```

---

## The material chrome

Apple's translucent bar, not glassmorphism. The distinction is the whole brief:

**Yes** — one translucent tint over a blur, one hairline, content dimly
readable through it so the bar feels like it sits *on* the page.

**No** — refraction, inner bevels, a second highlight border, coloured glows,
a card that is itself glass. No "Liquid Glass". Glass on a card is decoration;
material on a bar is information about depth.

```
--material-bg        light:  rgba(251, 250, 247, 0.86)
                     night:  rgba(18, 19, 25, 0.80)
--material-blur      saturate(180%) blur(20px)
--material-hairline  var(--hairline)
```

Light runs **more opaque than night (0.86 vs 0.80)**, deliberately. Translucency
costs contrast, and the light theme exists precisely for the condition where
contrast is already under attack. Do not equalise them for tidiness.

Applies to: the tab tray, and any sticky header that follows it. Nothing else.

### Amendment, 2026-08-15 — the material is now a language, not one bar

The tray was the only material surface that had actually been built. The
mechanism now covers every piece of chrome that content scrolls underneath,
and every one of them reads the same tokens, so a repaint is a token swap and
not a component rewrite.

| surface | what it is | tint token | fallback token |
|---|---|---|---|
| `.tabtray` | the tab tray | `--material-bg` | `--material-solid` |
| `.ltop` | large-title bar, tab roots (Home, Settings, Account) | `--material-bg` | `--material-solid` |
| `.topbar` | nav bar, pushed screens (project, shots, clip log) | `--material-bg` | `--material-solid` |
| `.sheet__head` | the sheet's grabber cap | `--material-cap-bg` | `--material-cap-solid` |
| `.scrim` | the wash under a sheet | `--scrim-bg` | none needed, it is already opaque enough |

Blur is `--material-blur` on all four material surfaces and `--scrim-blur` on
the scrim; the hairline is `--material-hairline` everywhere. One rule in
`styles.css` carries the blur pair for all four, so the `-webkit-` prefix
cannot be forgotten by the next surface to arrive.

`--material-cap-bg` exists because the sheet cap sits on `--surface`, not on
`--paper`: mixing it from paper lays a warm band across the top of a white
sheet whenever the sheet is short enough not to scroll.

Two rules that fell out of building it:

- **A material surface must not be a descendant of the scroller it covers.**
  The sheet is therefore a shell (`.sheet`), an absolutely positioned cap
  (`.sheet__head`) and a scrolling body (`.sheet__body`) whose top padding is
  the measured cap height, published as `--sheet-head-h` from `common.tsx`.
- **The blur radius decides how much reads through, not the opacity alone.**
  At `blur(20px)` a line of body text averages almost entirely away: measured
  on the rendered app, content under the nav bar moves the band by about 3
  levels of grey (light 250 -> 247, night 18 -> 21). Large blocks — the
  clapper stripe, a filled button — are what make the layer read as a layer.

**Superseded pending the design council's spec.** The tint, opacity, edge and
shadow values above are deliberately left where the original spec put them.
The next pass re-specifies the look; it should not need to move the plumbing.

**Implementation rules that will bite:**

- `-webkit-backdrop-filter` alongside `backdrop-filter`. iOS Safari is the
  primary target and this is a PWA; without the prefix the tray is a flat
  translucent slab on the actual device while looking perfect in desktop Chrome.
- Guard it: `@supports not (backdrop-filter: blur(1px))` → raise
  `--material-bg` to fully opaque. A blur that silently no-ops leaves text over
  moving content.
- The blurred layer needs its own stacking context or iOS will blur the wrong
  thing. Keep the tray at `z-index: 30` per the ladder — do not add new layers
  under it.
- Do not put `backdrop-filter` on anything inside a scroll container. It
  repaints per frame and this app is used one-handed on old phones.

---

## The night toggle

- Lives in **Settings**. One row, not a floating control — it is set once per
  call time, not fiddled with.
- Persist to `localStorage` under `clapper.theme`; values `light` | `night`.
  Absent means light.
- **Set `data-theme` on `<html>` from an inline script in `index.html`, before
  first paint.** Applying it in React means a white flash into night mode at
  4am, which is exactly the moment it is least welcome.
- Update `<meta name="theme-color">` with the theme, or the iOS status bar and
  the PWA splash stay the other theme's colour.
- No system-preference following. See the reasoning at the top.

---

## Verification — this is where it gets judged

Contrast numbers are necessary, not sufficient. The claim being made is
"readable outdoors", so:

1. `npx vitest run` and `npx tsc --noEmit` clean.
2. Service worker cleared, **wait 2s, navigate separately**, bundle hash
   confirmed against `dist/index.html`. This has produced a false "verified"
   before.
3. Both themes clicked through at iPhone viewport: every tab, a push and back,
   a sheet over the tray, the keyboard up, a full roll with CUT reachable.
4. The tray's translucency actually reads as depth over scrolled content —
   screenshot it mid-scroll, not at rest.
5. **On a real phone, outdoors, at full brightness.** Nothing on a desktop
   monitor tests the thing this change exists for.

---

## The iOS idiom

Kirtan, same session: *"frosted look ios style sleek all icon and other things
ios app style minimal nd good"*, *"sleak smart elegant"*.

Read as: it should feel native, and the throughline is **restraint**. Anything
that adds visual noise is wrong, however nice it looks alone.

### Icons — and the licensing trap

**Do not ship SF Symbols.** Apple's licence restricts them to Apple-platform
UI; a web PWA redistributing the glyphs is not covered. No CDN icon font
either — offline PWA. **No emoji as icons**, which is the loudest possible
"nobody designed this" tell.

Hand-drawn inline SVG, in the SF Symbols idiom:

- One stroke weight across the entire set. `1.75px` on a 24px viewBox.
- `stroke-linecap="round"`, `stroke-linejoin="round"`.
- `stroke="currentColor"`, never a hardcoded fill — colour arrives from the
  token on the parent, so both themes and the active/inactive tab state work
  with no extra code.
- Optically centred, not mathematically. A chevron or a triangle needs its own
  nudge.
- One corner-radius family across the set, so they read as one hand.
- Never mix filled and stroked in the same row.

### The list idiom

- Grouped inset lists: a `--surface` card at `--radius`, sitting on `--bg`.
- Rows >= 44px. Chevron on anything that pushes: ~13px, `--text-faint`.
- **Hairlines between rows inset to the text origin, not full-bleed.** This one
  detail is most of what separates "iOS list" from "web table".
- Section headers small, uppercase, letter-spaced, `--text-dim`, sitting
  *outside* the card above it.
- Large title shrinking into the header on scroll.
- Sheets rise from the bottom with a grabber, over the scrim at z-index 40.

### What "elegant" means here, concretely

- No decorative gradients. No coloured glows. At most one soft elevation
  shadow, and prefer a hairline to a shadow.
- **Colour is signal only** — rolling, GOLD, discarded, sound. Chrome stays
  greyscale. An app where everything is coloured has no way left to say *this
  one matters*, which on a set is the only job the colour has.
- Whitespace over density. Rows breathe.
- Mono + tabular numerals on every number, so digits do not jitter as a counter
  ticks.
- Motion short and springy, ~0.25–0.3s, ease-out. Honour
  `prefers-reduced-motion`. No parallax, no bounce for fun.

## Not in scope

No new features. No layout changes. No touching `src/export/**`. The structural
rules from the shell spec — z-index ladder, tray unmounting on `rolling`,
`--bar-h`, keyboard handling, 44px taps, system fonts, mono tabular numerals,
no orange — all survive the repaint unchanged.
