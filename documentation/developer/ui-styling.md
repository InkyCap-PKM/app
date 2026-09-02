# UI styling — tokens, buttons, badges, inputs

This is the reference for InkyCap's visual design system. Read it before
adding or restyling any UI. The governing rule is simple:

> **Reach for a token, never a literal.** If you are about to type a px
> radius, a px padding, a hex colour, a z-index, or a transition timing into
> a component rule, stop — there is almost certainly a token for it. Copying
> literal values from a neighbouring rule is how the system drifts.

The tokens are defined in [`src/styles/themes.css`](../../src/styles/themes.css);
the component rules that consume them live in per-feature files under
[`src/styles/layout/`](../../src/styles/layout/), imported in a fixed order by
[`src/styles/layout.css`](../../src/styles/layout.css) (see §7 below — the
order is load-bearing). The popup/modal/z-index surface rules are also
documented inline in `themes.css` and in
[CLAUDE.md → Coding Standards → UI surfaces](../../CLAUDE.md).

---

## 1. The token scales

All of these are theme-agnostic (defined once in `:root`) and resolve through
the per-theme colour primitives, so they stay correct under light / dark /
warm palettes automatically.

| Family | Tokens | Use for |
| --- | --- | --- |
| **Type scale** | `--text-2xs … --text-3xl` | every UI font-size |
| **Icon scale** | `--icon-sm/md/lg` | Lucide glyph sizing |
| **Radius scale** | `--radius-sm` (4px) · `--radius-md` (7px) · `--radius-lg` (8px) | sm = badges/chips, md = buttons/controls/popups, lg = modals |
| **Input radius** | `--radius-input` (= `--radius-md`) | text inputs, textareas, select/combobox triggers |
| **Spacing scale** | `--space-1 … --space-6` (2/4/6/8/12/16px) | padding & gap |
| **Button geometry** | `--btn-pad-y/-x`, `--btn-radius` | consumed by `.btn` |
| **Focus** | `--focus-ring` | the one keyboard-focus affordance |
| **Motion** | `--ease-out`, `--dur-fast` (120ms), `--dur-base` (200ms) | transitions |
| **Elevation** | `--surface-0/1/2` | layered chrome (base → raised → active) |
| **Surfaces** | `--popup-*`, `--modal-*` | floating vs. backdropped surfaces |
| **Stacking** | `--z-menu` < `--z-modal` < `--z-toast` (+ `--z-menu-over-modal`) | the only z-index values |
| **Status** | `--accent-danger`, `--accent-warn`, `--accent-success`, `--accent-info` | any UI communicating a state — one hue per meaning, app-wide |
| **On-accent text** | `--fg-on-accent` | text on an accent-filled surface (primary buttons, active chips) |
| **Annotations** | `--annotation-accent` | collaboration annotations/suggestions (purple, distinct from every status hue) |

`--radius-control` is kept as a back-compat **alias of `--radius-md`** — old
rules still resolve, but new code should use the named scale.

The spacing scale is multiplied by `--density` (see §5) so it can be rescaled
from one lever.

---

## 2. Buttons — the `.btn` system

There is **one** canonical button utility. Compose `.btn` + a variant (+ an
optional size). Do **not** author a new `*__btn` class for a text/action
button — that is exactly the duplication this system replaced.

```html
<button class="btn btn--primary">Save</button>
<button class="btn btn--secondary">Cancel</button>
<button class="btn btn--danger">Delete…</button>
<button class="btn btn--ghost">Skip</button>
<button class="btn btn--primary btn--sm">Apply</button>   <!-- compact footers -->
```

| Variant | Appearance |
| --- | --- |
| `.btn--primary` | accent-filled call to action |
| `.btn--secondary` | neutral bordered action |
| `.btn--danger` | outlined destructive action (accent-danger) |
| `.btn--ghost` | borderless text action |
| `.btn--sm` | compact size modifier (dense footers/toolbars) |

The base supplies geometry, `:disabled`, a `transition`, and the
`:focus-visible` ring. If a button needs layout positioning (e.g. a
`margin-top` from a sibling), keep a thin component class for *that property
only* and let `.btn` own the look — see `.git-panel__danger-btn`, which now
carries nothing but its margin.

### Icon-only buttons

Square icon buttons are a separate role. The canonical class is
**`.ui-icon-btn`** (add `.is-active` for a toggled state). `.icon-btn`,
`.left-sidebar__icon-btn`, and `.right-panel__icon-btn` are pre-existing,
visually-equivalent variants kept for their call sites; **prefer
`.ui-icon-btn` for new code**. All of them now share the `--focus-ring`
focus-visible treatment. (Consolidating the legacy three onto `.ui-icon-btn`
is a safe future cleanup — it was left out of the first pass only to avoid
touching dozens of call sites blind.)

---

## 3. Badges & chips — the `.badge` system

Small inline labels/chips use `.badge` + an optional variant:

```html
<span class="badge">draft</span>
<span class="badge badge--accent">tag</span>
<span class="badge badge--danger">conflict</span>
<span class="badge badge--count">12</span>   <!-- fully-rounded pill -->
```

Badges are a genuinely mixed family — count pills, label chips, status text,
and bare dot indicators are *different roles*. `.badge` covers the label/chip
case; intentionally-distinct roles (a tab's unread dot, a git status line)
stay separate by design. When a chip's radius is hand-written, use
`var(--radius-sm)`.

---

## 4. Inputs

Text inputs, number inputs, the hex field, rename/filter/search fields, and
select/combobox triggers share **`border-radius: var(--radius-input)`** and
spacing-scale padding. Focus is shown via `border-color: var(--accent)`
(`--border-input-focus`). Keep new inputs on the same token so every field
reads as one family.

`--radius-input` currently resolves to `--radius-md` (7px), so interactive
fields share the same roundedness as buttons — one uniform control radius
across the app. This is a single-token decision: flip `--radius-input` to
`--radius-sm` in `themes.css` to make form fields a touch tighter than buttons
again, without touching any component rule. Split controls (e.g. the settings
combobox) round only their outer corners using the same token
(`var(--radius-input) 0 0 var(--radius-input)`).

---

## 5. Recorded design decisions

- **Corner radius is 7px** at the control tier (`--radius-md`). This was a
  deliberate, slightly-softer-than-6px choice; retune from the one token.
- **Density** is implemented as a `--density` multiplier on the spacing scale,
  toggled by `data-density="compact"` on `<html>`. The CSS mechanism is in
  place. A user-facing Settings toggle is **intentionally not surfaced yet**:
  it only bites on rules that consume `--space-*`, so it should wait until
  spacing-scale adoption across the `src/styles/layout/` files is broad enough
  for "compact" to meaningfully tighten the UI. Surfacing it early would be a
  shim.
- **No frosted / glass surfaces.** `backdrop-filter` blur on menus/palettes was
  considered and **rejected** — it is not the desired aesthetic. Do not
  re-propose it.
- **Undefined-token guard.** `--border-color` and `--bg-tertiary` were
  references to tokens that never existed (borders silently fell back to
  `currentColor`); they were repointed to `--border-primary` / `--bg-secondary`.
  If you reference a `var(--…)` colour, confirm it is defined in `themes.css`.
  A 2026-09 sweep removed a much larger crop of the same bug — 18 phantom
  token names (`--fg-error`, `--error-fg`, `--accent-error`, `--bg-error`,
  `--success-fg`, `--warning-fg`, `--accent-blue`, …) whose hex fallbacks
  always rendered. They now resolve to the semantic status family.
- **Token enforcement is mechanical.** `src/lib/token-guard.test.ts` fails CI
  if any file in `src/styles/layout/` carries a raw hex colour or a raw
  stacking z-index (≥ 100). A genuinely theme-independent value gets a
  `/* token-exempt: <reason> */` comment on its line or the line above (the
  reading view's white "paper" page is the canonical example). Small local
  z-indexes (1, 2, 10) inside a component's own stacking context are allowed.
- **Off-scale radii and durations are a deferred decision.** ~47 radii of
  2/3/6px and a handful of 0.5s+ durations were left as literals during the
  2026-09 token migration rather than silently snapped to the scale; whether
  to snap them (a visual change) is a typography/geometry-pass decision.

---

## 6. House rules (recap)

- No `text-transform: uppercase` / `font-variant: small-caps` on headings or
  labels — distinguish with weight (600), `letter-spacing`, and muted colour.
- Floating surfaces (menus, popovers, palettes, tooltips) use `--popup-*`;
  centered backdropped dialogs use `--modal-*`; never hardcode their bg, border,
  radius, shadow, or z-index.
- Every user-facing string flows through the i18n seam — see
  [CONTRIBUTING-translations.md](./CONTRIBUTING-translations.md).
- Component styles live in per-feature files under `src/styles/layout/`;
  see §7 for the rules. Either way, consume the tokens above.

---

## 7. The `src/styles/layout/` files

`layout.css` was a single 13,000-line monolith; it is now an ordered list of
`@import` statements pulling in per-feature files from `src/styles/layout/`.
Rules for working with them:

- **Import order is load-bearing.** Equal-specificity CSS rules resolve by
  source order, and several later files deliberately refine earlier ones
  (e.g. `chrome-buttons.css` restyles elements first laid out in `tabs.css`).
  Never alphabetize or reorder the imports in `layout.css`. New files are
  appended at the end.
- **One file per feature area**, named after the UI it styles so a contributor
  editing a component knows where its rules live. Each file opens with a
  one-line description of its scope.
- **New styles go in the matching feature file** (or a new one, appended to the
  import list) — not in `layout.css` itself, which contains only imports.
- A few rules sit in a file named for a neighbouring feature because the split
  preserved original source order exactly (e.g. the `.loading-dots` animation
  is in `search-results.css`, where it was first authored). Moving a rule to a
  better home is welcome, but only after checking nothing relied on its
  position in the cascade.
