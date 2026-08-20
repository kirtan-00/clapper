# Clapper: the client's green

Direction from the client, 2026-08-20: a specimen page built in four fixed
values, approved for the whole app, "from int ui to ext ui dark and lite
theme."

```
#E2F0CC   pale green    light and soft base, care, lightness, comfort
#8BC53D   vibrant green vitality and energy
#012F13   deep green    security, stability, credibility
#011207   near-black green
```

**These four are final.** Every colour in this pass is either one of them
unmixed, or a tint/shade mixed between them (or, for the two places that
needed something darker than the darkest of the four, mixed toward true
black the same way `--key-shadow` already was). No fifth hue was invented
anywhere the four could be made to work; the two places that measure short
of 4.5:1 are reported below rather than patched with a substitute colour.

This overrules nothing structural. `--rec` (red) and `--brass` (GOLD) are
untouched — they are signals the four colours were never meant to replace,
and the brief that authorised this repaint says explicitly that both must
stay distinguishable from the new green in both themes. They do.

---

## The approved surface tables

**Light**

| role | value |
|---|---|
| page ground | `#F2F8E6` — a wash lighter than the pale green itself |
| raised surface (wells, inputs) | `#E2F0CC` — the pale green, spent as a surface |
| card / sheet | `#FFFFFF` — unchanged from the ivory theme; a card was already the brightest thing on the page |
| hairline / edge | `#C9DDAE` |
| text primary | `#011207` |
| text secondary | `#3D5442` |
| text tertiary | `#6B7F6A` |
| accent fill | `#8BC53D` |
| accent as TYPE | `#012F13` |
| ink ON the accent | `#011207` |

**Dark**

| role | value |
|---|---|
| page ground | `#011207` |
| raised surface / card | `#012F13` |
| recessed / well | `#04220E` |
| hairline / edge | `#0C3D1C` |
| text primary | `#E2F0CC` |
| text secondary | `#9DB59A` |
| text tertiary | `#6F8570` |
| accent fill | `#8BC53D` |
| accent as TYPE | `#8BC53D` — the split collapses; bright IS legible on near-black, same idiom `--go-text` already used |
| ink ON the accent | `#011207` |

---

## Why `--ink` takes the near-black green, not the deep one

The obvious first read is `--ink: #012F13` (the "text" colour by name).
Measured against the approved specimen, `--ink: #011207` is the pairing
that is actually drawn: 17.73:1 on the wash vs 12.40:1 for the deep green,
and it leaves `#012F13` free to do the job the deep green is FOR across
this system — the accent's own deep form (`--m-accent-text`, `--m-accent-
deep`), never a second primary-ink candidate.

## Why `--m-mass` takes the near-black green, not the deep one

The client's own mapping instruction sends "dark ground" to `--m-mass`.
Measured effect: on night, `--paper` and `--m-mass` are now the identical
value (`#011207`) rather than one step apart the way round 3 shipped them.
That is not a regression — CUT was always meant to read as the app's own
darkest surface, not a second material bolted onto it — but it does mean
CUT separates from the page by its `--m-raised` face and its shadow now,
not by a base-colour gap. Confirmed by eye in both themes' screenshots.

## `--go` is deliberately not one of the four

Rolling-ready used to be spring green, `#38D178` (hue 145°) — almost
exactly on top of the identity's own deep green (`#012F13`, hue 143.5°).
Once the brand identity IS green, a state token sharing that hue stops
being a second fact: a project's clip filename was rendering in the
brand's own `rgb(56,209,120)` before this pass, because `--go-text`
collapses to `--go` on night and nothing about the render said "this is a
state."

`--go` moves to a teal, `#29C9BA` (hue ~174°) — far enough from `#8BC53D`
(hue 86°) and `#012F13` (hue 143.5°) to read as its own signal in both
themes, and far enough from `--sound` (`#4F9FD1`, hue 203°) that the two
do not merge either.

The token itself was also swept for misuse: several rules painted a clip
filename, a clip number, or a plain count with `--go-text` because green
happened to be the app's only "positive" colour at hand. None of those are
"rolling ready." Moved to `--chalk` / `--chalk-dim`. What legitimately
keeps `--go-text`: done, on, armed, focus, active tab, the outcome-copy
"good" message — states, not data.

---

## Measured contrast (light, on the wash `#F2F8E6` unless noted)

| pair | ratio |
|---|---|
| `--ink` `#011207` on page ground | 17.73:1 |
| `--ink` on card `#FFFFFF` | 19.25:1 |
| `--ink-dim` `#3D5442` on page ground | 7.60:1 |
| `--ink-faint` `#6B7F6A` on page ground | 3.97:1 (non-essential only, by design) |
| `--m-accent-text` `#012F13` on page ground | 13.65:1 |
| `--m-accent-ink` `#011207` on `--m-accent` `#8BC53D` | 9.31:1 |
| `--go-text` `#176F66` on page ground | 5.45:1 |

## Measured contrast (dark, on the ground `#011207` unless noted)

| pair | ratio |
|---|---|
| `--ink` `#E2F0CC` on page ground | 16.11:1 |
| `--ink` on `--m-mass`/card `#012F13` | 12.40:1 |
| `--ink-dim` `#9DB59A` on page ground | 8.72:1 |
| `--m-accent` `#8BC53D` as TYPE on page ground | 9.31:1 |
| `--m-accent` as TYPE on `--m-mass` | 7.16:1 |
| `--go` `#29C9BA` on page ground | 9.31:1 |
| `--rec` (`--rec-text` collapsed) `#FF3B30` on page ground | 5.43:1 |
| `--rec` on `--m-mass`/the deep-green card | **4.18:1 — reported, not fixed. See below.** |
| `--m-rec` `#FF453A` on `--m-mass`/the deep-green card | **4.35:1 — same finding, the ring/dot token.** |

### The one pair that falls short

`--rec-text` collapses to bright `--rec` on night, the same idiom every
signal uses, on the assumption that night's ground is near-black enough to
carry it. That holds against `--paper` (5.43:1) but not against the
MACHINED MASS card, which is now the deep green rather than a darker
near-black — measured at 4.18:1 for `--rec-text` and 4.35:1 for `--m-rec`,
both clearing the 3:1 non-text/component floor but short of 4.5:1 for
text. This is a real, measured regression from the old mass (`#101714`),
which cleared roughly 5.8:1 for the same pair.

`#012F13` is one of the four fixed colours and cannot move. The only
components this affects are small-caps danger labels drawn directly on a
mass card at night (`.mclip__tool--danger` and the base `.btn--danger`
family, where the card behind them is `--surface`/`--m-mass` rather than
the page). If this needs to clear 4.5:1, the fix is a scoped brighter red
for that one label at night, not a change to the four-colour palette —
left for a decision rather than invented here.

---

## What stayed put

`--rec` and `--brass` are unchanged hexes. `--sound` is unchanged. All
three were re-measured against every new ground and card in this pass and
remain distinguishable from the green identity and from each other in
both themes.

The clapper stripe (`--stripe`) stays black and white, unthemed, on
purpose — a clapper stick is black and white on every set in the world,
brand palette or not.
