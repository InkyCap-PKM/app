# The Agenda

> **Audience:** developers working on InkyCap's task and date aggregation.
> **Status:** living reference. Update it when the agenda sources or the
> `<inkycap-agenda>` extraction change.

The Agenda gathers tasks and dated items from across the notebox (or across a
collection) into one filterable, sortable list. It answers "what do I have to do,
and what is dated?" without the user maintaining a separate to-do file: anything
marked as a task or given a due date anywhere in their notes surfaces here.

It is intentionally a **flat aggregator**. There is no recurrence, no scheduling
engine, and no separate store: every agenda item is derived live from the indexed
notes, so the Agenda is always consistent with the source. Sorting, grouping, and
overdue highlighting are the frontend's job; the backend returns an unsorted
list.

---

## 1. What qualifies as an agenda item

Two independent sources feed the Agenda, both surfaced through the
`inkycap-notebox` package primitives and the `<inkycap-agenda>` query label.

**Document-level (note properties).** A note becomes one agenda item if its
`#note(...)` carries either:

- a `task` property (tri-state: `true` = done, `false` = open, absent = not a
  task; legacy quoted `"true"`/`"false"` from Markdown import are tolerated), or
- a `due` property (an ISO date).

A plain `date` property alone does **not** qualify; that is authoring metadata,
not a commitment. Only `task` or `due` makes a note an agenda item.

**Inline markers.** Every `#task(...)` and `#due(...)` call in a note body
becomes its own agenda item. These are the `note.agenda_markers`, each an
`AgendaMarker { kind, body, due, done, tags }`.

A single note can therefore produce several agenda items: the document-level one
(if any) plus one per inline marker.

---

## 2. How markers are extracted

The scanner populates `agenda_markers` from the compiled document, not from a
regex over source. Each `#task`/`#due` emits a `<inkycap-agenda>` label carrying
a `metadata(...)` dict (`kind`, `body`, `due`, `done`, `tags`), which the query
layer reads after compilation. The package's `_fmt-date()` helper normalizes any
`datetime(...)` to ISO `YYYY-MM-DD` so dates sort lexicographically.

Two robustness details worth knowing when you touch this code:

- **AST fallback on broken files.** If a note fails to compile, the extractor
  walks the parsed AST for `#task(...)` calls and recovers their bodies (due
  dates, often `datetime()` expressions, are not recoverable this way). So a note
  with a syntax error still shows its tasks, just without dates, rather than
  vanishing from the Agenda.
- **Transclusion guard.** A note that `#include`s another inlines the included
  file's labels too. Only the host note's first `<inkycap-note>` is read, and
  body labels at or after a second note boundary are dropped, so an included
  note's tasks are not absorbed into the host.

---

## 3. The backend command and shape

`get_agenda_items()` reads every `NoteMetadata` from the `PropertyIndex` and
flattens it into `AgendaItem`s. `get_collection_agenda(collection, view)` does
the same over a collection's resolved members (using the *same*
`resolve_collection_members()` as the collection table, so a collection's Agenda
view and Table view agree on membership). An `AgendaItem` carries:

`id` (stable, `<path>#note` or `<path>#m<index>`), `source` (`note` / `task` /
`date`), `is_task`, `note_path`, `note_title`, `text`, `date` (ISO due),
`created` (from `file.ctime`), `done`, `tags` (note tags unioned with any
task-local tags), and `zid`.

The backend deliberately returns this list **unsorted and unbucketed**: ordering
and overdue logic live in the frontend.

---

## 4. Frontend

`AgendaPanel` fetches the items (refetching on notebox / property / file-tree
version bumps) and hands them to the shared `AgendaList`, which is also used for
a collection's agenda view. `AgendaList` provides:

- a task-list filter (all / to-do / done / dates-only),
- multi-select tag filtering (OR), and a case-insensitive text search across
  text, note title, and tags,
- sort modes over due date, created date, zid, and name, with missing values
  sorted to the tail,
- per-row icons (checkbox for tasks, a calendar glyph for dates), a strikethrough
  style for done items, and a red badge for items whose date is before today and
  not done,
- click to open the note (modifier/middle click opens a new tab).

---

## 5. Task state, and a known gap

Task completion **can** be toggled where the task lives: an inline `#task`
checkbox toggles via the visual-editor widget (rewriting the `done:` argument in
source), and a document-level `task` property toggles via the property panel
(through the AST-based `note_rewriter`). The architecture for write-back exists.

What is **not** yet wired is toggling directly from the Agenda pane: clicking an
agenda row opens the note rather than flipping its checkbox in place. The pieces
to close this (item id to note path plus marker index, write-back, reindex,
refetch) are all present; it is a deferred UX feature, not a missing capability.
Likewise there is no recurrence or rescheduling. If you add Agenda-pane toggling,
that is the place to start.

---

## 6. Relationship to other features

The Agenda is orthogonal to the [Journal Scroll](journal-scroll.md): both read
the same indexed notes, but the Scroll arranges notes chronologically while the
Agenda collects task/due items. A dated task can appear in both. Tasks may carry
local tags (`#task("...", tags: ("urgent",))`) that union with the host note's
tags, feeding the Agenda's tag filter.

---

## 7. Key files

| Concern | Path |
|---|---|
| Backend commands + flattening | `src-tauri/src/commands/agenda.rs` |
| Marker model | `src-tauri/src/models/note.rs` (`AgendaMarker`) |
| `<inkycap-agenda>` extraction | `src-tauri/src/typst_pipeline/query.rs` |
| Package primitives | `inkycap-notebox/lib.typ` (`#task`, `#due`, `_fmt-date`) |
| Frontend | `src/components/AgendaPanel.tsx`, `src/components/AgendaList.tsx` |
| Inline task toggle | `src/editor/typst-decorations/widgets.ts` |
