# The Journal Scroll

> **Audience:** developers working on InkyCap's chronological reading view.
> **Status:** living reference. Update it when the scroll query, the connection
> flags, or the scroll-stability handling change.

The Journal Scroll stitches a notebox's notes into one continuous, scrollable
stream anchored on a single note, so you can read a journal, a research log, or
any dated sequence as a flowing document instead of opening files one at a time.

It sits alongside the [Mycelial View](mycelial-view.md): both surface
relationships the user did not have to build by hand, but they answer different
questions. The Mycelial View asks *where should my knowledge grow?* across the
whole notebox; the Journal Scroll asks *what surrounds this note in time, and how
does it connect to where I am anchored?* The Scroll's relationship analysis is
simpler than the Mycelial corpus statistics (it is link- and tag-based, not
TF-IDF), but it carries peculiarities of its own: a one-directional pagination
model, manual scroll anchoring to survive async compilation, and a unified query
primitive that also powers wikilink routing.

---

## 1. The `ScrollQuery` primitive (`src-tauri/src/commands/journal_scroll.rs`)

Everything is built on one backend primitive, `ScrollQuery`: a filter, a sort, an
**anchor path**, a signed **offset** relative to the anchor, and a limit. The
same primitive powers the main view, in-scroll wikilink navigation, and the
right-panel sub-queries.

- **`ScrollFilter`** selects which notes qualify: `All`, `Folder { path,
  recursive }`, `PropertyEq`, `PropertyAny`, `LinkedFrom`, `LinkedTo`. Folder
  matching keys off the walker's `file.folder` pseudo-property (notebox-relative)
  so it is consistent whether a note came from cache or a fresh parse.
- **`ScrollSort`** orders them: by a named `Property`, by `Title`, or by `Zid`.
  For a date sort, `desc` is most-recent-first.

The two key commands:

- `run_scroll_query()` filters against the `PropertyIndex` (and `LinkIndex` for
  link filters), sorts, and returns a page of `ScrollEntry { path, title }` sliced
  around the anchor.
- `find_offset_in_scroll_query()` locates a target path's signed offset relative
  to the anchor **without** mutating state. This is what lets a wikilink click
  decide whether to page to the target inside the scroll or open it in a new tab.

### Dates and chronological position

There is no single hard-coded "date field." The frontend maps the notebox's
`date_sort` setting to a `ScrollSort`:

- `created` (default) and `modified` sort by `file.ctime` / `file.mtime`.
- `note_date` sorts by the `date` property (written via `#note(date: ...)`); the
  `inkycap-notebox` package stringifies datetimes to ISO `YYYY-MM-DD`, so
  lexicographic order is chronological.
- `zid` sorts by a ZID, preferring an explicit `ZID`/`zid` property and falling
  back to a 14-or-more-digit run in the filename.

A **tier-2 fallback** keeps the feed honest: a note missing the requested sort
property is not dropped (which could strand the anchor); it sinks below notes
that have the property and sorts among its peers by `file.ctime`.

---

## 2. Connection flags (always-on)

There is no toggle: every entry shows its relationship to the anchor. This is the
Journal Scroll's analogue to the Mycelial View's signals, computed from the
`LinkIndex` and `PropertyIndex` rather than corpus statistics. `compute_connection_flags()`
sets, per entry:

- `is_anchor`: the entry is the anchor itself (relational flags are zeroed so it
  does not flag against itself).
- `links_to_anchor`: the entry wikilinks **to** the anchor (it is in the
  anchor's backlinks).
- `linked_from_anchor`: the anchor wikilinks **to** the entry (it is in the
  anchor's forward links).
- `shares_tags`: the entry's tag set intersects the anchor's.

The frontend renders these as header badges plus a coloured accent strip on the
entry's left edge, so the relationship to your anchor is visible at a glance as
you scroll. (Reads respect the `link_index` before `property_index` lock order,
the same invariant the rest of the backend follows.)

---

## 3. One-directional pagination (the central peculiarity)

The feed is deliberately **one-directional**:

- The anchor is always offset 0, pinned at the top.
- Loading proceeds **only downward** from the anchor (toward older or newer notes
  depending on the date-direction toggle).
- It never loads *above* the anchor.

The reason is the interaction between lazy loading and async compilation: an
entry that enters above the viewport and then grows from placeholder to full
height as it compiles would shove the reader's content downward (the "jump back"
problem). Forbidding upward loads removes the whole class of bug. To read the
other temporal side of the anchor, the user flips the date-direction toggle or
re-anchors, rather than scrolling up.

Per-tab scroll state (in `src/stores/journal-scroll.ts`) tracks the loaded
entries, the most-positive offset reached (`lastOffset`, a cursor that only moves
forward), whether more exist, the date direction, the visible set (via an
`IntersectionObserver`), and a within-scroll navigation history for the header
back/forward arrows.

---

## 4. Scroll stability without `overflow-anchor`

WebKitGTK (Tauri's Linux webview) has no native CSS `overflow-anchor`, so the
view anchors the scroll manually (`JournalScrollView.tsx`):

- A **`ResizeObserver`** on every entry frame detects when an entry *above* the
  viewport grows (its async compile finished) and adds that delta straight to
  `scrollTop`, holding visible content still. This never releases on user scroll:
  growth above the fold is phantom content that must always be cancelled.
- **`holdEntry()`** pins a specific entry to a saved viewport offset (used when
  restoring a saved position on tab return), correcting per frame as surrounding
  content compiles. Unlike the observer, it **releases the moment the user
  scrolls** (their intent wins) or after a short deadline.

Entries render through a module-level **LRU cache** (compiled Typst HTML, capped)
with **bounded concurrency** (a small number of simultaneous compiles) and
request coalescing, so two instances asking for the same path share one compile.
The cache invalidates on `notebox:file-changed`. Entries start as short
placeholders and fill in once they are within roughly two viewport heights.

---

## 5. Smart wikilink routing

Clicking a wikilink inside the scroll does not blindly open a tab. The handler:

1. Resolves the link target against the source note's forward links.
2. If the target is already loaded, smooth-scrolls to it.
3. If not loaded but present in the current query (`find_offset_in_scroll_query`),
   re-anchors on the target (preserving navigation history) and pages it in.
4. Otherwise falls back to opening a new tab.

Modifier-click and middle-click always open a new tab; right-click offers the
open-as menu.

---

## 6. The Scroll Context panel

When the scroll is enabled, the right panel shows **Scroll Context**, four
sub-panes that summarize the *currently visible window* (`ScrollContextPanel.tsx`):

- **Outline** of headings across visible entries (click to scroll to a heading).
- **Connections**: notes *outside* the scroll that link to or from any visible
  entry (union of backlinks and forward links, with direction arrows). Note this
  is distinct from the per-entry connection flags in section 2, which are about
  the *anchor*; this pane is about the *visible window*.
- **Tag concentration**: tag frequency across visible entries, as counted chips.
- **Citations**: aggregated references across visible entries; clicking one
  glows every occurrence on screen.

The panel caches its last computed data and last visible set per tab so returning
to a scroll tab paints instantly and refreshes in the background.

---

## 7. Settings

Three notebox-scoped settings under `journal_scroll` (Behaviour settings):

| Setting | Default | Meaning |
|---|---|---|
| `date_sort` | `created` | which key orders the feed (`created` / `modified` / `zid` / `note_date`) |
| `anchor_scope` | `all` | which notes qualify: whole notebox, the daily-note folder, or a custom folder |
| `custom_scope_folder` | `""` | the notebox-relative folder used when `anchor_scope` is `custom` |

`anchor_scope` is translated into a `ScrollFilter` on the frontend: `daily`
resolves to the daily-note creation rule's target folder; `custom` to the
configured path; `all` applies no folder filter.

---

## 8. Relationship to the Agenda

The Agenda (`src-tauri/src/commands/agenda.rs`) is orthogonal: it collects tasks
and dated reminders (`task`/`due` properties and inline markers) into a flat,
date-sorted list, independent of any scroll. A dated task can appear in both the
Agenda and the Journal Scroll, but the two are computed separately.

---

## 9. Key files

| Concern | Path |
|---|---|
| Query primitive, commands, connection flags | `src-tauri/src/commands/journal_scroll.rs` |
| View (pagination, scroll anchoring, routing) | `src/components/JournalScrollView.tsx` |
| Per-tab store | `src/stores/journal-scroll.ts` |
| Scroll Context panel | `src/components/ScrollContextPanel.tsx` |
| Settings UI | `src/components/settings/BehaviourSettingsSection.tsx` |
| Agenda (related) | `src-tauri/src/commands/agenda.rs` |
