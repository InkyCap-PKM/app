# Pill System — Visual Editor Reference

> **Audience:** developers contributing to InkyCap's visual editor.
> **Status:** living spec. Update this file whenever pill behavior changes.

## What is the pill system?

In InkyCap's visual editor, the **pill** (a small chip prefixed with a circled `#`) is the universal affordance for surfacing Typst function calls that aren't in the simple direct-formatting set (bold `*…*`, italic `_…_`, headings, lists). Every other Typst call — `#callout[…]`, `#image(…)`, `#verse[…]`, `#strike[…]`, etc. — is rendered with its visual representation plus a pill that lets the user inspect, edit, or remove the call without dropping into raw source.

The pill exists because the visual editor is a CodeMirror 6 decoration layer over live Typst source (Tier 1 — see [CLAUDE.md](../../../CLAUDE.md#tier-1-visual-editor-codemirror-live-preview)). The source is always Typst; the pill makes that source manageable for users who don't want to edit function calls by hand. Less-Typst-savvy users get a graphical control; power users get a quick path to raw source. Both paths route through the same chip.

## Pill kinds

There are three kinds. They are a **behavioural taxonomy**, not a declared type — a function's kind is determined by which set/branch handles it in `handleFuncCall()` (see R10), not by a `kind` field. Every pill fits one of them.

| Kind | Where the pill sits | Visibility | Examples |
|---|---|---|---|
| **inline** | Inline in source flow, alongside formatted content | Shown when the cursor is on the call's line; hidden when cursor leaves | `strike`, `highlight`, `emph`, `strong`, `underline`, `overline`, `sub`, `super`, inline `quote`, `cite`, `task`, `due`, generic `#fn[…]` |
| **block-row** | A row of its own, above the rendered block | Shown when the cursor is on the call's line; hidden when cursor leaves | `image`, `video`, `audio`, `callout`, block `quote`, `annotation` |
| **embedded** | Part of a permanent widget's chrome (e.g. corner of a canvas) | Always visible — the pill belongs to the widget, not to the cursor | `verse`, `bibliography` |

`line` is a special inline case: it renders as an `<hr>` when the cursor is away and surfaces a pill (`FuncChipWidget`) on its line. Interactive functions (`wikilink`, `tag`, `link`, `suggestion`), `table`, and `footnote` are full widgets with **no pill** (see "When NOT to add a pill").

## Current state — pertinent fields

This table is the audit reference. Use it to verify any change preserves the intended behavior of every pill.

| Pill / function | Layout | When pill **shown** | When pill **hidden** | Collapse on cursor-leave | Click action | Curated options (R7) | Content visible w/ pill |
|---|---|---|---|---|---|---|---|
| `strike`, `highlight`, `emph`, `strong`, `underline`, `overline`, `sub`, `super` | inline | cursor on line | cursor away | yes | simple → edit source; else menu | only `highlight` (color) | yes (formatted, R12) |
| inline `quote` | inline | cursor on line | cursor away | yes | simple → edit source; else menu | style, attribution | yes (R12) |
| `cite` | inline (badge + pill) | cursor on line | cursor away | yes | simple → edit source; else menu | citation form | citation badge |
| `task`, `due` | inline (widget + pill) | cursor on line | cursor away | yes | simple → edit source; else menu | `task`: body/due/done · `due`: date/label | widget |
| `sym` | inline | cursor on line | cursor away | yes | simple → edit source; else menu | symbol name | rendered glyph |
| Generic fallback `#fn[…]` / `#fn(…)` | inline | cursor on line | cursor away | yes | simple → edit source; else menu | generic named-args (R10) | yes |
| `image` | pill overlaid on the block's top-left corner | cursor on line | cursor away | yes | simple → edit source; else menu | file, alt, width, align | yes (rendered block) |
| `video`, `audio` | pill overlaid on the block's top-left corner | cursor on line | cursor away | yes | simple → edit source; else menu | generic named-args | yes (player) |
| `callout` | pill inside the heading row of the in-place edit frame | cursor on line | cursor away | yes | click pill → expand source | kind | body editable in place |
| block `quote` | pill inline at the start of the first body line | cursor on line | cursor away | yes | click pill → expand source | style, attribution | body editable in place |
| `annotation` | pill inside the rendered block's heading row | cursor on line | cursor away | yes | simple → edit source; else menu | generic named-args | rendered widget |
| `line` (HR) | pill overlaid on the rule's left end | cursor on line | cursor away | n/a | simple → edit source; else menu | length, stroke | yes (the rule stays) |
| `figure` | inline wrapper | cursor on line | cursor away | yes | simple → edit source; else menu | caption | wrapped content |
| `align` | inline wrapper | cursor on line | cursor away | yes | simple → edit source; else menu | left/center/right | wrapped content |
| `csv` | inline | cursor on line | cursor away | yes | simple → edit source; else menu | file, delimiter, row-type | call label |
| `verse` | embedded | always | never | no | open menu (no edit-source) | options live on widget | yes (contentEditable canvas) |
| `bibliography` | embedded | always | never | no | open menu (no edit-source) | none | path label only |
| `tag`, `wikilink`, `link`, `suggestion` | interactive widget | n/a (not a pill) | n/a | n/a | semantic widget interaction | n/a | n/a |
| `footnote` | widget (not a pill) | n/a | n/a | n/a | tooltip-only | n/a | hidden in title attr |
| `table` | block widget (not a pill) | n/a | n/a | n/a | full editor | n/a | full |

`#align(left|center|right)[#image(…)]` is a special case: it renders as the **image** block widget with the alignment applied, not a generic align pill.

## Consistency rules (R1–R12)

These are normative. Every pill — current and future — must satisfy them. Deviations require an explicit, documented exception (and a comment at the call site explaining why, per CLAUDE.md's Typst-first reasoning convention).

### R1 — Single visual identity, single size

All pills render the same chip DOM (`<button class="cm-typst-pill">` with hash-circle + label) at the **same size**, built by the single `buildPillButton()` factory in [pill.ts](../../../src/editor/typst-decorations/pill.ts). There is no compact variant — identical sizing is the consistency rule.

### R2 — Hover + focus state required

Every pill brightens its border and hash-circle on `:hover` and `:focus-visible`. A pill that doesn't visibly respond to a mouse or keyboard is broken.

### R3 — Keyboard accessible

The pill is a real `<button type="button">`, in tab order. Enter/Space triggers the same action as left-click. Escape closes any open menu.

### R4 — Predictable collapse policy

- **Inline / block-row pills** auto-collapse when the cursor leaves the function's line.
- **Embedded pills** (verse, bibliography) never collapse — the pill is part of the widget's chrome, not an in-flow toggle.

This is the only allowed split. A new pill's handling in `handleFuncCall()` (R10) determines its collapse behavior.

### R5 — Click model: low-friction primary action, menu always reachable

- **Left-click on a simple pill** = enter inline source-edit mode directly (`runEditSource`). "Simple" is the R8 classifier. Most everyday pills qualify.
- **Left-click on a complex pill** = open the menu (R6) instead, since inline editing isn't safe / readable for multi-line or deeply nested calls.
- **Right-click (anywhere)** = always opens the menu. The universal escape hatch for options, copy, delete, etc.
- **Enter / Space** = same as left-click.
- **Escape** = closes any open menu and returns focus to the pill.

The routing lives in `buildPillButton()`'s click handler in [pill.ts](../../../src/editor/typst-decorations/pill.ts): it expands when `allowEditSource !== false` **and** (`alwaysExpandOnClick === true` **or** `isSimpleCall(...)`), else opens the menu.

Verse and bibliography (embedded pills) set `allowEditSource: false` on their `PillModel`: their canvas IS the editor, so left-click opens the menu directly — there's no inline-source mode for them. (Verse's alignment lives in the menu, not a bespoke popover.)

### R6 — Pill menu: option sections + source + universal

Every pill opens the same menu via `openPillMenu()`. Sections are assembled in order and a separator is drawn between non-empty ones:

```
┌─────────────────────────────────┐
│  ‹widget-specific options›      │  ← optionSections (R7), if any
│  ─────────────                  │
│  Edit source       (conditional)│  ← source section (R8)
│  Open in visual editor          │
│  Open in source editor          │
│  ─────────────                  │
│  Copy                           │  ← universal section
│  Duplicate                      │
│  Delete                         │
└─────────────────────────────────┘
```

The source and universal sections are built by `buildSourceSection()` / `buildUniversalSection()` in pill.ts; "Edit source" is suppressed when `allowEditSource === false` or the call is complex (R8).

### R7 — Widget-specific options live inside the menu

Options are inline form controls in the menu DOM (radio groups, text inputs). Mutations rewrite only the targeted argument (R11). The menu stays open while the user edits a field, and closes on Escape or outside-click.

The curated option builders live in [pill-options.ts](../../../src/editor/typst-decorations/pill-options.ts):

| Pill | Builder | Options inside menu |
|---|---|---|
| `callout` | `calloutOptions` | Kind: note / warning / important / tip / quote |
| `quote` | `quoteOptions` | Style: block / inline; Attribution |
| `image` | `imageOptions` | File, alt text, width (e.g. `80%`, `400px`), align: left / center / right |
| `line` | `lineOptions` | Length, stroke preset |
| `highlight` | `highlightOptions` | Color palette |
| `csv` | `csvOptions` | File, delimiter, row-type |
| `align` | `alignOptions` | left / center / right |
| `figure` | `figureOptions` | Caption |
| `cite` | `citeOptions` | Citation form (and convert `@key` shorthand → call) |
| `task` | `taskOptions` | Body, due date, done toggle |
| `due` | `dueOptions` | Date, description label |
| `sym` | `symOptions` | Symbol name |

`verse` is intentionally absent — its options live on the `VerseWidget` itself. Any function **not** in this registry falls back to `genericArgsOptions()`, which surfaces whatever named arguments the user typed as editable fields (and shows no parameter section when there are none).

### R8 — "Edit source" vs "Open in source editor" — the simple/complex rule

Whether to allow inline raw-source expansion depends on call complexity, not function name. A call is **simple** when `isSimpleCall(view, from, to)` holds — **all** of:

- ≤ 120 characters,
- single line (no `\n`),
- at most one nested `#` (one level of nested call).

A simple call offers **"Edit source"** (inline Typst expansion). A complex one offers only **"Open in source editor"**, which switches to source mode and selects the call's range — better for tables, multi-paragraph callouts, long configs. So `#image("a.png")` is simple; `#image("a.png", width: 80%, alt: "a long description …")` is complex.

### R9 — One menu helper, one model

`openPillMenu(anchor, view, model)` builds the DOM in R6. The model is:

```ts
interface PillModel {
  funcName: string;
  callFrom: number;          // call's source start
  callTo: number;            // call's source end
  optionSections?: PillMenuSection[];
  onEditSource?: (view: EditorView) => void;  // overrides the default expand
  allowEditSource?: boolean;                  // false ⇒ no inline edit (verse, bib)
  alwaysExpandOnClick?: boolean;              // force expand regardless of R8
}
```

Simplicity is **computed at click time** via `isSimpleCall(callFrom, callTo)` — it is not stored on the model. One implementation; every pill consumes it.

### R10 — Where a pill's kind and options are decided

There is **no single `PILL_REGISTRY`**. A pill's behavior comes from two places:

1. **Kind / rendering** — the `handleFuncCall()` switch in [visual-plugin.ts](../../../src/editor/typst-decorations/visual-plugin.ts), gated by three sets:
   - `INTERACTIVE_FUNCS` = `wikilink`, `tag`, `link`, `suggestion` — full widgets, no pill.
   - `BLOCK_WIDGET_FUNCS` = `image`, `video`, `audio` — block widget that gains an overlaid pill on the cursor line. `annotation` (and the aligned-image special case) share this branch; `callout` and block `quote` have their own in-place edit branches (see R13).
   - `BLOCK_FUNCS` = `callout`, `quote`, `verse`, `note`, `bibliography`, `table` — block-level rendering.
   - Anything else with `#fn[…]` / `#fn(…)` falls through to the generic inline `FuncPillWidget`.
2. **Menu options** — the `REGISTRY` map in [pill-options.ts](../../../src/editor/typst-decorations/pill-options.ts) maps a function name to a `PillOptionsBuilder`; `getPillOptions()` returns its sections, or `genericArgsOptions()` for anything unlisted (see R7).

So **adding a pill with curated options** = add a `*Options(view, callFrom, callTo)` builder and one `REGISTRY` entry; **changing how a function renders** = adjust its branch/set in `handleFuncCall()`. Common inline `#fn[…]` calls need *neither* — they get a generic pill and generic-args menu for free.

### R11 — Source round-trip is preserved

Per [CLAUDE.md](../../../CLAUDE.md), source ↔ visual identity is a load-bearing invariant. Every option mutation (alt text, color, alignment, kind, etc.) edits only the targeted argument, preserving surrounding whitespace and untouched arguments byte-for-byte. Tests cover round-trip for each option type.

### R12 — Inline content-bracket pills keep their body directly editable

Inline content-bracket calls (`#fn[content]` where the body is short, single-paragraph text in flow) must let the user type into `content` *without* dropping into "Edit source" mode. The pill chrome renders alongside the content; the `[` and `]` stay hidden when the cursor is off the call; the inner text is plain editable Typst source the whole time. Highlight is the canonical implementation: typing inside `#highlight[…]` just edits the text and the background stays applied.

Applies to: `strike`, `highlight`, `emph`, `strong`, `underline`, `overline`, `sub`, `super`, and inline `quote`.

**Block content-bracket pills (`callout`, block `quote`) follow a block form of R12.** The body is editable in place, but as whole lines rather than a mid-paragraph span:

- **Cursor away:** one rendered widget (kind colour, heading, attribution, …). The widget is the visual.
- **Cursor on line:** the opener `#fn(...)[` and closer `]` are hidden and the body lines are real editable source carrying the block's bar, inset and tint. A callout's opener becomes a heading row (pill + label) at the top of the first body line; a quote's opener becomes an inline pill, and a quote with an attribution shows the attribution row under the body just as the widget does.
- **Click the pill (or "Edit source"):** reveals the raw call so the arguments the body can't reach (kind, title, attribution) can be edited. Re-collapses once the cursor leaves.

The kind (callout), style/attribution (quote), and other arguments live in the pill menu (R7) so most edits don't require source expansion.

### R13 — A block keeps its height between its rendered and edit states

Every block that swaps between a rendered widget and an in-place edit state (code block, block quote, callout) must measure exactly the same in both, otherwise moving the caret into or out of it shifts everything below and the writer loses their place. The shared vertical measurements (outer gap, inner padding, line height, header/footer rows) are declared once as `--quote-*`, `--callout-*` and `--codeblock-*` variables on `.cm-content` in [visual-theme.ts](../../../src/editor/typst-decorations/visual-theme.ts) and read by both the widget rules and the edit-line rules; never restate one of those numbers inline. The row accounting (which line breaks are hidden with the brackets, which fence line is the header or footer) lives in `blockEditLayout`, `parseRawBlock` and `rawBlockEditLineClasses` in visual-plugin.ts and is covered by [block-edit-layout.test.ts](../../../src/editor/typst-decorations/block-edit-layout.test.ts).

Every such widget's root also carries `.cm-typst-block-row` (an inline-block filling the line). CodeMirror puts a zero-width placeholder on each side of an inline widget; with a `display: block` root those placeholders form empty rows above and below the widget that the edit state does not have. The incremental rebuild in `expandRangesToBlockElements` widens a dirty range to the whole call or fenced raw node so no edit-state line styling is left behind when the widget returns.

Display math has no block state at all: `.cm-typst-math-display` is a colour, font and background tint only, and an equation with the caret inside gets no mark. Both follow from the same fact: a `$` typed above other equations pairs with the next equation's opener, so until it is closed the node spans lines of prose. A layout-affecting property there moves the text on every keystroke (issue #1), and a mark painted under the caret would tint everything below it. Because nothing is painted for that node and the incremental rebuild only redraws the edited lines, the content below keeps its styling until the equation closes, even though the parser sees it as math for that moment.

One sharp edge for any always-on line styling: CodeMirror measures each line's box but not the vertical margins between top-level lines, so a `margin-top`/`margin-bottom` on a line decoration shifts where clicks and arrow-key moves land, and the error grows with every such line above the caret. The edit-line margins on quotes, callouts and code blocks carry this drift for the one block being edited; a frame applied to every block of a kind must use padding for its outer gap instead. One sharp edge for any frame that is always on: CodeMirror measures each line's box but not the vertical margins between top-level lines, so a `margin-top`/`margin-bottom` on a line decoration shifts where clicks and arrow-key moves land, and the error grows with every such line above the caret. The equation frame therefore uses padding for its outer gap and paints the frame with a `::before` pseudo-element inset by that gap. The edit-line margins on quotes, callouts and code blocks carry the same drift, but only for the one block being edited.

Blocks that only gain a pill on the cursor line (`image`, `video`, `audio`, `annotation`, `line`) place it inside or over their existing box (overlay or heading row) rather than in a row above it, for the same reason.

Call-only forms with no body bracket (`image`, `line`, `figure`, `cite`, `task`, `due`, …) should expose every meaningful argument as a menu input (R7) so "Edit source" stays a rare path. Image's positional `path` counts: it's a menu input, not a hidden field. The friction R12 fights ("click pill → click Edit source → edit") usually means a missing menu option — reach for R7 before live-edit.

## Where the code lives

- [src/editor/typst-decorations/pill.ts](../../../src/editor/typst-decorations/pill.ts) — the heart: `buildPillButton()` (the `cm-typst-pill` DOM + click routing), `PillModel`, `openPillMenu()`, `buildSourceSection`/`buildUniversalSection`, `isSimpleCall()`, `runEditSource()`, and the `PillChip` convenience widget.
- [src/editor/typst-decorations/pill-options.ts](../../../src/editor/typst-decorations/pill-options.ts) — the options `REGISTRY`, `getPillOptions()`, `genericArgsOptions()`, and every curated `*Options` builder.
- [src/editor/typst-decorations/visual-plugin.ts](../../../src/editor/typst-decorations/visual-plugin.ts) — `handleFuncCall()` (the rendering switch), the `BLOCK_FUNCS` / `INTERACTIVE_FUNCS` / `BLOCK_WIDGET_FUNCS` sets, the `expandedFuncField` StateField, and the pill CSS.
- [src/editor/typst-decorations/visual-widgets.ts](../../../src/editor/typst-decorations/visual-widgets.ts) — `FuncPillWidget` (and `FuncChipWidget`), the inline/block-row pill widget hosts.
- [src/editor/typst-decorations/widgets.ts](../../../src/editor/typst-decorations/widgets.ts) — `makeBlockPill` / `makeBlockPillOverlay`, the block-widget hosts (`VerseWidget`, image/callout/quote/media widgets, `BibliographyBlockWidget`), and the edit-state row widgets (`CalloutHeadRowWidget`, `BlockquoteAttributionRowWidget`).
- [src/editor/typst-decorations/effects.ts](../../../src/editor/typst-decorations/effects.ts) — the `expandFunc` StateEffect (consumed by `expandedFuncField` in visual-plugin.ts).
- [src/editor/typst-decorations/pill-boundary-nav.ts](../../../src/editor/typst-decorations/pill-boundary-nav.ts) — cursor navigation across pill boundaries.
- [inkycap-notebox/lib.typ](../../../inkycap-notebox/lib.typ) — notebox-defined functions that pills target (bundled version-less; see [extending/notebox-format.md](../extending/notebox-format.md)).

## Adding a new pill — checklist

1. Decide the kind. If it's a common inline `#fn[…]` call, the generic `FuncPillWidget` path already covers it — no switch change needed. Otherwise add/extend its branch in `handleFuncCall()` (and the relevant set).
2. If the pill has curated options, write a `*Options(view, callFrom, callTo)` builder returning `PillMenuSection[]` and add it to the `REGISTRY` in pill-options.ts. (No builder ⇒ it gets the generic named-args menu automatically.)
3. Each option's mutation must use the shared single-argument-rewrite helper (preserves whitespace per R11).
4. Add a unit test for source round-trip with each option exercised.
5. Update the comparison table in this document.
6. If the pill warrants user-facing documentation, add an entry under [`documentation/user/`](../../user/).

## When NOT to add a pill

- If the function is part of the **direct-formatting set** (`*bold*`, `_italic_`, `= heading`, `- bullet`, `+ ordered`, `$math$`) — those are handled by their own decorations, not pills.
- If the function is **interactive** (`wikilink`, `tag`, `link`, `suggestion`) — those are full semantic widgets without pill collapse.
- If it has its own dedicated editing surface (`table`, `footnote`) — a pill would just get in the way.
- If the function is so rare that a raw-source representation is fine — the goal is helping common Typst calls feel approachable, not pill-ifying everything.
