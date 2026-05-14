# Journal Scroll — Re-implementation plan

**Status:** design agreed, not yet implemented. Picked up after the
Typst pivot left the original Markdown-era implementation orphaned.

**Origin:** commit `81862f2` (April 29, 2026) introduced the feature
under the Milkdown editor. The Typst pivot (commits leading into the
`typst-pivot` branch) replaced `MarkdownEditor.tsx` with
`TypstEditor.tsx`, which never re-mounted `<JournalScrollView>` —
the view was orphaned and its Markdown body renderer became
incompatible with vault content. Settings, IPC, store, Rust command,
and CSS all remain in tree.

This plan defines what to build now. It supersedes the original spec
where they diverge — see "Diverges from original spec" near the end.

## Concept

Replace the single-note editor with a **continuous, infinite-
scrolling list of related notes**, anchored on the currently-open
note. Goal is a Logseq-style "flowing render across many notes" — a
review/recall/navigation surface, not an editing surface.

Editing happens by **opening entries in new tabs**, not in place. The
scroll itself is read-only. This preserves scroll position, allows
multi-note editing, and avoids the click-precision and state-machine
complexity of in-place edit modes.

## Current state of the tree (2026-05-14)

| Layer | File | State |
|---|---|---|
| Backend command | `src-tauri/src/commands/journal_scroll.rs` | Intact, registered. Modes: date/tree/tag with `slice_around_anchor`. |
| Tauri registration | `src-tauri/src/lib.rs:287` | Registered. |
| Settings struct | `src-tauri/src/settings.rs:209-225` | `JournalScrollSettings { date_sort, tree_scope }`. |
| IPC binding | `src/lib/ipc.ts:1160-1174` | `getJournalScrollFiles(...)`. |
| Types | `src/lib/types.ts:291,344` | `JournalScrollSettings`, `JournalScrollEntry`. |
| Frontend store | `src/stores/journal-scroll.ts` | `toggleScroll`, `setMode`, `loadMore`, `updateAnchor`, `cleanup`. `hasMoreBefore` scaffolded but unused. |
| View component | `src/components/JournalScrollView.tsx` | Exists. **Not imported anywhere.** Contains an obsolete Markdown-to-HTML renderer. |
| Settings UI | `src/components/SettingsPanel.tsx:574-610` | Visible in Editor tab — controls a feature that doesn't run. |
| CSS | `src/styles/layout.css:5735+` | ~45 rules still in place. |

## Original specs (commit 81862f2, for reference)

- Three modes: **Date** (`file.ctime`, `file.mtime`, or 14-digit
  `ZID`, reverse chronological), **Tree** (alphabetical by title,
  folder-scoped with optional recursion), **Tag** (notes sharing any
  tag with the anchor, alphabetical by title).
- Pill toggle in editor header with three sub-buttons. When active,
  swapped out the entire editor body. Per-tab state.
- `IntersectionObserver` on a bottom sentinel for infinite scroll
  (batch size 10). Anchor-down only — older entries below the anchor.
  Bidirectional was scaffolded (`hasMoreBefore`) but never wired.
- Per-entry markdown render in TypeScript
  (`renderMarkdownToHtml`) — handled frontmatter, headings, lists,
  blockquotes, wikilinks-as-spans, tags. Obsolete now that content
  is Typst, not Markdown.

## Design decisions (agreed in 2026-05-14 conversation)

All decisions resolved. No open questions remain.

1. **Render pipeline:** per-note `compileTypstHtml(path)` (the same
   path reading-mode's continuous HTML format uses). Bounded
   concurrency, two-stage `IntersectionObserver` (render-on-near +
   render-on-enter), frontend cache keyed by `(path, content-hash)`.
   Typst's incremental compiler handles the heavy lifting after the
   first hit per note.

2. **Editing model:** click an entry's title bar (or `Enter` while
   focused) opens that note in a new tab using the user's default
   editing mode. **The scroll is purely a navigation/review surface
   — no in-place editing.**

3. **Pagination:** bidirectional, anchor-centered. Scroll up =
   earlier in sort order; scroll down = later in sort order. With
   `file.ctime` DESC default sort, scrolling up reveals newer notes,
   scrolling down reveals older. Top sentinel + bottom sentinel.
   Scroll-position preservation on prepend (measure-then-restore the
   anchor entry's `top`).

4. **Mode model — 3 modes in pill, sort & scope in Settings.** The
   user-facing surface stays simple and close to the original spec:
   - **Pill exposes 3 modes:** Date / Tree / Properties.
   - **User Settings owns the sort axis:** `date_sort` =
     `created | modified | zid`. All modes sort by this axis. No
     per-pill sort knob.
   - **User Settings owns the tree scope:** `tree_scope` =
     `folder | recursive`. The Tree mode uses whichever scope is
     set globally.
   - The `ScrollQuery` primitive (described in Architecture) still
     exists in Rust as the underlying mechanism, but the frontend
     surface stays at 3 modes. The primitive's flexibility is for
     internal use (right-panel sub-queries, connection lookups,
     future expansion) — not exposed in the pill.

5. **Properties mode** replaces the original Tag mode. UI is a
   dropdown/modal where the user picks a property name, then a
   value (or "all values" for that property). The anchor's tags
   appear pinned at the top of the dropdown as one-click chips —
   this preserves the "show me related stuff" path from the
   original Tag mode without needing a dedicated mode (see
   Properties mode UI section below).

6. **Wikilink-in-scroll behaviour:** smart routing with
   modifier-click override.
   - **Click** → smooth-scroll to the target entry within the scroll
     (load it into the window if it's in the query result but not yet
     loaded — extend the loaded range as needed).
   - **Ctrl/Cmd-click**, **middle-click**, or right-click → "Open in
     new tab" → opens in a new tab in the user's default editing
     mode.
   - **Fallback rule (Rule A):** if the target is *not* in the
     current query result, plain click falls through to "open in
     new tab." Keeps the scroll coherent — visible behaves jumpily;
     non-visible escapes to a tab. No anchor swap.

7. **Day-shaped view: cut.** Degenerate case of the date filter; not
   worth its own preset.

8. **Connection highlighting architecture:** designed in upfront.
   Built from `LinkIndex` + `property_index`, no merged compile
   required. Per-entry CSS class set at load:
   - `entry--links-to-anchor` (entry contains a link to anchor)
   - `entry--linked-from-anchor` (anchor links to entry)
   - `entry--shares-tags` (tag-set overlap)
   - `entry--anchor` (the anchor itself)
   A subtle accent strip on the entry frame surfaces relationships.
   A pill-level "Connections" toggle controls whether the decoration
   is visible. **No separate "Linked" mode is added** — connection
   info lives entirely in decoration + the right-panel
   "Connections" sub-pane.

9. **Right-panel context tab:** new `RightPanelTab =
   "scroll-context"`, active only when scroll is on. Subscribes to a
   `visibleEntries` signal on the scroll store. Contents:
   - **Outline of visible window** — headings across visible
     entries (one `typst query` per batch, cached). Click → scroll-to.
   - **Connections** — notes outside the scroll that link to/from
     any visible entry. Click → open in new tab.
   - **Tag/property concentration** — tags and key properties
     recurring across visible entries. Click → narrow scroll to that
     filter (switches pill to Properties mode with that filter
     applied).
   - **Citations** — bibliography keys from `<inkycap-cite>` labels,
     deduplicated. One `typst query` per batch.

10. **Vault-package change:** extend the `inkycap-vault` package's
    `wikilink` HTML rendering to emit a `data-target="<path>"`
    attribute on the `<a>` so the scroll view can intercept clicks
    and route them.

11. **Settings panel: existing shape preserved.** The current
    `JournalScrollSettings { date_sort, tree_scope }` is correct
    under this model — `date_sort` is the sort axis, `tree_scope`
    is the Tree mode scope. Both are global preferences, not
    per-query. The Settings panel section needs no structural
    changes; only minor copy tweaks to make their role clear (e.g.,
    "Date sort" → "Sort by (all modes)", with a note that this
    applies across Date/Tree/Properties).

## Architecture

### Unified scroll query (Rust)

```rust
// src-tauri/src/commands/journal_scroll.rs (file kept for git
// continuity; consider renaming the command to run_scroll_query)

pub struct ScrollQuery {
    pub filter: ScrollFilter,
    pub sort:   ScrollSort,
    pub anchor: PathBuf,
    pub offset: i32,    // signed: ±relative to anchor
    pub limit:  usize,
}

pub enum ScrollFilter {
    All,
    Folder { path: PathBuf, recursive: bool },
    TagsAny(Vec<String>),
    PropertyEq { name: String, value: PropertyValue },
    LinkedFrom(PathBuf),   // outgoing from anchor
    LinkedTo(PathBuf),     // incoming to anchor (backlinks)
    // Future: And(Vec<...>), Or(Vec<...>) for composition.
}

pub enum ScrollSort {
    Property { name: String, direction: SortDir },
    Title(SortDir),
    Zid,
}
```

`LinkedFrom`/`LinkedTo` read from the existing `LinkIndex` (forward
and backward links built via `typst query` against `<inkycap-link>`
labels). Other filters read from `property_index`.

### Pill mode → query binding

The pill exposes 3 modes. Each mode maps to a `ScrollFilter` and
inherits sort from `settings.journal_scroll.date_sort` (created /
modified / zid). The Tree mode inherits recursion from
`settings.journal_scroll.tree_scope`.

| Pill mode | filter | sort axis | scope |
|---|---|---|---|
| Date | `All` | from `date_sort` | — |
| Tree | `Folder { recursive: tree_scope == "recursive" }` | from `date_sort` | from `tree_scope` |
| Properties | `PropertyEq { name, value }` or `PropertyAny { name }` | from `date_sort` | — |

`PropertyAny { name }` is a thin variant on `PropertyEq` that
matches any non-empty value for `name`. Useful for "every note that
has a `project` set at all," etc.

The `ScrollQuery` primitive supports more filter variants
(`LinkedFrom`, `LinkedTo`, etc.) for internal use by the
right-panel sub-queries and connection lookups, but those are not
exposed in the pill.

### Properties mode UI

Opening the Properties mode shows a dropdown/modal with three
sections, in order:

1. **Anchor's tags** (pinned chips, only if anchor has tags) —
   one-click filter to `PropertyEq { name: "tags", value: <tag> }`.
   This is the path that preserves the original Tag mode's
   "show me related stuff" affordance.
2. **Property name selector** — dropdown of all property names
   present in the vault's `property_index` (excluding `file.*`).
   Selecting a name reveals a value selector.
3. **Property value selector** — once a name is picked: a list of
   all values present in the vault for that name, plus an "any
   value" option that resolves to `PropertyAny { name }`.

Modal dismisses when the user picks. Active filter is shown as a
small chip beside the pill ("project = thesis ×") with an ×
to clear and return to Date mode.

### Layout

`.editor-header` is restructured from two children to three via
`display: grid; grid-template-columns: 1fr auto 1fr`:

```
.editor-header
├── .editor-header__nav         (left, existing)
├── .editor-header__center      (new — Journal Scroll pill)
└── .editor-header__right-group (right, existing)
```

The pill is visible on `.typ` files only (hidden on tooling files,
same as the other controls). When active, the source/visual/reading
toggle in `__right-group` is hidden (those modes are meaningless
within the scroll).

### Render pipeline

```
JournalScrollView
├── For each entry in windowed list:
│     ├── Placeholder of estimated height
│     ├── IntersectionObserver fires at two thresholds:
│     │     - tight (entry enters viewport) → render now
│     │     - loose (entry within ~3 viewport-heights) → pre-compile
│     ├── compileTypstHtml(path) dispatched via bounded queue (3-4 in flight)
│     ├── Result cached on frontend by (path, content-hash)
│     └── HTML inserted; wikilink clicks intercepted
```

The cache key includes content-hash so the cache invalidates when
the file changes on disk. Frontend listens to the same
file-changed event the property index uses.

### Connection decoration

At load time for each entry, compute four flags from
`LinkIndex` + `property_index`:

```ts
const decor = {
  isAnchor:        entry.path === anchorPath,
  linksToAnchor:   linkIndex.outgoing(entry.path).includes(anchorPath),
  linkedFromAnchor: linkIndex.outgoing(anchorPath).includes(entry.path),
  sharesTags:      intersect(entry.tags, anchorTags).length > 0,
};
```

CSS classes applied to the entry frame; visibility gated by the
pill's "Connections" toggle.

### Right-panel "Scroll Context" tab

New tab in `src/stores/layout.ts`:

```ts
export type RightPanelTab =
  | "properties" | "outline" | "links" | "references"
  | "scroll-context";   // NEW
```

The tab is visible only when scroll is active on the current tab.
Subscribes to `visibleEntries` signal on the journal-scroll store
(maintained by an `IntersectionObserver` on each rendered entry).
Four sub-panes:

1. **Outline** — one `typst query` per visible-window change for
   heading labels. Debounced.
2. **Connections** — pure index lookup; updates instantly.
3. **Tag/property concentration** — pure index lookup; click on a
   tag/property fires a new scroll query.
4. **Citations** — one `typst query` per visible-window change for
   `<inkycap-cite>` labels. Debounced.

### Wikilink interception

The vault package's `wikilink` function gets a small change to its
HTML rendering: emit `<a class="inkycap-wikilink"
data-target="<path>">...</a>` instead of the current rendering.

The scroll view installs a delegated click handler implementing
smart routing with modifier-click override (Rule A — out-of-result
targets fall through to a new tab):

```ts
container.addEventListener("click", (e) => {
  const a = (e.target as HTMLElement).closest("a.inkycap-wikilink");
  if (!a) return;
  e.preventDefault();
  const target = (a as HTMLAnchorElement).dataset.target!;

  // Modifier-click → new tab regardless of where the target lives.
  if (e.ctrlKey || e.metaKey || e.button === 1) {
    openTab({ type: "file", path: target },
            { forceNewTab: true });
    return;
  }

  // Plain click → if in current query result, scroll to it
  // (loading more entries if needed). Otherwise fall through to
  // a new tab.
  if (queryResultIncludes(target)) {
    scrollToEntry(target);  // extends loaded window if needed
  } else {
    openTab({ type: "file", path: target },
            { forceNewTab: true });
  }
});

// Right-click → native context menu with "Open in new tab" item.
// (Implemented via the existing context-menu primitive.)
```

`queryResultIncludes(path)` checks whether `path` would appear in
the current `ScrollQuery`'s result set — cheap, since the result is
derivable from the in-memory index without re-running the query.

`scrollToEntry(path)` finds the target's position in the sorted
result, requests any missing slice of entries from the backend
(extending the loaded window), then smooth-scrolls to the entry's
DOM element once rendered.

## Implementation sequence

Single connected feature; no phases. Steps in dependency order:

1. **Rust — `ScrollQuery` primitive.** Refactor
   `src-tauri/src/commands/journal_scroll.rs` to the unified shape.
   Filters: `All`, `Folder { recursive }`, `PropertyEq { name,
   value }`, `PropertyAny { name }`. Sorts: `Property { name,
   direction }`, `Zid`. (`Title` sort is unused under the
   3-mode pill model but cheap to keep for internal queries.)
2. **Rust — Linked filters (internal use).** Add
   `LinkedFrom`/`LinkedTo` to `ScrollFilter`. Read from `LinkIndex`.
   Not exposed in pill — used by right-panel sub-queries and the
   `queryResultIncludes` check for wikilink routing.
3. **Rust — Tauri command.** Rename `get_journal_scroll_files` to
   `run_scroll_query`. Re-register in `lib.rs`.
4. **Frontend — IPC + types.** Update `src/lib/ipc.ts` and
   `src/lib/types.ts` to match the new command shape.
5. **Frontend — Store.** Rebuild `src/stores/journal-scroll.ts` for
   bidirectional pagination (top + bottom sentinels,
   `hasMoreBefore`, scroll-position preservation on prepend). Add
   `visibleEntries` signal driven by per-entry
   `IntersectionObserver`. Derive sort axis from
   `settings.journal_scroll.date_sort` and Tree-mode recursion from
   `settings.journal_scroll.tree_scope`.
6. **CSS — header grid.** Restructure `.editor-header` to three-
   column grid in `src/styles/layout.css`.
7. **Frontend — Header pill (3 modes).** Place a refactored pill
   in the `__center` slot of `TypstEditor`. Three mode buttons
   (Date / Tree / Properties), a "Connections" toggle, and — when
   Properties mode is active — a chip showing the current property
   filter with ×-to-clear. No sort selector; no recursive selector
   (those are in Settings).
8. **Frontend — Properties dropdown.** Modal/dropdown component
   surfacing (1) anchor's tags as pinned chips, (2) property name
   selector populated from `property_index` (excluding `file.*`),
   (3) value selector with "any value" option.
9. **Frontend — Render pipeline.** Rebuild `JournalScrollView`
   around `compileTypstHtml` + bounded-concurrency pre-compile +
   content-hash cache.
10. **Cleanup.** Delete `renderMarkdownToHtml` and its
    `journal-scroll__wikilink`/`journal-scroll__tag` CSS rules.
11. **Vault package.** Extend `wikilink` HTML rendering to emit
    `data-target` attribute. Update `inkycap-vault` version, bundle
    new version into vaults via the existing bundling pipeline.
12. **Frontend — Click routing.** Title-bar click → open in new tab
    using `settings.editor` default editing mode. Wikilink click →
    smart routing per "Wikilink interception" section
    (`queryResultIncludes` + `scrollToEntry`, modifier-click for
    new tab, Rule A fallback). Verify or add a global default-mode
    setting (currently per-tab via `setTabEditingMode`).
13. **Frontend — Connection decoration.** Compute four flags per
    entry from `LinkIndex` + `property_index`; apply CSS classes
    gated by the pill's "Connections" toggle.
14. **Frontend — Right-panel "Scroll Context" tab.** Add
    `"scroll-context"` to `RightPanelTab`. Build pane component
    with four sub-panes (Outline, Connections, Tag/property
    concentration, Citations). Wire `visibleEntries` signal.
15. **Settings panel.** Light copy tweaks only — no structural
    changes. Clarify that `date_sort` is the global sort axis for
    all modes and `tree_scope` is the Tree mode scope. Consider
    renaming the labels (e.g., "Date sort" → "Sort by") but leave
    the underlying setting names alone for compatibility.

## Files to touch

- `src-tauri/src/commands/journal_scroll.rs` — refactor to primitive
- `src-tauri/src/lib.rs` — rename Tauri command registration
- `src-tauri/src/settings.rs` — update `JournalScrollSettings`
- `src/lib/ipc.ts` — new command binding
- `src/lib/types.ts` — `ScrollQuery`, `ScrollFilter`, `ScrollSort` types
- `src/stores/journal-scroll.ts` — bidirectional pagination
- `src/stores/layout.ts` — new `RightPanelTab` variant
- `src/components/JournalScrollView.tsx` — full rewrite
- `src/components/TypstEditor.tsx` — center pill, mount when active
- `src/components/RightPanel.tsx` — new tab/pane
- `src/components/ScrollContextPanel.tsx` — new component
- `src/components/SettingsPanel.tsx` — updated Journal Scroll section
- `src/styles/layout.css` — header grid + entry decoration + drop obsolete rules
- `inkycap-vault/<version>/lib.typ` — `wikilink` HTML data-target

## Diverges from original spec

- Tag mode → **Properties mode** (covers tag filtering as a property
  value, plus all other properties). Anchor's tags appear as pinned
  chips in the Properties dropdown to preserve the "related stuff"
  affordance.
- Anchor-down pagination → bidirectional (anchor-centered).
- Markdown-to-HTML body render → Typst-native `compileTypstHtml`.
- In-editor body (where the original had no clean editing path) →
  open-in-new-tab editing model on title click. Wikilink clicks
  use smart routing (scroll-to within the result, new tab outside,
  modifier-click forces new tab).
- No right-panel context surface in original → added.
- No connection highlighting in original → added.
- Tag mode title-alphabetical sort → all modes share the global
  sort axis from `settings.journal_scroll.date_sort` (default
  `created` = `file.ctime` DESC).
- Internally: Rust `ScrollQuery` primitive replaces the three
  hardcoded mode functions. User-facing surface is still 3 modes;
  the primitive's extra filter variants (`LinkedFrom`, `LinkedTo`)
  serve right-panel sub-queries and the wikilink routing logic.

## References

- Original commit: `81862f2` (April 29, 2026) — "initial round of
  development for the Journal Scroll functionality"
- Related plans: `merged-collection-export.md` (introduced
  `build_book_source` and `set-merged-context` which we considered
  for merged compile; not used in this design but architecturally
  adjacent)
- Related plans: `typst-native-opportunities.md` (broader catalog
  of Typst-native features the project is pursuing)
- CLAUDE.md: Typst-first principle drove the decision to use
  `compileTypstHtml` instead of resurrecting the Markdown renderer.
