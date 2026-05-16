# Menu / popup design-system consolidation

**Date:** 2026-05-15
**Goal:** Replace ~20 independently-hardcoded popup styles with two
token-driven surface roles — **popup** and **modal** — plus a real
z-index scale. Distinction is by *element role*, not by where on screen
the element is triggered.

## Decision

- **Popup** — every floating, transient surface: context menus, command
  palette, dropdowns, suggestion/autocomplete popups, the visual-editor
  pill menu, the selection toolbar + its sub-menus. One surface look.
- **Modal** — centered, backdropped, dismiss-to-continue dialogs:
  Settings, Composer, Export, Quick Open, the busy overlay card.
- **Toast** — notifications keep their own surface; only their z-index
  is folded into the scale.

Canonical popup look = the *lighter* of the two clusters that exist
today (already used by `.cm-typst-pill-menu`, `.cm-table-context-menu`,
and `.selection-toolbar`). The heavier `--bg-active` / `0 4px 16px /.4`
cluster is retired.

## Step 1 — Define tokens

Add to the existing theme-independent `:root` block in
[src/styles/themes.css](../../src/styles/themes.css) (around line 12).
Colour tokens reference the per-theme primitives via `var()`, so they
resolve correctly under every theme/palette without per-theme copies.
Geometry tokens are static.

```css
/* Popup surface — floating menus, dropdowns, suggestion popups. */
--popup-bg: var(--bg-primary);
--popup-border-color: var(--border-subtle);
--popup-radius: 6px;
--popup-shadow: 0 4px 12px rgba(0, 0, 0, 0.18);
--popup-padding-block: 4px;          /* vertical padding of the surface */
--popup-item-padding: 5px 12px;      /* a standard action-list row */

/* Modal surface — centered, backdropped dialogs. */
--modal-bg: var(--bg-primary);
--modal-border-color: var(--border-primary);
--modal-radius: 8px;
--modal-shadow: 0 8px 32px rgba(0, 0, 0, 0.3);
--modal-backdrop: rgba(0, 0, 0, 0.45);

/* Stacking order — single source of truth. */
--z-menu: 1000;
--z-modal: 2000;
--z-toast: 3000;   /* above modals so errors surface over dialogs */
```

Optional: dark themes may want a slightly stronger `--popup-shadow`
(e.g. `rgba(0,0,0,0.4)`); add as a one-line override in the
`[data-theme="dark"]` blocks only if it looks weak in testing.

## Step 2 — Migrate popups

Each of these drops its hardcoded background/border/radius/shadow and
references the `--popup-*` tokens; `z-index` → `var(--z-menu)`.

| Element | File | Notes |
|---|---|---|
| `.context-menu` | layout.css ~869 | bg-active→token; shadow .4→.18 |
| `.command-palette` | layout.css ~6843 | |
| `.paste-url-menu` | layout.css ~6898 | |
| `.selection-toolbar` + `__menu` + `__align-popup` | layout.css ~6929 | already on the values; swap literals→tokens |
| `.cm-fmt-toolbar__dropdown` | layout.css ~2736 | radius 8→6; bg-secondary→token |
| `.properties-dropdown` | layout.css ~6011 | surface→tokens; keep its 8px inner content padding |
| `.cm-typst-pill-menu` (+ children) | visual-theme.ts ~453 | theme object; literals→`var(--popup-*)` strings |
| `.cm-table-context-menu` | table-widget.ts ~1248 | inline JS styles→`var(--popup-*)`; **z 99999→`var(--z-menu)`** |
| `.wikilink-suggest` | themes.css ~327 | bg-active→token; shadow .4→.18 |
| `.citation-suggest-preview` | themes.css ~400 | tokens for bg/border/shadow; keep its asymmetric `0 6px 6px 0` radius |
| `.cm-tooltip` / `.cm-tooltip-autocomplete` | typst-editor.ts ~230 | theme object→tokens |

**Judgment point — input-attached dropdowns.** `.settings__font-dropdown`,
`.settings__combobox-dropdown`, `.collection-picker__dropdown`,
`.creation-rules__folder-dropdown`, `.icon-picker__dropdown` currently
use `radius 4` + `--border-input` because they visually continue the
form control they hang off. Recommendation: adopt `--popup-bg` /
`--popup-shadow` / `--popup-border-color` for the surface, but **keep
`--popup-radius` optional here** — leaving radius 4 is defensible since
they read as an extension of a 4px-radius input. Final call to be made
when reviewing this plan.

## Step 3 — Migrate modals

Drop hardcoded surface values; reference `--modal-*`; backdrop →
`var(--modal-backdrop)`; `z-index` → `var(--z-modal)`.

| Element | File |
|---|---|
| `.settings__overlay` / `.settings__panel` | layout.css |
| `.quick-open__overlay` / `.quick-open` | layout.css ~1750 |
| `.composer-modal` | layout.css ~4998 |
| `.export-dialog__backdrop` / `.export-dialog` | layout.css ~7051 |
| `.busy-overlay` / `.busy-overlay__card` | layout.css ~7802 |

## Step 4 — z-index scale

Replace every hardcoded popup/modal/toast `z-index` with the token.
Known offenders to sweep: `.cm-table-context-menu` (99999), toast host
(10000 → `var(--z-toast)`), `.properties-dropdown` (50), Quick Open
(100), `.cm-typst-pill-menu` (1000). Grep `z-index` under `src/` to
catch the rest.

## Step 5 — Action-list item consistency (light touch)

Where a popup is a plain action list (`.context-menu__item`,
`.command-palette__item`, `.selection-toolbar__menu-item`,
`.cm-typst-pill-menu-item`), align row styling to the pill menu's:
`padding: var(--popup-item-padding)`, `color: var(--fg-primary)`,
hover `background: var(--bg-hover)`, full-bleed separators
(`--border-subtle`, no horizontal margin). Do **not** restructure rows
that carry richer content (properties-dropdown chips, suggestion popups
with previews) — only the surface tokens apply there.

## Risks / notes

- **CM theme objects** (`visual-theme.ts`, `typst-editor.ts`) and the
  **inline JS styles** in `table-widget.ts` all accept `var(--token)`
  strings — tokens work uniformly across CSS files and JS-built styles.
- Pure-CSS change, no logic touched; no Rust, no IPC.
- `--bg-active` stays in the codebase — it is still used for hover/
  active states elsewhere; only its use as a *popup background* is
  retired.
- Keep (or update) the comment at `.selection-toolbar` — once both it
  and the pill menu read from `--popup-*`, the comment can simply say
  "surface from --popup-* tokens".

## Verification

1. `npx tsc --noEmit` — confirms the CM theme-object edits compile.
2. Manual smoke pass, light + dark + warm palettes: right-click file
   menu, command palette (Cmd-K), `/` palette, a pill menu, table
   right-click, wikilink `[[`, citation suggest, Settings, Export,
   Composer, Quick Open, a toast. Each popup should share one surface;
   each modal the other; nothing should render behind something it
   used to sit above.

## Out of scope

- No new component abstraction (no `.popup` base class) — tokens alone
  remove the divergence; a shared class would force markup changes
  across 20 call sites for no extra benefit.
- Toast visual redesign — only its z-index is touched.
