# Pill System — Visual Editor Reference

> **Audience:** developers contributing to InkyCap's visual editor.
> **Status:** living spec. Update this file whenever pill behavior changes.

## What is the pill system?

In InkyCap's visual editor, the **pill** (a small chip prefixed with a circled `#`) is the universal affordance for surfacing Typst function calls that aren't in the simple direct-formatting set (bold `*…*`, italic `_…_`, headings, lists). Every other Typst call — `#callout[…]`, `#image(…)`, `#verse[…]`, `#strike[…]`, etc. — is rendered with its visual representation plus a pill that lets the user inspect, edit, or remove the call without dropping into raw source.

The pill exists because the visual editor is a CodeMirror 6 decoration layer over live Typst source (Tier 1 — see [CLAUDE.md](../../../CLAUDE.md#tier-1-visual-editor-codemirror-live-preview)). The source is always Typst; the pill makes that source manageable for users who don't want to edit function calls by hand. Less-Typst-savvy users get a graphical control; power users get a quick path to raw source. Both paths route through the same chip.

## Pill kinds

There are exactly three kinds. Every new pill must fit one of them.

| Kind | Where the pill sits | Visibility | Examples |
|---|---|---|---|
| **inline** | Inline in source flow, alongside formatted content | Shown when the cursor is on the call's line; hidden when cursor leaves | `strike`, `highlight`, `emph`, `strong`, `underline`, `sub`, `super`, `hide`, `lorem`, `linebreak`, `pagebreak`, `line` |
| **block-row** | A row of its own, above the rendered block | Shown when the cursor is on the call's line; hidden when cursor leaves | `image`, `embed`, `callout`, `quote`/`blockquote`, `figure`, `align`, `box`, `rect` |
| **embedded** | Part of a permanent widget's chrome (e.g. corner of a canvas) | Always visible — the pill belongs to the widget, not to the cursor | `verse`, `bibliography` |

## Current state — pertinent fields

This table is the audit reference. Use it to verify any change preserves the intended behavior of every pill.

| Pill / function | Layout | When pill **shown** | When pill **hidden** | Collapse on cursor-leave | Click action | Hover state | Keyboard focus | Options menu | Content visible w/ pill |
|---|---|---|---|---|---|---|---|---|---|
| `strike`, `highlight`, `emph`, `strong` | inline | cursor on line | cursor away | yes | open super-menu | yes | yes | per-pill (R7) | yes (formatted) |
| Generic fallback `#fn[…]` | inline | cursor on line | cursor away | yes | open super-menu | yes | yes | none | yes |
| `image`, `embed` | block-row above | cursor on line | cursor away | yes | open super-menu | yes | yes | per-pill (R7) | yes (rendered block) |
| `callout` | block-row above rendered block; click pill to expand source | cursor on line | cursor away | yes | simple → expand source for editing; complex → super-menu | yes | yes | kind, title | rendered widget |
| `quote` / `blockquote` | block-row above rendered block; click pill to expand source | cursor on line | cursor away | yes | simple → expand source for editing; complex → super-menu | yes | yes | style, attribution | rendered widget |
| `bibliography` | embedded | always | never | no | open super-menu | yes | yes | none | path label only |
| `line` (HR) | inline | cursor on line | cursor away (replaced by HR) | n/a | open super-menu | yes | yes | length, stroke | no — pill **is** the affordance |
| `verse` | embedded | always | never | no | open super-menu | yes | yes | alignment | yes (contentEditable canvas) |
| `tag`, `wikilink`, `link` | inline widget | n/a (not a pill) | n/a | n/a | semantic widget interaction | widget-specific | varies | n/a | n/a |
| `footnote` | inline `<sup>` (not a pill) | n/a | n/a | n/a | tooltip-only | n/a | no | n/a | hidden in title attr |
| `table` | block widget (not a pill) | n/a | n/a | n/a | full editor | cell-level | yes (cells) | n/a | full |

> Pre-refactor reality differs from this table in three ways: most pills had no hover/focus state, no keyboard accessibility, and no options menu. Verse alone had a popover, and its left-click opened that popover instead of the universal menu. The table above describes the **target** state after applying R1–R11 below.

## Consistency rules (R1–R11)

These are normative. Every pill — current and future — must satisfy them. Deviations require an explicit, documented exception (and a comment at the call site explaining why, per CLAUDE.md's Typst-first reasoning convention).

### R1 — Single visual identity, single size

All pills render the same chip DOM (`<button class="cm-typst-pill">` with hash-circle + label) at the **same size**. The original verse pill was smaller (0.7em font, smaller hash-circle); that compact variant is dropped. There is no functional reason for verse to be smaller — the divergence was an artifact of verse being implemented later as a self-contained widget. Identical sizing is the consistency rule.

### R2 — Hover + focus state required

Every pill brightens its border and hash-circle on `:hover` and `:focus-visible`. A pill that doesn't visibly respond to a mouse or keyboard is broken.

### R3 — Keyboard accessible

The pill is a real `<button type="button">`, in tab order. Enter/Space triggers the same action as left-click. Escape closes any open menu.

### R4 — Predictable collapse policy

- **Inline / block-row pills** auto-collapse when the cursor leaves the function's line.
- **Embedded pills** (verse, bibliography) never collapse — the pill is part of the widget's chrome, not an in-flow toggle.

This is the only allowed split. New pills must explicitly declare their kind (R10), which determines collapse behavior.

### R5 — Click model: low-friction primary action, menu always reachable

The earlier "left-click always opens the menu" rule produced too much friction for the common case of nudging a single argument: users had to click the pill, then click "Edit source", then make their edit. The new rule:

- **Left-click on a simple pill** = enter inline source-edit mode directly (the same destination "Edit source" used to take you to). "Simple" is the R8 classifier: single-line, ≤120 chars, ≤1 nested call. Most everyday pills qualify.
- **Left-click on a complex pill** = fall back to opening the super-menu (R6), since inline editing isn't safe / readable for multi-line or deeply nested calls.
- **Right-click (anywhere)** = always opens the super-menu. This is the universal escape hatch for renaming the kind, deleting the call, copying it, etc. — discoverability is preserved across every pill regardless of complexity.
- **Enter / Space** = same as left-click (so keyboard users get the same low-friction primary action).
- **Escape** = closes any open menu and returns focus to the pill.

Verse and bibliography (embedded pills) override the simple-pill default: their canvas IS the editor, so left-click opens the menu directly — there's no inline-source mode for them. They set `allowEditSource: false` on their `PillModel`.

This means the verse pill's previous "left-click opens alignment popover" behavior remains removed — alignment lives inside the menu via right-click like every other pill's options.

### R6 — Super-context-menu: one menu, three sections

Every pill exposes the same menu. Sections appear only when applicable.

```
┌─────────────────────────────────┐
│  ‹widget-specific options›      │  ← Section 1 (R7)
│  ─────────────                  │
│  Edit source       (conditional)│  ← Section 2 (R8)
│  Open in source editor          │
│  ─────────────                  │
│  Copy                           │  ← Section 3 (universal)
│  Duplicate                      │
│  Delete                         │
└─────────────────────────────────┘
```

### R7 — Widget-specific options live inside the menu

Options are inline form controls in the menu DOM (radio groups, text inputs). Mutations rewrite only the targeted argument (R11). The menu stays open while the user edits a field, and closes on Escape or outside-click.

| Pill | Options inside menu |
|---|---|
| `verse` | Alignment: ◉ left ○ center ○ right |
| `image` | Alt text: `[__________]`, Width: `[____]` (free-form, accepts `%` or `px`/`pt`/`em` — e.g. `80%`, `400px`), Align: left / center / right |
| `highlight` | Color: ◉ yellow / green / blue / pink / orange (default yellow) |
| `callout` | Kind: ◉ note / warning / important / tip / quote |
| `quote` | Style: block / inline; Attribution: `[__________]` |
| `line` | Length: `[___]`, Stroke: thin / medium / thick |
| `align` | left / center / right / justify |
| `figure` | Caption: `[__________]` |

### R8 — "Edit source" vs "Open in source editor" — the simple/complex rule

Whether to allow inline raw-source expansion in the visual editor depends on call complexity, not on function name. A pill instance is **simple** (and thus inline-expandable) when **all** of the following hold:

- The function call body fits on a single line in source (no embedded `[…]` block content spanning multiple lines).
- Total source length ≤ ~120 characters.
- No nested function calls inside the body (one level deep at most).

A simple call shows **"Edit source"**, which expands raw Typst inline. A complex call shows only **"Open in source editor"**, which switches the view to source mode and selects the call's source range — better for editing tables, multi-paragraph callouts, long bibliography configs, etc.

The classification is computed per-instance from the call source. `#image("a.png")` is simple; `#image("a.png", width: 80%, alt: "a long description …")` is complex.

### R9 — One menu helper

`openPillMenu(anchor, view, model)` builds the DOM described in R6. The model is `{ optionSections, simpleExpand: boolean, sourceRange }`. One implementation; every pill consumes it. This replaces the bespoke verse popover.

### R10 — Pill registration in one place

A single registry map drives all pill rendering and menu construction:

```ts
const PILL_REGISTRY: Record<string, PillSpec> = {
  strike:    { kind: "inline",    options: () => [] },
  highlight: { kind: "inline",    options: highlightOptions },   // color picker
  emph:      { kind: "inline",    options: () => [] },
  strong:    { kind: "inline",    options: () => [] },
  underline: { kind: "inline",    options: () => [] },
  overline:  { kind: "inline",    options: () => [] },
  sub:       { kind: "inline",    options: () => [] },
  super:     { kind: "inline",    options: () => [] },
  hide:      { kind: "inline",    options: () => [] },
  lorem:     { kind: "inline",    options: () => [] },
  linebreak: { kind: "inline",    options: () => [] },
  pagebreak: { kind: "inline",    options: () => [] },
  line:      { kind: "inline",    options: lineOptions },
  image:     { kind: "block-row", options: imageOptions },
  embed:     { kind: "block-row", options: () => [] },
  callout:   { kind: "block-row", options: calloutOptions },
  quote:     { kind: "block-row", options: quoteOptions },
  align:     { kind: "block-row", options: alignOptions },
  figure:    { kind: "block-row", options: figureOptions },
  box:       { kind: "block-row", options: () => [] },
  rect:      { kind: "block-row", options: () => [] },
  verse:     { kind: "embedded",  options: verseOptions },
  bibliography: { kind: "embedded", options: () => [] },
};
```

Adding a new pill = one map entry. Adding options for a pill = one `*Options(view, callNode) => PillMenuSection[]` function.

### R12 — Inline content-bracket pills keep their body directly editable

Inline content-bracket calls (`#fn[content]` where the body is short, single-paragraph text in flow with surrounding prose) must let the user type into `content` *without* dropping into "Edit source" mode. The pill chrome renders alongside the content; the `[` and `]` themselves stay hidden when the cursor is off the call; the inner text is plain editable Typst source the whole time. Highlight is the canonical implementation: typing inside a `#highlight[…]` just edits the text and the yellow background stays applied.

Applies to: `strike`, `highlight`, `emph`, `strong`, `underline`, `overline`, `sub`, `super`, `hide`.

**Block content-bracket pills (`callout`, `quote`) deliberately do NOT follow R12.** An earlier iteration tried to extend live-source-body editing to them and ran into structural problems: per-line CSS decorations dragged trailing text into the styled box, the body's start/end boundary became invisible, and Enter step-out behaviour fought multi-line bodies. The trade between "no mode switch" and "predictable boundaries" tipped the wrong way.

Instead, callout and quote use the **rendered-widget + click-to-edit-source** model:

- **Cursor away:** rendered styled block (kind colour, attribution, etc.). The widget is the visual.
- **Cursor on line:** same rendered block, with the pill row above. The pill is the affordance to edit.
- **Click the pill** (or the simple-pill left-click shortcut, R5): expands the call's source between `[…]` for inline editing, with the rendered widget below for reference. Click again or move the cursor out to collapse.

The kind badge (callout), attribution / style (quote), and other arguments still live in the pill menu (R7) so most edits don't require source expansion at all.

Pills that are call-only forms with no body bracket (`image`, `line`, `pagebreak`, `linebreak`, `lorem`) — for those, every meaningful argument must be exposed as a menu input (R7) so "Edit source" stays a rare path. Image's positional `path` argument counts: it's a menu input, not a hidden field that requires expanding source.

The friction R12 was originally fighting ("I need to click the pill, then click Edit source, then edit") shows up most often as missing menu options. Before reaching for live-edit, try R7: expose the argument the user keeps wanting to change.

### R11 — Source round-trip is preserved

Per [CLAUDE.md](../../../CLAUDE.md), source ↔ visual identity is a load-bearing invariant. Every option mutation (alt text, color, alignment, kind, etc.) edits only the targeted argument, preserving surrounding whitespace and untouched arguments byte-for-byte. Tests cover round-trip for each option type.

## Where the code lives

- [src/editor/typst-decorations/widgets.ts](../../../src/editor/typst-decorations/widgets.ts) — `PillChip` factory, `makeBlockPillRow`, embedded-widget hosts (`VerseWidget`, `BibliographyBlockWidget`).
- [src/editor/typst-decorations/visual-plugin.ts](../../../src/editor/typst-decorations/visual-plugin.ts) — `PILL_REGISTRY`, the decoration switch, `expandFunc` effect, `expandedFuncField`, all pill CSS.
- [src/editor/typst-decorations/effects.ts](../../../src/editor/typst-decorations/effects.ts) — `expandFunc` effect.
- [inkycap-vault/0.1.0/lib.typ](../../../inkycap-vault/0.1.0/lib.typ) — vault-defined functions that pills target.

## Adding a new pill — checklist

1. Add an entry to `PILL_REGISTRY` with the appropriate `kind`.
2. If the pill has widget-specific options, write a `*Options(view, callNode)` function returning `PillMenuSection[]`.
3. Each option's mutation must use the shared single-argument-rewrite helper (preserves whitespace per R11).
4. Add a unit test for source round-trip with each option exercised.
5. Update the comparison table in this document.
6. If the pill warrants user-facing documentation, add an entry under [`documentation/user/`](../../user/).

## When NOT to add a pill

- If the function is part of the **direct-formatting set** (`*bold*`, `_italic_`, `= heading`, `- bullet`, `+ ordered`, `$math$`) — those are handled by their own decorations, not pills.
- If the function is **interactive** (e.g. `wikilink`, `tag`, `link`) — those are full semantic widgets without pill collapse.
- If the function is so rare that a raw-source representation is fine — the goal is helping common Typst calls feel approachable, not pill-ifying everything.
