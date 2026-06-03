# UI styling — tokens, buttons, badges, inputs

This is the reference for InkyCap's visual design system. Read it before
adding or restyling any UI. The governing rule is simple:

> **Reach for a token, never a literal.** If you are about to type a px
> radius, a px padding, a hex colour, a z-index, or a transition timing into
> a component rule, stop — there is almost certainly a token for it. Copying
> literal values from a neighbouring rule is how the system drifts.

The tokens are defined in [`src/styles/themes.css`](../../src/styles/themes.css);
the component rules that consume them live (today) in the single large
[`src/styles/layout.css`](../../src/styles/layout.css). The popup/modal/z-index
surface rules are also documented inline in `themes.css` and in
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
  spacing-scale adoption across `layout.css` is broad enough for "compact" to
  meaningfully tighten the UI. Surfacing it early would be a shim.
- **No frosted / glass surfaces.** `backdrop-filter` blur on menus/palettes was
  considered and **rejected** — it is not the desired aesthetic. Do not
  re-propose it.
- **Undefined-token guard.** `--border-color` and `--bg-tertiary` were
  references to tokens that never existed (borders silently fell back to
  `currentColor`); they were repointed to `--border-primary` / `--bg-secondary`.
  If you reference a `var(--…)` colour, confirm it is defined in `themes.css`.

---

## 6. House rules (recap)

- No `text-transform: uppercase` / `font-variant: small-caps` on headings or
  labels — distinguish with weight (600), `letter-spacing`, and muted colour.
- Floating surfaces (menus, popovers, palettes, tooltips) use `--popup-*`;
  centered backdropped dialogs use `--modal-*`; never hardcode their bg, border,
  radius, shadow, or z-index.
- Every user-facing string flows through the i18n seam — see
  [CONTRIBUTING-translations.md](./CONTRIBUTING-translations.md).
- `layout.css` is a monolith. New, self-contained component styling can live in
  a co-located file rather than growing it further; either way, consume the
  tokens above.
