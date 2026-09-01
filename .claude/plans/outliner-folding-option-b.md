# Plan — Outliner folding (Option B: real CodeMirror folding)

Status: **IMPLEMENTED 2026-09-01 (UNCOMMITTED), tests green — pending in-app
visual check.** Decisions: built-in fold engine; keep hover chevron (extended
to list items), no gutter; Shift-Alt-Arrow upgraded to subtree-aware (no new
key). Source: Codeberg issue #24 point 1.

## What shipped
- `heading-scan.ts`: `headingNodeAt` generalized to exported `nodeStartingAt(
  tree, pos, names)` (shared fast binary-search descent).
- `list-scan.ts` (new): parser-confirmed `scanListItems` + `listSubtreeEndLine`
  + `leadingWhitespace`. Fence/comment/string-safe via `nodeStartingAt`.
- `folding.ts` (new, replaces `heading-fold.ts`): `typstFolding()` =
  `codeFolding()` + `foldService` (headings + list subtrees) + hover-chevron
  ViewPlugin + theme. Exports `typstFoldRange`. Chevron dispatches built-in
  `foldEffect`/`unfoldEffect`.
- `typst-editor.ts`: `typstFolding()` moved into `baseExtensions` (both modes,
  persists across mode switch); `foldGutter()` + its CSS removed; `headingFold`
  dropped from `visualModeExtensions`; `foldKeymap` kept.
- `keymaps.ts`: `moveListItem` rewritten to move an item + its whole subtree,
  swap with adjacent same-indent sibling subtree past a blank gap, keep explicit
  `N.` numbers positional, consume at edges.
- Tests: `folding.test.ts`, `list-scan.test.ts`, `move-list-item.test.ts` (all
  green). Old `heading-fold.test.ts` deleted.

## Still to verify in-app (headless tests can't)
- Chevron placement at `left:-28px` now also renders in SOURCE mode and for
  nested list items (far-left margin). Eyeball that it doesn't clip or collide
  with the line-number gutter; may want to nudge nearer the item later.
- `codeFolding()` replace-decoration coexisting with the visual-plugin's own
  decorations inside a folded range (no overlap error).
- Fold survives visual→source→visual switch (architecturally sound: fold state
  field is in base config, not the visual compartment).

## Original design notes (for reference)

## Why Option B

Today folding is a bespoke, visual-only line-hider in
`src/editor/typst-decorations/heading-fold.ts`: a `StateField<Set<number>>`
plus `display: none` line decorations. It is loaded only inside
`visualModeExtensions()`, so leaving visual mode reconfigures the compartment to
`[]` and discards all fold state (the "switch to code mode and back, everything
unfolds" bug). It also can't fold list items, and the built-in `foldGutter()` /
`foldKeymap` wired in `typst-editor.ts` do nothing because no fold provider
exists.

Option B replaces the hand-rolled hider with CodeMirror's built-in folding
(`@codemirror/language`: `codeFolding()`, `foldEffect`/`unfoldEffect`,
`foldedRanges`, `foldGutter()`, `foldKeymap`), driven by a custom `foldService`
for Typst. This buys, for free:
- **Cross-mode persistence:** put `codeFolding()` + the fold service in the
  always-on base config (not the visual compartment). Fold state is a real
  `StateField` that survives mode switches, and folds map through document
  edits automatically.
- **List folding + heading folding** from one fold service.
- **Move-as-a-unit:** folds map through changes, so a subtree move keeps its
  fold intact instead of half-unfolding.

## Pieces to build

### 1. List-structure scan (new: `list-scan.ts`)
Mirror `heading-scan.ts`'s parser-first discipline. Return, per list-item line,
its indent depth and the range of its subtree (itself + all following lines
indented deeper, stopping at the first line indented equal/less). Must be
fence-aware (a `- x` inside a ``` block is not a list item) — reuse the tree the
way `heading-scan.ts` does, or gate candidates on not being inside a Raw/Code
node. Performance: same index-then-confirm approach; runs on the fold path, not
every keystroke.

### 2. Typst `foldService` (new or folded into `heading-fold.ts` → renamed `folding.ts`)
`foldService` signature: `(state, lineStart, lineEnd) => {from, to} | null`.
- If the line opens a heading (via `scanHeadings`): fold from the heading
  line's end to the end of its section (next heading of equal/higher level),
  preserving the issue #21 fence-aware sibling termination already in
  `heading-fold.ts`.
- Else if the line opens a list item with a deeper-indented continuation (via
  the new list scan): fold from the item line's end to the end of its subtree.
- Else null.

### 3. Wiring (`typst-editor.ts`)
- Add `codeFolding()` + `foldService.of(typstFoldService)` to the **base**
  extension list (shared by both modes), not `visualModeExtensions()`.
- Keep `foldGutter()` / `foldKeymap` (already present) — now functional.
- Remove `headingFold()` from `visualModeExtensions()` and delete the old
  StateField/line-hiding path.

### 4. Fold affordance (UX DECISION A)
The current inline hover-chevron to the left of a heading matches the Outline
panel's caret. Options:
- (A1, recommended) Keep the inline chevron look, extended to list items, but
  have it dispatch the built-in `foldEffect`/`unfoldEffect` and read
  `foldedRanges` — reuse the affordance, swap the mechanism.
- (A2) Use the standard left-hand `foldGutter()` column instead (simpler,
  conventional, but a different look and a gutter for every foldable line).

### 5. Subtree move (UX DECISION B + C)
`moveListItem` only swaps one item's text with its sibling; it does not move
children. Add a subtree-aware move that relocates an item + its whole
deeper-indented block past the adjacent sibling subtree, and extend the heading
case so a section moves as a block too.
- DECISION B: replace `moveListItem`'s behaviour with subtree-aware move, or add
  it as a separate command? (Recommended: upgrade `moveListItem` to move the
  whole subtree — the single-line swap is arguably the current bug.)
- DECISION C: keybinding. `Shift-Alt-Arrow` (item move) and `Ctrl-Shift-Arrow`
  (heading level) are taken. Recommended: keep `Shift-Alt-Arrow` but make it
  subtree-aware (no new binding needed); leave heading level-adjust on
  `Ctrl-Shift-Arrow` as-is.

### 6. Tests
- Migrate `heading-fold.test.ts` to the built-in fold API (assert
  `foldedRanges` / folded line visibility). Keep the issue #21 fence case and
  the "stops at next same-level heading" case.
- New `list-scan.test.ts`: subtree ranges, nesting, fence exclusion.
- New fold-service tests: heading vs list vs neither.
- New subtree-move tests: item with children moves as a block; heading section
  moves as a block; caret follows.
- Cross-mode persistence test if feasible in jsdom (fold survives a visual→
  source→visual compartment reconfigure).

## Out of scope (confirmed)
- Persisting folds across close/reopen (session persistence). In scope is only
  survival across in-session mode switches.
- Never write fold state into the `.typ` source (portability).

## Test-infra note (already fixed this session)
`vite.config.ts` now inlines `codemirror-lang-typst` so Vitest's wasm parser
loads; 8 suites (incl. `heading-fold`, `heading-scan`) were failing to import
before. The fold rewrite's tests depend on that fix.
