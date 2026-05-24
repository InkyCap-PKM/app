# Split panes + tab reordering + tab-bar menu — plan (2026-05-24)

## Goal

Three editor-area improvements:

1. **Drag-to-reorder content tabs** (already largely implemented — verify & polish).
2. **Split the editor area** into recursive horizontal/vertical panes
   (Obsidian-style), each pane being its own tab group.
3. **A `panel-top-open` dropdown** at the right edge of each pane's tab
   row that (a) offers split/close-pane actions for that pane and
   (b) lists open tabs as another way to switch.

### Scope decisions (confirmed with user, 2026-05-24)

- **Recursive pane tree** — any leaf pane can split again, H or V, to
  unlimited depth. Full Obsidian model, not a 2-pane cap.
- **Drag tabs between panes = yes**, but **no drag-to-edge-to-split**.
  Splits are created only from the menu / command palette. Within-pane
  drag reorders; cross-pane drag *moves* a tab.
- **Session-only** — no on-disk persistence of layout. A notebox switch
  resets to a single pane (matches today, where tabs aren't persisted).
- Empty-split rule: closing the last tab in a pane removes the pane and
  collapses the tree; the workspace returns to using the freed space.
  The very last pane never disappears — it spawns an empty tab (today's
  invariant).

## Current state (what we're changing)

- `src/stores/tabs.ts` — flat `createStore<Tab[]>` registry + a single
  global `activeTabId` signal. One "active tab" for the whole app.
- `src/components/MainContent.tsx` — renders one `.main-content__tabs`
  strip + one `.main-content__body` keyed on
  `${tab.id}::${type}::${path}`. Already contains working drag-reorder
  (lines 75–102, `reorderTab`) and the per-tab dirty-dot set.
- Exported tab API is consumed widely: `openTab` (78 call sites),
  `getActiveTab` (38), `closeTab` (18), `activeTabId` (14),
  `setActiveTabId` (12), `switchToNext/Prev/ByIndex`, `reorderTab`,
  across 26 files. **The refactor must keep this API stable** so those
  call sites don't churn.

## Target architecture

### Data model

Keep `tabs` as the **flat registry of all open Tab objects** (so
`tabs.find(path)`, rename migration, "is this file open?" checks, and
search deep-linking keep working). The array order no longer dictates
display order — panes own display order.

Add a **pane tree** (new `src/stores/panes.ts`):

```ts
type PaneNode = SplitNode | LeafPane;

interface SplitNode {
  kind: "split";
  id: string;
  direction: "row" | "column"; // row = vertical divider, side-by-side
                               // column = horizontal divider, stacked
  children: PaneNode[];        // ≥ 2
  sizes: number[];             // fractions, sum ≈ 1, len === children.len
}

interface LeafPane {
  kind: "leaf";
  id: string;
  tabIds: string[];            // this pane's ordered tab strip
  activeTabId: string | null;  // which tab this pane displays
}
```

State (in `panes.ts`):
- `paneTree` — store, root `PaneNode`. Starts as one `LeafPane`.
- `focusedPaneId` — signal. The pane that receives new tabs / nav /
  keyboard tab-switching, and whose active tab drives the right panel.
- `dirtyTabIds` — reactive `Set<string>` lifted out of MainContent so
  every pane's strip can render the dirty dot for shared tab ids.

### API compatibility layer (the key to a tractable refactor)

`stores/tabs.ts` keeps its exported names; they now delegate to panes:

- `activeTabId` → `createMemo` returning the focused leaf's
  `activeTabId`. Still called as `activeTabId()`. No call-site changes.
- `setActiveTabId(id)` → find the leaf owning `id`, set its
  `activeTabId`, and focus that leaf. (If id is null, no-op/clear.)
- `getActiveTab()` → `tabs.find` of the focused leaf's active id.
- `openTab(tab, opts)` → unchanged semantics, but "the active tab" means
  the **focused leaf's** active tab. Reuse-existing-by-path now also
  *focuses the pane that owns the match* (jump-to-where-open). New tabs
  are appended to the focused leaf's `tabIds`.
- `closeTab(id)` → remove from owning leaf + registry; pick neighbour in
  that leaf; if leaf empties, collapse it (see below); last-pane case
  spawns an empty tab.
- `switchToNext/Prev/ByIndex` → operate on the **focused leaf's**
  `tabIds`, not the global registry.
- `reorderTab` → replaced by pane-scoped `moveTabWithinPane(paneId,
  from, to)`; only MainContent/TabStrip calls it, so this rename is
  contained.
- `closeAllTabs` (notebox switch) → reset `paneTree` to a single
  `LeafPane`, clear `focusedPaneId` to it.

New exports (from `panes.ts`, re-exported via `tabs.ts` if convenient):
- `splitPane(paneId, direction, opts)` — see below.
- `moveTabToPane(tabId, targetPaneId, index?)` — cross-pane drag.
- `focusPane(paneId)`.
- `closePane(paneId)` — close all its tabs / remove the pane.
- accessors: `paneTree`, `focusedPaneId`, `leafForTab(id)`.

### Split / collapse semantics

**`splitPane(paneId, direction, { content })`:**
- Wrap the target leaf in a `SplitNode` of `direction` (or, if its
  parent is already a split of the same direction, insert a sibling and
  renormalize — keeps the tree flat like Obsidian).
- New leaf's initial tab: default = a **duplicate view** of the source
  leaf's active tab (same path, new tab id via `allowDuplicate`), so
  "Split right" gives you the same doc twice (the common compare case).
  The keyed-by-id editor render already supports two independent views
  of one path (the Journal-Scroll duplicate-view comment generalizes).
- Sizes split the parent slot 50/50 (renormalized).
- Focus moves to the new leaf.

**Collapse (when a leaf loses its last tab, and it's not the only pane):**
- Remove the leaf from its parent split's `children` + `sizes`.
- If the parent split now has exactly one child, **unwrap**: replace the
  split with that child in the grandparent (or as new root), merging
  sizes. Repeat upward as needed.
- Renormalize sibling sizes to sum to 1.
- Move focus to the nearest remaining leaf (first leaf of the ex-sibling
  subtree).

**Last-pane invariant:** if collapsing would leave zero leaves, instead
keep the single leaf and spawn an empty tab (current `closeTab`
behaviour, lifted to pane awareness).

### Rendering — recursive pane view

Replace MainContent's single body with a recursive renderer. New
components under `src/components/panes/`:

- **`PaneView.tsx`** — takes a `PaneNode`.
  - `split`: a flex container (`flex-direction: row|column`) whose
    children are `<PaneView>` separated by `<PaneResizer>`; each child's
    `flex` basis comes from `sizes[i]`.
  - `leaf`: renders `<TabStrip pane={leaf}>` + the content body for the
    leaf's active tab, keyed on `${tabId}::${type}::${path}` exactly as
    today (move the existing dispatch block here verbatim:
    EmptyState / CollectionTable / MycelialView / TypstEditor).
- **`TabStrip.tsx`** — the per-pane `.main-content__tabs` row: scroll
  arrows, the pane's tab list (drag reorder + cross-pane drag), the `+`
  new-tab button (creates an empty tab *in this pane*), and the
  **`TabBarMenu`** trigger at the right edge. Reads `dirtyTabIds` from
  the store. Sets `focusedPaneId` on pointer-down anywhere in the strip.
- **`TabBarMenu.tsx`** — `PanelTopOpen`-icon button opening a popup
  (uses `--popup-*` tokens, `--z-menu`; never hard-coded). Sections:
  1. **Split right** (`SplitSquareHorizontal` / vertical divider) and
     **Split down** (`SplitSquareVertical` / horizontal divider).
  2. **Close this pane** (only shown when > 1 pane).
  3. divider, then the **open-tabs list** — one pane → flat list of its
     tabs; multiple panes → grouped under a small per-pane label (muted,
     `font-weight:600`, **no all-caps** per CLAUDE.md). The
     focused-pane's active tab gets a check glyph. Selecting a row calls
     `setActiveTabId` (focuses that tab's pane).
- **`PaneResizer.tsx`** — drag handle between two split children;
  adjusts the two adjacent `sizes[]` entries with a min-fraction guard.
  Mirror the existing `ResizeHandle` ergonomics (pointer capture, cursor
  col/row-resize).

`MainContent.tsx` shrinks to: render `<PaneView node={paneTree}>` inside
`.main-content`. The `EmptyState` component moves to `panes/` or a
shared spot.

### Drag-and-drop (native HTML5, matching the file-tree pattern)

- DnD payload: custom MIME `application/x-inkycap-tab` carrying
  `{ tabId, sourcePaneId }` (today's reorder uses a bare index signal;
  upgrade it so drops can land in a *different* strip).
- `onDragOver` in a strip computes the insertion index from pointer x/y
  vs. tab midpoints; show a between-tabs insertion line (polish over
  today's whole-tab highlight).
- `onDrop`: same pane → `moveTabWithinPane`; other pane →
  `moveTabToPane` (removes from source, inserts at index, focuses
  target; collapses source if it empties).
- No drop-on-pane-edge split handling (excluded by scope).

### Focus model

- Clicking a tab, clicking into a pane's content (focusin/mousedown on
  the pane wrapper), or the editor gaining focus → `focusPane(leafId)`.
- Focused leaf gets a class (`.pane--focused`) with a subtle accent on
  its tab strip (e.g. active-tab border uses accent; non-focused panes
  show the active tab slightly muted) — consistent with Obsidian's quiet
  active-pane cue. Use existing tokens; no new hard-coded colours.
- The right panel (outline/properties/backlinks) already keys off
  `getActiveTab()`/`activeTabId()`, so it follows focus automatically.

### Commands & keyboard (command palette path)

Register in the command registry + palette (and optionally keybindings):
- `pane.splitRight`, `pane.splitDown` — split the focused pane.
- `pane.close` — close the focused pane.
- `pane.focusNext` / `pane.focusPrev` — cycle focus across leaves.
- (optional) `pane.moveTabNext` — send focused tab to the next pane.
`switchToNext/Prev/ByIndex` stay but become focused-pane-scoped.

### Files

**New**
- `src/stores/panes.ts` — pane tree, focus, split/collapse/move,
  `dirtyTabIds`, derived `activeTabId`/`getActiveTab` helpers.
- `src/components/panes/PaneView.tsx`
- `src/components/panes/TabStrip.tsx`
- `src/components/panes/TabBarMenu.tsx`
- `src/components/panes/PaneResizer.tsx`

**Changed**
- `src/stores/tabs.ts` — registry stays; `activeTabId`/`setActiveTabId`/
  `getActiveTab`/`openTab`/`closeTab`/`switch*`/`closeAllTabs`
  re-expressed over panes (API names unchanged). `reorderTab` →
  `moveTabWithinPane`.
- `src/components/MainContent.tsx` — collapses to a `PaneView` host;
  tab-strip + body logic moves into the new components.
- `src/styles/layout.css` — `.pane`, `.pane-split`, `.pane--focused`,
  `.pane-resizer`, `.tab-bar__menu` (popup via `--popup-*`). Reuse
  existing `.tab*` rules unchanged.
- `src/lib/commands.ts` / command registry + `src/lib/keyboard.ts` —
  new pane commands; `switch*` scoped to focused pane.
- i18n catalog — menu labels, tooltips, command titles.

### Edge cases / invariants

- A file open in two panes = two tab ids, two editor instances, two
  independent undo stacks (keyed render already guarantees this).
- Closing a tab that's the review-mode/journal-scroll tab keeps the
  existing side-effect handling (it lives in the close handler).
- `renameTabPath`, `editorStateCache`, history map are keyed by tab id —
  unaffected by panes; moving a tab between panes preserves its cache.
- Notebox switch (`closeAllTabs`) resets to one empty pane.
- Resizer min-size guard prevents a pane collapsing to 0 via drag.

### Testing

- Unit (Vitest, once set up — note repo currently defers some FE tests):
  pane-tree ops — split wraps correctly; collapse unwraps single-child
  splits; size renormalization sums to 1; move within/between panes;
  last-pane spawns empty tab; focus follows split/collapse/move.
- Keep the source↔visual round-trip and `#note(...)` invariants
  untouched (no editor-internal changes).
- Manual: split R/D, nested split, drag tab across panes, close to
  collapse, command-palette split/close/focus, right-panel follows
  focused pane.

## Suggested phasing (each phase compiles & is usable)

1. **Reorder polish** — verify existing drag-reorder; switch the drop
   cue to a between-tabs insertion line. (Small, ships #1.)
2. **Pane store + single-pane render** — introduce `panes.ts` with a
   one-leaf tree; reroute `tabs.ts` API through it; render via
   `PaneView`/`TabStrip`/`PaneLeaf` with the *existing* single-pane look
   intact. No user-visible change yet, but the architecture is in place.
   This is the riskiest step (touches the shared API) — land it green
   before adding splits.
3. **Splitting** — `splitPane` + `PaneResizer` + recursive layout +
   `TabBarMenu` split actions + command-palette commands. Splits work,
   collapse-on-empty works.
4. **Cross-pane tab drag** — extend DnD payload; `moveTabToPane`.
5. **Menu tab-list + focus polish** — open-tabs list in `TabBarMenu`,
   focused-pane cue, right-panel-follows-focus verification.

## Open questions / risks

- Phase 2 is the load-bearing refactor: the 78 `openTab` / 38
  `getActiveTab` call sites must behave identically with one pane. Plan
  is to make them pass-through unchanged; this needs a careful read of
  the focus-switching paths (`shouldActivate`, App startup, search
  deep-link) to confirm "focused pane" == "the only pane" reproduces
  today's behaviour exactly.
- `splitPane` default content (duplicate active tab vs. empty tab) — going
  with duplicate-of-active to match Obsidian's "Split" feel; easy to flip.
