# Plan — Composable `#task` descriptions (content body)

Status: **DEFERRED — thinking, not yet approved to implement** (decision 2026-09-01).
Source: Codeberg issue #24, "Support Outliner Workflows Better", proposed
solution point 3 ("make different elements more composable").

## Goal

Let a task description hold live Typst content, not just a plain string, so a
user can write references inside a task:

```typst
#task[Review @B4AAGWPG]
#task[Work on #wikilink("Assignment - Week 2")]
```

Today the citation `@B4AAGWPG` and the wikilink render as literal text because
the description is a string.

## Why this is not a one-line change

`#task` in `inkycap-notebox/lib.typ:452-465` hard-asserts
`type(body) == str`. Relaxing the type is easy; the hard part is that the task
description is **indexed as well as rendered**:

- Each task emits queryable metadata under the `<inkycap-agenda>` label with
  `body` as a plain string.
- The Agenda sidebar view and collection queries read that metadata as JSON.
- If `body` becomes content, `typst query` serializes a structured content
  tree instead of readable text, which breaks the human-readable task list in
  the Agenda view and any collection column that shows the task text.

So the change forces a decision about storing a readable text version
*alongside* the rich content.

## Proposed approach (Typst-first)

1. **`lib.typ` — accept string OR content.**
   - Keep the string path unchanged so every existing `#task("...")` note keeps
     working byte-for-byte (round-trip invariant).
   - When `body` is content, render it directly (citations/wikilinks come out
     live because they are real function calls).
   - Derive a **best-effort plain-text** rendering of the content for the
     `<inkycap-agenda>` metadata `body` field, via a small recursive text
     extraction helper in `lib.typ` (category 2, stays in Typst). Document at
     the source that extraction is best-effort — arbitrary content cannot be
     losslessly flattened to text in Typst.
   - Open question to settle before building: is best-effort extraction good
     enough for Agenda/collection display, or do we want an explicit optional
     `text:` argument that authors/tools can set for a guaranteed clean label?
     Leaning toward best-effort first, with `text:` as an escape hatch.

2. **Editor side — don't build a mini-renderer inside the task widget.**
   - `TaskWidget` (`src/editor/typst-decorations/widgets.ts:844-905`) renders
     the description as plain `textContent`. For a content body, do **not**
     teach the widget to render wikilinks/citations.
   - Instead, when the description is content, skip collapsing to the checkbox
     widget and show the raw source with its normal decorations, so the
     wikilink and citation render with their existing widgets. Reuses machinery
     we already have.
   - The `- [ ]` shortcut and command-palette insert currently emit
     `#task("")`. Decide whether a content-capable task should insert `#task[]`
     instead, or offer both. (Coordinate with the Point 2 change that keeps the
     list marker: `- #task("")` vs `- #task[]`.)

3. **Agenda / collection read path.**
   - Confirm the frontend Agenda reader tolerates the derived text and does not
     assume the author typed exactly that string.
   - No schema change to the `<inkycap-agenda>` label itself — still a string
     `body`, now possibly derived.

## Backward compatibility

- Existing `#task("...")` string tasks: unchanged output and metadata.
- Property/round-trip tests must still pass byte-for-byte for the string form.

## Risks / things to watch

- Best-effort content-to-text in Typst is fragile for nested/custom content;
  set expectations and cover it with a lib.typ test over representative bodies
  (plain text, wikilink, citation, mixed).
- Interaction with Point 2: whichever insert shape we choose (`("")` vs `[]`)
  should be consistent across the `- [ ]` shortcut, `/task`, and the palette.

## Files in scope (when approved)

- `inkycap-notebox/lib.typ` (task signature + text-extraction helper + test)
- `src/editor/typst-decorations/visual-plugin.ts` (task case: content vs string)
- `src/editor/typst-decorations/widgets.ts` (TaskWidget: content path)
- `src/editor/typst-decorations/markdown-shortcuts.ts` + `command-palette.ts`
  (insert shape, if we move to `[]`)
- Agenda read path (verify only, likely no change)
