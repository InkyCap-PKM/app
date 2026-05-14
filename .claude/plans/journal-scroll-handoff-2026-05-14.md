# Journal Scroll re-implementation — handoff (2026-05-14)

Picked up the orphaned post-Typst-pivot Journal Scroll work and rebuilt
it end-to-end against the Typst HTML pipeline. **All 15 steps from the
agreed plan in `.claude/plans/journal-scroll-2026-05-14.md` have
landed** on the `typst-pivot` branch in a single session.

**Not yet committed.** Diff is staged in the working tree. Cargo check
+ TypeScript compile + 6 unit tests all pass.

---

## What the feature now does

Toggle Journal Scroll via the centred pill in the editor header on any
`.typ` file. The editor body is replaced by a continuous, infinite-
scrolling list of related notes, each rendered through the same Typst
HTML compile pipeline that powers Reading view's HTML format (so it
looks identical — they now share the `.typst-reading__html-content`
class). The note that was open when you toggled becomes the anchor;
the list paginates bidirectionally around it.

The pill exposes:

- **Three mode buttons** — Date / Tree / Properties. Date = all vault
  notes, Tree = the anchor's folder (recursive per Settings), Properties
  = a chosen property filter via a dropdown.
- **Connections toggle** — adds an accent strip to entries that
  link-to / are-linked-from / share-tags-with the anchor (and a thicker
  strip on the anchor itself).
- **Filter chip** — appears when Properties mode has a filter; click
  the × to clear and return to Date mode.

Click an entry's title to open that note in a new tab (the scroll
itself is read-only). Click a wikilink inside an entry to either
smooth-scroll within the loaded window if the target is already
loaded, or open in a new tab otherwise (Rule A fallback). Modifier /
middle / right-click forces a new tab.

A new right-panel **Scroll context** tab (the scroll icon) shows an
outline of visible entries' headings, connections to notes outside
the scroll, tag concentration across the visible window, and a
placeholder for citation aggregation.

## Architecture

### Rust — `src-tauri/src/commands/journal_scroll.rs`

The unified `ScrollQuery` primitive replaces the original three
hardcoded mode functions:

```rust
pub struct ScrollQuery {
    pub filter: ScrollFilter,
    pub sort: ScrollSort,
    pub anchor: String,
    pub offset: i32,   // signed, relative to anchor
    pub limit: usize,
}

pub enum ScrollFilter {
    All,
    Folder { path: PathBuf, recursive: bool },
    PropertyEq { name: String, value: PropertyValue },
    PropertyAny { name: String },
    LinkedFrom { source: PathBuf },
    LinkedTo { target: PathBuf },
}

pub enum ScrollSort {
    Property { name: String, direction: SortDir },
    Title { direction: SortDir },
    Zid,
}
```

Tauri commands: `run_scroll_query(query)` and
`compute_connection_flags(anchor, paths)`. Both are registered in
`src-tauri/src/lib.rs`. `slice_around_anchor` uses strict-offset
semantics — a `"before"` request can't leak entries past the anchor.

The `LinkedFrom` / `LinkedTo` / `PropertyAny` variants and the `Title`
sort are not exposed in the pill; they exist for the right-panel
sub-queries and the wikilink-routing membership check.

Six unit tests in the same file cover the filter helpers and the
strict-offset pagination boundary.

### Frontend store — `src/stores/journal-scroll.ts`

Per-tab state:

```ts
interface JournalScrollState {
  enabled: boolean;
  mode: "date" | "tree" | "properties";
  propertyFilter: PropertyFilter | null;
  showConnections: boolean;
  anchorPath: string;
  entries: ScrollEntry[];
  firstOffset: number;   // most-negative offset requested
  lastOffset: number;    // most-positive offset requested
  hasMoreBefore: boolean;
  hasMoreAfter: boolean;
  loading: boolean;
  visibleEntries: string[];
}
```

Initial load issues two parallel unidirectional requests
(`offset=-HALF_BATCH, limit=HALF_BATCH` and `offset=0,
limit=HALF_BATCH+1`) to dodge the boundary-clipping ambiguity a single
centred request would introduce. `loadMoreBefore` /
`loadMoreAfter` extend the cursors by `BATCH` (currently 10).

`buildSort()` derives `ScrollSort` from `settings.journal_scroll.date_sort`;
`buildFilter()` builds the `ScrollFilter` from the per-tab mode +
filter; both share the same sort across modes (per the agreed
Settings ownership). Tree-mode recursion comes from
`settings.journal_scroll.tree_scope`.

### Components

| Path | Role |
|---|---|
| `src/components/JournalScrollPill.tsx` | The 3-mode header pill, Connections toggle, filter chip. Lives in `.editor-header__center`. |
| `src/components/PropertiesDropdown.tsx` | Picker for Properties mode — anchor tag chips + property name + value (with "any value"). |
| `src/components/JournalScrollView.tsx` | The scroll itself: pagination sentinels, per-entry compile pipeline, click routing, connection-decoration class wiring. |
| `src/components/ScrollContextPanel.tsx` | Right-panel "Scroll context" tab: Outline / Connections / Tags / Citations. |

`JournalScrollView` contains the module-level render queue: an LRU
cache (50 entries) keyed by path, three concurrent compile workers,
and a `vault:file-changed` subscriber that drops entries from the
cache so the next near-viewport hit re-compiles. Each entry has two
`IntersectionObserver`s — one "near" (~2 viewport-heights) that
triggers compile, one "tight" that publishes to the
`visibleEntries` signal the right-panel pane subscribes to.

Scroll-position preservation on prepend: measure the
previously-first entry's `top` relative to the container, await the
`loadMoreBefore` IPC, then in a `requestAnimationFrame` measure
again and adjust `scrollTop` by the delta. This keeps the user
looking at the same content when older entries flow in above.

### CSS

- `.editor-header` is now `display: grid; grid-template-columns: 1fr
  auto 1fr;` with `__nav` justify-self start (otherwise the buttons
  stretch across the column) and `__right-group` justify-self end.
- `.journal-scroll` is a flex-column with `flex-shrink: 0` on
  `.journal-scroll__entry` and the sentinels (without it, flex
  shrinking collapses entries into each other before overflow takes
  over).
- `.journal-scroll__entry-body` carries **both** `journal-scroll__entry-body`
  and `typst-reading__html-content` so the dedicated Reading view's
  rule set for headings / lists / code / tables / blockquotes /
  footnotes applies to scroll entries without duplication.
- Connection decoration: four modifier classes on the entry frame
  (`--anchor`, `--links-to-anchor`, `--linked-from-anchor`,
  `--shares-tags`) drive the left-edge accent strip. Only styled
  when `.journal-scroll--connections-on` is on the container —
  gated by the pill's Connections toggle.

### Vault package — `inkycap-vault/0.2.0/lib.typ`

Source dir renamed from `0.1.0` → `0.2.0`; `VERSION` const bumped in
`src-tauri/src/vault_package.rs`. The user-visible import path stays
`/.inkycap/vault.typ` (versionless).

The `wikilink` function emits a Typst-native `link()` for paged/SVG
targets, and an explicit `html.elem("a", attrs: (class:
"inkycap-wikilink", href: ..., "data-target": name), ...)` when
compiling to HTML. The `data-target` carries the raw wikilink name
(e.g., `"Reading notes"`) — the scroll view's click handler
resolves it via `getForwardLinks(sourcePath)` at click time to find
the absolute path.

## Files touched (full inventory)

- `src-tauri/src/commands/journal_scroll.rs` — full rewrite to
  `ScrollQuery` primitive + `compute_connection_flags`.
- `src-tauri/src/lib.rs` — Tauri command registrations.
- `src-tauri/src/vault_package.rs` — `VERSION` and `include_bytes!`
  path bumped.
- `inkycap-vault/0.2.0/lib.typ` — moved from `0.1.0/`; `wikilink`
  HTML-target rendering.
- `src/lib/ipc.ts` — `runScrollQuery`, `computeConnectionFlags`;
  old `getJournalScrollFiles` removed.
- `src/lib/types.ts` — `ScrollQuery`, `ScrollFilter`, `ScrollSort`,
  `ScrollEntry`, `PropertyValueJson`, `ConnectionFlags`,
  `JournalScrollEntry` (deprecated alias).
- `src/stores/journal-scroll.ts` — rebuilt with bidirectional
  pagination, `visibleEntries` signal, connections + filter state.
- `src/stores/layout.ts` — `RightPanelTab` adds `"scroll-context"`.
- `src/components/TypstEditor.tsx` — new `__center` grid slot,
  hides mode toggle when scroll is on, mounts `<JournalScrollView>`.
- `src/components/JournalScrollPill.tsx` — new.
- `src/components/PropertiesDropdown.tsx` — new.
- `src/components/JournalScrollView.tsx` — full rewrite.
- `src/components/ScrollContextPanel.tsx` — new.
- `src/components/RightPanel.tsx` — `Scroll` icon tab + panel mount
  (gated by `isScrollEnabled(activeTabId)`).
- `src/components/SettingsPanel.tsx` — copy refresh ("Date sort" →
  "Sort by", "Tree scope" → "Tree mode scope"; clarified that sort
  applies to every mode).
- `src/styles/layout.css` — header grid, pill, dropdown, scroll view
  card frame, connection decoration, scroll-context pane. Old
  markdown-renderer rules dropped.

## Known issues + deferred work

1. **Initial entry overlap fix is shipped, but flex-shrink behaviour
   is now load-bearing.** If a future CSS change unsets
   `flex-shrink: 0` on `.journal-scroll__entry`, entries will collapse
   on top of each other again rather than overflowing. The rule has a
   comment explaining why.

2. **"In current query result but not yet loaded" wikilink targets
   fall through to a new tab.** The plan's Rule A is implemented, but
   the refinement of "if it's in the result, extend the loaded window
   until we reach it, then smooth-scroll" is not. Probably fine for
   most users; revisit if it becomes a pain point.

3. **Citations sub-pane is a placeholder.** Needs an aggregated
   `typst query <inkycap-cite>` IPC across the visible window. Empty
   panel with a "coming next" message ships for now.

4. **Header layout fix.** Earlier in the session the user reported
   that `.editor-header__nav` stretched into the centre slot — fixed
   with `justify-self: start`. And entry frames overlapped each other
   in the scroll — fixed with `flex-shrink: 0`. Both are commented in
   the CSS.

5. **HTML rendering parity with Reading view.** Originally the
   journal-scroll body styled only the container, leaving inner
   `<h*>`, `<ul>`, `<table>` etc. at browser defaults. Fixed by
   adding `typst-reading__html-content` as a second class on the
   body element so the existing reading-view element rules apply.

6. **One temporary stylistic compromise** in
   `JournalScrollView.tsx`: there's a "Compiling…" placeholder shown
   for entries far from the viewport (because the near-viewport
   IntersectionObserver hasn't fired yet). The placeholder text is
   slightly misleading — those entries aren't compiling, they're
   waiting to be triggered. The fix is cosmetic (rename the message
   to "…" or "Loading shortly…") but not urgent.

7. **Scroll-position persistence across tab switches.** Tab-switching
   unmounts the entire `<TypstEditor>` ([MainContent.tsx:168](src/components/MainContent.tsx#L168)
   keys the Show by `${type}::${path}`), so the scroll container's
   `scrollTop` is lost on remount. Per-tab last-known scroll position
   is now persisted in a module-local `savedScrollByTab` Map in the
   store; the view saves on `onScroll` and restores in `onMount` via
   two nested `requestAnimationFrame`s (one for `<For>` to commit,
   one for layout to settle — without both, the assignment can clamp
   to the current smaller content height and silently land at 0).
   Reset on every content rebuild (`loadInitial`, `toggleScroll`
   off, `cleanup`) so the user doesn't return to an offset that no
   longer maps onto the loaded entries.

## Verification

```
cd src-tauri && cargo test --lib commands::journal_scroll
# 6 passed; 0 failed
cd src-tauri && cargo check
# clean
npx tsc --noEmit
# clean
```

No commit made. The plan doc at
`.claude/plans/journal-scroll-2026-05-14.md` remains the
authoritative design spec — this handoff describes the landed state.
