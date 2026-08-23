# Clapper: the premium standard

the owner, 2026-08-15, on seeing the rebuilt UI:

> "i am talking about ios app style frosted ui glassy and fine ass not indie app
> style this looks claude generated ... all the menus tabs burger menu elegant
> smart app that's primum and professoinal"

Four councillors were convened: a forensic critique, a navigation-and-platform
researcher, a material scientist, and a type/spacing/motion systems lens. This
document is their synthesis and it is now the contract.

**It supersedes** the "material chrome" section of
`2026-08-14-light-theme.md` (the "explicitly NOT glassmorphism / no Liquid
Glass" rule is dead — see §3). Everything else in that document — the palette,
the measured contrast floors, the light-default doctrine — stands untouched and
still wins every tie.

---

## 0. The verdict, in one paragraph

**The architecture is already right.** Four tabs with per-tab stacks, sheets
with grabbers, push hierarchies, primary actions living in content rather than
in the tab bar — that is what Apple's own apps do. Nothing structural needs to
move. What reads indie is the **finish**, and the finish fails in four
measurable ways: unresolved scales, game-UI button physics, explainer prose used
as a design material, and a material effect that is technically present but
visually absent. All four are mechanical to fix.

---

## 1. The measured fingerprint

Counted in `src/styles.css`:

| Symptom | Count | Should be |
|---|---|---|
| distinct `font-size` declarations | **37** | 9 |
| bold declarations (700×49, 800×23, 900×2) | **84** | 800+ only on ROLL/CUT/REC |
| declared 400/500 weights | **0** | 400 is the default voice |
| `letter-spacing` values | **15** | 3 |
| `gap` values (incl. 1, 3, 5, 7, 9, 13) | **18** | 8 |
| radius values | **14** | 3 + pill |
| bare `ease` / `ease-in-out` easings | **33** | 0 |

Every one of those values is locally defensible. Collectively they are the
texture of a machine that made a reasonable choice 200 separate times without
ever deciding. **That texture is the AI fingerprint**, more than any single
element.

---

## 2. Prose is not a design material

The loudest tell, per the critique: nearly every screen carries 2–4 lines of
conversational body copy **at rest**. Home alone carries ~90 words. The
Projects empty state, the project header warning, every Settings group, the
shotlist sheet and the Account quota note all do the same.

> Premium apps communicate with hierarchy, placement and six-word labels.
> Prose appears once, at the moment of need.

**The rule.** No screen carries more than **one line** of explanatory copy at
rest. Anything longer moves behind the moment of need (on first use of the
feature, on error, or into the guide). The voice is good and stays; the dosage
does not.

This is the cheapest single change in this document and the biggest
de-AI-ification.

---

## 3. Glass: what it is, and the rule that keeps it readable

**the owner asked for glassy. The tension with midday sun is real and it resolves
cleanly, because opacity is the ONLY lever that spends contrast.**

- **Vibrancy** (saturate/brightness on the blur composite) — costs nothing.
- **The specular edge** — costs nothing. It is a static inset shadow.
- **Opacity** — spends the entire contrast budget.

Therefore: **`--material-bg` at 0.86 light / 0.80 night is a FLOOR, not a
starting point.** It never erodes in the name of "glassier". Glassy is bought
with the two free levers.

### 3a. The specular edge belongs only where curvature exists

Apple's material bends light along a **curved** edge. A flat, full-bleed,
edge-to-edge bar has no curve to catch light at a grazing angle, so Apple never
puts a highlight on one. Putting a glowing border on every glass box regardless
of shape is decorating, not simulating — and it is a top-tier pastiche tell.

| surface | shape | specular edge? |
|---|---|---|
| `.tabtray`, `.ltop`, `.topbar` | flat, full-bleed | **NO.** One hairline, on the edge content passes under. |
| `.sheet__head`, the grabber pill | genuinely curved | **YES.** One top-edge catch-light. |

```css
.sheet__head { box-shadow: inset 0 1px 0 rgba(255,255,255,0.55); }
[data-theme="night"] .sheet__head { box-shadow: inset 0 1px 0 rgba(255,255,255,0.12); }
```

`inset` on a `border-radius` element follows the curve for free. It is a single
top catch, never a loop around the perimeter.

### 3b. Vibrancy splits by theme

The current single shared blur is why the frost reads flat. **Measured on the
rendered app: at 0.86/blur(20px) the band moves about three levels of grey**
(light 250.0 → 247.3, night 18.0 → 21.2). The effect is technically present and
visually absent. Fix it with vibrancy, not transparency:

```
--material-blur-light:  saturate(190%) brightness(1.04) blur(20px)
--material-blur-night:  saturate(150%) brightness(0.92) blur(22px)
```

Night must NOT mirror light's saturation lift: boosting saturation on near-black
pushes the REC red and brass toward neon, which reads cheap.

These are hypotheses, not documented constants. **Render and look before
locking**, against real content, mid-scroll.

### 3c. Chrome only, never content

Frost goes on **transient chrome** — tray, sticky headers, nav bars, sheet caps,
scrim. Content surfaces stay opaque and keep the 7:1 floor. This is what makes
"glassy" and "readable at 1pm on a rooftop" the same design rather than opposite
ones.

### 3d. Hard technical facts

- **Both prefixes are mandatory.** Unprefixed `backdrop-filter` only works from
  **Safari 18 (2024)**; `-webkit-` has been required since Safari 9. Without the
  prefix it silently no-ops to a flat unblurred slab on iOS while looking
  perfect in desktop Chrome.
- **`backdrop-filter` on `position: fixed` repaints the blurred region every
  scroll frame** in Safari — real jank on a phone. Prefer `sticky`, and never
  put it on a descendant of the scroller it covers.
- Feature-detect as `@supports (backdrop-filter: blur(1px)) or
  (-webkit-backdrop-filter: blur(1px))`, raising the **token** to opaque.

### 3e. Banned, explicitly

Four-sided white/10% borders · glow halos round a whole card · glass on a card
(content) · gradient or rainbow "glass edge" border-image · double-inset bevels
(that is neumorphism, not glass) · `saturate()` past 200% · a top-left
radial-gradient "light source" blob · a specular highlight on a flat bar ·
shipping without `-webkit-`.

---

## 4. Type: nine steps, and weight discipline

System fonts only, forever — this is an offline PWA and on iOS `system-ui` **is**
SF Pro, which is the correct premium-native choice. The failure was never the
family; it was the absence of a scale.

| Token | Size | Weight | Line-height | Tracking | Use |
|---|---|---|---|---|---|
| `--t-caps` | 11px | 600 | 1.1 | +0.08em, upper | Section headers, hardware labels, tab labels |
| `--t-caption` | 12px | 400/600 | 1.35 | +0.01em | Footnotes, meta, operator names |
| `--t-secondary` | 13px | 400/600 | 1.4 | +0.005em | Row sublines, card meta, toasts |
| `--t-body` | 16px | 400 | 1.45 | 0 | Prose, inputs (16 also kills iOS zoom-on-focus) |
| `--t-row` | 17px | 400/600 | 1.3 | −0.005em | Row labels, card names, buttons |
| `--t-title` | 20px | 650 | 1.25 | −0.012em | Sheet titles, guide heads |
| `--t-display` | 28px | 700 | 1.15 | −0.018em | Hero lines, post-cut numbers |
| `--t-large` | 34px | 700 | 1.1 | −0.022em | Large titles (shrink target 17px/600) |
| `--t-timecode` | `clamp(44px,13vw,96px)` | 700 mono | 0.95 | −0.02em | The rolling readout only |

**Weight is the bigger failure than size.** Today 700/800 is the default voice,
so nothing is emphasised. New rule: **400 is default, 600 is emphasis, 650–700
is titles, 800+ exists only on ROLL / CUT / REC.** Weight contrast is what makes
SF look expensive.

**Tracking** collapses to three values: +0.08em on all small caps, −0.01/−0.02em
at the display end, 0 elsewhere. The 0.22em REC banner is the one sanctioned
outlier — it is signage, not type.

**Mono means slate language**: clip names, timecode, TC calculator, shot codes,
version. Counters ("9 sections", "3 of 5", "1/7") become UI-face with
`font-variant-numeric: tabular-nums`, which SF supports natively — `.grow-value`
already does this and is the pattern to spread. Mono on any other number is a
costume.

**Sunlight floor: nothing meaning-bearing below 11px.** `.tabtray__label` at
9.3px and `.label` at 10.6px are the first casualties at midday. 11px still
fits: 22px icon + 3px gap + 11px label = 36px inside `--bar-h: 56px`.

**Known bug to fix in passing:** `.shotcode` carries a comment claiming it is
monospaced "so 5.9 and 5.31 line up" and declares no mono family. The comment
lies and the codes do not align.

---

## 5. Spacing: a 4pt ladder, and one left edge

The "14/16 house rhythm" is **retired**. It was not a system; it produced 18 gap
values including 1, 3, 5, 7, 9 and 13 — a vibe that approximated a 4pt grid with
2px of jitter.

```
--sp-1: 4px    micro: label-to-value, icon-to-dot
--sp-2: 8px    intra-component: chip gaps
--sp-3: 12px   component internals, row gaps
--sp-4: 16px   component padding-x, screen inset, sheet padding
--sp-5: 20px   large component padding
--sp-6: 24px   small section break
--sp-7: 32px   section rhythm between groups
--sp-8: 48px   screen-level breathing, empty states
```

**One level of the ladder per relationship — the hierarchy of gaps IS the visual
hierarchy.**

**Commit to a 16px screen inset** (currently 18px). That aligns the app padding
with `--glist-inset: 16px`, so the large title, section headers and row text
share **one left edge** instead of four near-miss origins (16, 18, 20, and the
guide's 14).

**Section rhythm goes UP**, 26px → `--sp-7`. Premium density is not smaller
padding; it is fewer values and larger section breath.

**Radius family:** `--radius-sm: 10`, `--radius: 14`, `--radius-lg: 20`, pill
999. Nested elements use **outer minus padding**, never a free pick.

Migration is nearest-neighbour and mechanical: 2,3→4 · 5,6,7→8 · 9,10,11→12 ·
13,14→12 or 16 by role · 18→16 · 20,22→20/24 · 26,30→32 · 40→48. **Leave alone:**
safe-area calc chains, `--bar-h: 56px`, the 44px tap floor, and the roll screen's
documented density overrides at 3–4 cameras. One screen per commit, eyeballed
against screenshots.

---

## 6. Motion: two curves, five durations, and exits

```css
--ease-out: cubic-bezier(0.2, 0.85, 0.25, 1);   /* entering, settling */
--ease-in:  cubic-bezier(0.4, 0.0, 0.7, 0.2);   /* the rare exit */
--dur-press: 80ms
--dur-state: 120ms
--dur-move:  180ms
--dur-panel: 240ms
--dur-kb:    140ms   /* FIXED POINT: tray transform AND scrim padding.
                        Never retune one without the other. */
```

Encoding `--dur-kb` as a token is the point: the constraint lives in the system,
not in a comment two agents from now.

- **Press states: keep exactly as built** (70–90ms travel). On iOS there is no
  Vibration API, so **the key depression IS the haptic**. Never replace it with
  an opacity dim. The weaker `opacity: 0.7` presses should move to the
  background-tint press the list rows use — opacity reads web, background reads
  native.
- **Tab switch: instant, no animation.** Frequency-gated. Only the active mark
  may crossfade at `--dur-state`. Recorded as a decision so nobody "adds polish".
- **Push/pop:** enter 12px translateX + opacity at `--dur-panel`; pop subtler and
  faster, 8px/180ms. Class-toggled transitions, not keyframes, so a mid-flight
  back tap retargets. **Instant is acceptable; a half-committed slide is not.**
- **Sheet dismiss is the worst current defect** — every sheet, scrim and toast
  vanishes in a single frame while its entrance animates. Exit: translateY 100%
  in 180ms `--ease-in`, scrim opacity out in parallel at 160ms, then unmount.
  **Exits are always subtler and faster than enters.**
- **One heartbeat per screen.** Four desynced infinite loops currently run while
  live (border 1.8s, tally 1.1s, recdot 1.2s, mic 1.4s). The tally dot's pulse is
  *earned* — real tally lights blink — so it keeps it. The rest go static or
  inherit its phase.
- **Chip flash:** keep (eyes-off confirmation is functional) but 360ms → 240ms
  and scale 1.14 → 1.06. The colour carries the message.
- **Reduced motion:** replace the `*{animation-duration:0.001ms}` nuke with one
  rule disabling transitions except opacity fades.

**Banned:** bare `ease` · blur-in entrances · staggered list reveals ·
scroll-triggered animation · hover-scale on cards · bouncy overshoot on
sheets/toggles · new infinite pulses · skeleton shimmer · anything over 300ms
on an action performed more than once a day.

**No longer banned, reversed 2026-08-24: the ProCta confetti.** This section
called it slop on an upsell and asked for a brass state change instead
(ui/ProCta.tsx, a13e86b). The owner reversed that call outright the same day
he put Pro back to a willingness-to-pay probe — the confetti argument does
not even apply in the literal sense it was made, because ProCta is not an
upsell control right now, it is a probe with no purchase behind it. Confetti
is restored from a13e86b^, retargeted off the app's palette rather than the
old hardcoded gold (the gold is gone app-wide, see the `--brass` token note in
styles.css), and it still skips under `prefers-reduced-motion` / the app's own
`data-motion="reduce"`. If Pro starts selling again, revisit whether confetti
belongs on that button too — this reversal was granted to a probe, not
pre-cleared for a paid upsell.

---

## 7. Components: the specific tells to kill

1. **The keycap shadow language.** `0 10px 0 0` hard-offset solid shadows on
   ROLL, CUT and chips are the Wordle/Duolingo/itch.io idiom — game UI on a pro
   tool. The *metaphor* is right (big targets, physical travel, glove-friendly at
   5am) and stays. The *finish* is wrong: press becomes 1–2px travel, a
   compressed diffuse shadow and scale 0.98 on `--ease-out`.
2. **Zero dashed borders survive.** Four exist today. Dashed = placeholder =
   wireframe-that-shipped — and one of them is on PDF import, the app's most
   differentiating feature, styled as a placeholder.
3. **The Delete button rendered at rest inside every scene card.** The most
   destructive action on the screen, ten times, on a list you thumb-scroll. iOS
   puts destroy behind swipe or edit mode. This is a hazard as well as a tell.
   The reorder affordance is worse — a grip handle *and* ▲▼ buttons *and*
   drag, three overlapping ways, none confident.
4. **Two competing pagers stacked on the roll screen** — chevrons flanking the
   shot pill *and* a `‹ Prev / 1/10 / Next ›` row doing the identical job. The
   critique called this "the clearest 'assembled, not designed' moment in the
   app." One pager survives.
5. **The chip wall.** Ten-plus chips in a uniform 2-column grid mixing three
   different *classes* of control — shot sizes, a take grade, and per-shot
   moments — at identical size, shape and weight. Under pressure at 5am there is
   no eye path. Tier them: sizes as a compact segmented control, moments as a
   scannable list with progress, GOLD as a distinct grade action near CUT.
6. **Equal billing for destructive paths.** Discard sits at the same width and
   weight as Keep; MARK IN is a full-width slab the same shape as CUT directly
   below it. Subordinate actions must look subordinate.
7. **The app icon + wordmark on the app's own Home tab.** That is a website
   header. The OS already showed the icon.
8. **The light-mode REC tint** washes the screen pale pink — Bubblegum, not ARRI.
   The full-screen state-tint *mechanism* is excellent and stays; the night
   grade is already right. Re-grade light toward a disciplined red header over a
   neutral field.
9. **Optical centring.** Back `‹`, chevrons and `✕` are font glyphs centred
   geometrically in 44px boxes; text glyphs sit high and read sloppy. Use SVG,
   as the tray already does.
10. **Labelled back buttons.** iOS convention is the previous screen's name, not
    a bare chevron. Large titles belong only at the root of a stack.

---

## 8. Navigation: settled questions

- **No burger menu. Anywhere.** Not a reflex veto — it hides the entire
  navigation model behind one icon, and on iOS it sits top-left, the worst zone
  for the one-handed use this app is built around. It is also the loudest
  "ported from Android" tell. Four sections is precisely the count the tab bar
  pattern exists for. The legitimate exception is institutions with dozens of
  unrelated flat areas; that is not Clapper.
- **Tabs stay tabs. Sheets stay sheets** — the shotlist sheet's grabber, rounded
  top and dimmed backdrop are correct native convention; a redesign must not
  "improve" them.
- **"Menu" means a pull-down / overflow for secondary actions**, in place — never
  a drawer.
- Settings sub-areas become a standard grouped-list push inside the Settings
  tab, the Settings.app pattern.
- **Do not chase the iOS-26 floating, minimize-on-scroll tab bar.** It spends
  contrast on translucency in the exact condition light exists for. Keep the bar
  anchored and opaque-enough; buy the premium read with icon weight, a pill
  active state and correct safe-area padding.

### PWA limits — do not pretend
No native push/pop transitions. Edge-swipe-back cannot be reliably claimed once
the SPA pushes history; always keep an explicit back button. No true `UIMenu`.
`100vh` / `innerHeight` / `visualViewport` disagree in standalone mode and shift
with the keyboard — use `100dvh` plus explicit `env(safe-area-inset-*)`.

---

## 9. The roll screen — the one used under pressure

It gets its own section because it is the product.

- **ROLL sits mid-screen while CUT sits at the bottom.** The single most-pressed
  control in the app **changes physical position between the two states it
  toggles**. Anchor the deck to the bottom in both states. This is the one change
  the owner will feel in his hand.
- The idle screen is **density-inverted**: controls crowd the top third, then a
  dead void below ROLL. The void belongs *above* the controls, in the stage.
- **CUT button size is user-adjustable** (the owner's explicit request,
  2026-08-15). A Settings row, a scale factor, persisted like the theme. **The
  hard constraint: `RollingScreen`'s written contract that CUT is never off
  screen must hold at every size**, including the largest, with the keyboard up,
  on the smallest safe area. Test the corner, not the default.
- Never audio feedback. This phone sits next to a live sound recorder; a
  confirmation tick is a ruined take. `navigator.vibrate(10)` on ROLL/CUT/MARK IN
  only, guarded, silent no-op on iOS.

---

## 10. Protect — a redesign that destroys these has failed

- The **semantic token architecture**. Rebuild happens *inside* it.
- **Light-first, measured contrast floors.** They win every tie, including
  against this document.
- **Full-screen REC state tinting**, including the status bar. Peripheral-vision
  state awareness. Night's grade is already excellent.
- **One-thumb ROLL/CUT sizing** and the hardware-key metaphor. Refine finish
  only.
- The **after-cut CLIP / SHOT / LENGTH triptych** — the best moment in the app.
- The **clapper stripe** as signature — but spent **once per surface**, not six
  times. Used everywhere it is texture; used once it is brand.
- The **copywriting voice**. The problem was always dosage, never tone.
- **Real iOS patterns already present**: grouped lists, sheet grabbers, large
  titles that shrink, tabular numerals, the 44px floor with hit-area expansion.

---

## 11. Verification

Unchanged and non-negotiable: build, clear SW + caches, **wait ~2s, navigate as
a separate step**, assert the loaded bundle hash against `dist/index.html`
before judging anything.

**The contrast auditor must be committed to the repo.** The material lens
searched and could not find it in the checkout; it currently lives in an agent's
scratch space, and one earlier version was pointed at a dead worktree comparing a
stale `dist` to itself — it could return clean on a tree nobody was running.
Every glass decision now depends on it. Commit it, point it at the real repo,
and run it against the frames the spec names: tray mid-scroll over thumbnails
and over signal colours, `.ltop`/`.topbar` scrolled on every tab, `.sheet__head`
scrolled.

**Measure against the composited backdrop, never the flat token.** The worst
case is a saturated chip or a REC dot scrolling directly under tray text.

**And the bar none of this clears from here:** a real phone, outdoors, at full
brightness. `backdrop-filter` on real iOS Safari remains unverified. Nothing in
this document is proven until it is looked at on the device it was written for.
