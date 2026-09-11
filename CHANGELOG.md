# Changelog

All notable changes to InkyCap are recorded here. The format is based on
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/).

## Versioning

InkyCap uses date-based versions, `YY.MM.RELEASE` (see
[documentation/developer/releasing.md](documentation/developer/releasing.md)).
The last `RELEASE` number selects the channel: **even** is a user-facing stable
release, **odd** is a development (beta) release. Add a new heading below for
each tagged release, newest first, grouping entries under **Added**, **Changed**,
**Fixed**, **Removed**, **Security**, or **Deprecated** as needed.


## [26.9.8] - 2026-09-11

### Added

- Table cells are edited with the full visual editor. Wikilinks, emphasis,
  links, the `/` palette and spell-check now work inside a cell, which used to
  be a plain text box holding raw Typst source.
- A table menu on the corner handle: copy as TSV, let rows fit their content,
  reset column widths, header toggle, edit source, delete table. "Set as
  header" is offered on the first row only, where Typst allows it.
- "Previously open tabs" startup behaviour (Settings > Behaviour > Startup
  behaviour). It restores each tab in the order it was shown, brings back the
  one that was in front, and keeps each tab's editor mode, reading format and
  zoom. The record is kept per computer, outside of the notebox folder.
- "Show in file tree" and "Show in system file manager" on the right-click
  menu of an image, video, or audio block in the visual editor to help manage the file.
- Search filters complete themselves from the notebox: typing `tag:`,
  `property:` or `path:` lists what the notebox actually contains, filtered as
  you type. Choosing a property key appends its `=` so the value list follows;
  choosing a folder writes the quotes and trailing slash the filter needs.
- ZID (ascending) and ZID (descending) sort orders in the search panel.
- Search tips carry an example per filter and provide a reminder that a filter value with spaces has to be quoted or only its first word
  counts.
- Menus can be driven entirely from the keyboard - arrows, Home/End,
  Enter/Space and Escape - including menus opened by right-click or by the
  mouse, and submenus, which Right or Enter steps into and Left steps back out
  of.
- The Properties panel's tag and collection pickers work from the keyboard, and
  are one control instead of two near-copies.

### Changed

- Block quotes in the visual editor are marked with a large quotation mark
  instead of a bar down the left side.
- The editor keeps two lines of space below the cursor when it scrolls to it,
  so there is always some text visible below the line being written.
- File names are searched a whole word at a time, the way body text already
  was, so `ink` no longer pulls in every name containing those letters; `*`
  widens the match. The explicit `file:` filter keeps its substring rule.
- Quick open and the other pickers rank a contiguous match above letters found
  scattered through a long name, which prioritizes the more likely file match.
- Ordered lists are renumbered correctly when their indentation changes, on Tab and Shift+Tab,
  rather than on every Enter. A restart typed on purpose is no longer
  overwritten.
- Enter in the search box runs the query as typed; a completion is accepted
  only once the arrows have picked a row. Tab still accepts the highlighted
  one.
- The keyboard cursor in a menu appears only once the keyboard is used.
- The gap between a sidebar list and its divider is narrower for a better use of space.

### Fixed

- A lone `$` no longer wraps every line below the caret in an equation block
  until the closing `$` arrives, and an unclosed or nested block comment no
  longer hides and locks the rest of the note. (issue #1)
- Email addresses are no longer read as references: the reference menu stays
  closed while one is typed, and the domain keeps its ordinary text colour.
- The cursor no longer slips in front of a list bullet, which could put typed
  characters before the marker or leave a stray marker behind that Typst then
  read as a nested list.
- Left arrow, and Ctrl+Left, can leave a list item again.
- The cursor stays on screen when a keyboard shortcut moves it, so a new line
  started at the bottom of the page no longer lands just out of sight.
- Tables: structural edits such as inserting a row or moving a column no longer
  write to stale positions after an edit above the table, cell edits are no
  longer silently dropped, and a cell containing a quote or a bracket such as
  `[smile :)]` no longer drops the whole table to raw source.
- Table keyboard handling: typing over a selected cell replaces it, Escape
  after an edit keeps the focus in the table, dragging a column moves it rather
  than swapping, pasting a single value works, and right-click keeps the
  selection.
- The Properties panel's value picker describes itself correctly to a screen
  reader, so the highlight moving through the list is announced.
- Windows: open tabs are recorded, and a `path:` filter matches.

### Removed

- Dragging table row heights. Typst treats a `rows:` length as exact, so a
  height chosen against the editor's fonts overflowed in the compiled note.
  "Let rows fit their content" in the new table menu replaces it.


## [26.9.6] - 2026-09-07

Mostly aesthetic polish: a great many small refinements to how surfaces,
menus and chrome are drawn, so the app reads as one continuous flow while
still distinguishing its functional elements.

### Added

- Red and violet as preset options in the highlight pill's menu.
- The hints on the new tab page are clickable shortcuts, and one of them opens
  a quick Typst cheatsheet.

### Changed

- InkyCap's home moved to CodeFloe. The in-app update check and the releases
  link point there. The Codeberg repository is archived and read-only, and
  keeps the earlier issue history and every release up to 26.9.4.
- Floating menus have a crisper edge: a single hairline border derived from the
  theme's own ink and surface, with the shadow moved off the boundary and
  re-weighted so a menu reads as lifted rather than blurred. In-menu dividers,
  drop-ups and dropdowns attached to a control each gained their own token, so
  five dropdowns that had picked five different radii for the same role now
  agree.
- The pane headers line up with the editor toolbar on one shared band, and
  every control in that row stands the same height, so the three columns end on
  the same line.
- The active editor tab sits forward instead of shouting: a softer edge, a
  shadow spread wider than its offset, and per-palette tokens, since a fill
  that lifts a tab out of the strip in a light theme made it sink in a dark
  one.
- The header band's gradient is even in the warm light palette, which had
  changed temperature down its height rather than reading as one surface.
- The writing surface runs to the column edges. The column's side hairlines and
  the toolbar and status-bar lip shadows come back with it, each shorter,
  tapered further in, and dissolving before it meets a hairline rather than
  boxing the content in.
- In the default light theme the editor and HTML preview match the paper colour
  of the paged reading view.
- Resize handles separate the area the pointer can grab from the line that is
  drawn, so a 3px divider is easy to find without getting thicker.
- The Mycelial View's menus and pickers stay inside the graph canvas instead of
  opening under the side panel or the status bar.

### Fixed

- The visual editor no longer shifts content when a decoration collapses.
  Inline pills are sized to exactly one text row instead of growing the line
  they sit on; bold and italic reveal only their delimiters when the caret
  lands inside, so a highlight nested in bold keeps its fill; and a fenced code
  block written as a list item no longer keeps its edit background after the
  caret leaves.
- The focus ring is drawn only while navigating by keyboard. Returning to the
  window after clicking a control no longer rings it in the desktop's accent
  colour, and controls that had no keyboard focus indicator at all now carry
  the shared one.


## [26.9.4] - 2026-09-05

### Added

- An `@` reference can point at a specific section inside another note, and
  correcting a broken label reference is simpler.
- The in-app update check reads a static release feed published at
  `inkycap.org/releases/latest.json` instead of querying the code host's API
  directly. The feed carries both channels and the release and download links,
  so a change in where InkyCap is hosted no longer strands installed copies.
  Builds older than 26.9 fall back to the forge API automatically.
- Advanced `settings.updates.feed_url` override (https only, no Settings UI)
  for forks and self-builders.

### Changed

- Bold and italic applied inside a word (Ctrl+B / Ctrl+I and the selection
  toolbar) now emit markup Typst renders consistently. Plain `*` and `_` do not
  always display the same way mid-word.
- Indenting and un-indenting lists behaves more predictably.
- Shell scripts are pinned to LF line endings so they run from a Windows
  checkout.
- README and contributor documentation clarify where to report issues.

### Fixed

- Code blocks, block quotes and callouts keep the same height when the caret
  enters or leaves them, so the page no longer shifts.
- The page no longer creeps upward on each click into a block.
- "Dim unfocused text" works on its own, without Focus mode. Both settings are
  applied when an editor is created and are remembered across a visual/source
  switch.
- The Tinymist language-server download script runs on macOS again, which had
  failed because macOS ships a bash without associative arrays.


## [26.9.2] - 2026-09-02

### Added

- Mycelial View: exclude notes from its calculations by property or tag.
- "Search in folder" on the file tree's folder right-click menu. Search also
  lists matches found through filenames, which previously only contributed to
  relevance scoring.
- Command palette scan for filenames that could cause cross-platform problems,
  with a guided fix.
- Button on Collection rows that opens a file in the visual editor.
- Folding for lists as well as headings. Lists move with their child items, and
  expand/collapse state persists for the session.

### Changed

- UI design system overhaul: `layout.css` split into per-area files, a token
  system for typography, spacing, geometry and motion, token-level
  accessibility work, semantic status colours, and a single icon-button class.
- Sorting throughout the app uses the ICU collator, so numerals, accented
  characters and mixed case order naturally. Replaces the previous custom
  comparison code.
- Tab styling and usability with many tabs open, pinned sidebar and right-panel
  pane headers, and scrollbar refinements.

### Fixed

- Task shortcuts in the visual editor: adding a task with `- [ ]`, the command
  palette or the slash menu now allows the text to be edited directly, or
  through a dialog from the pill's right-click menu.
- Backtick auto-pairing.
- Verse element: the arrow keys enter and exit it, and it no longer trapped the
  cursor.
- Tag filtering in Collections.
- List creation recognition after a space.
- Misspelled words no longer shift position when the spellcheck underline
  appears.


## [26.8.4] - 2026-08-28

### Fixed

— selection toolbar popups near a viewport edge
— tab strip overflow detection and scroll affordances
— @ in an email address misread as a broken reference, breaking PDF export
- Verse lines now wrap at the right margin in the reading view and in exported
  PDFs instead of running off the page. Preserved indentation and run-spacing
  are unchanged.

### Added
— Mycelial View: n-gram phrase detection, hiding under-developed pages, expand/collapse in the growth pane


## [26.8.2] - 2026-08-25

### Added

- Split with preview: a split view pairing a live editor with a synced reading
  pane, so writing and rendered output sit side by side.
- Customizable UI keyboard shortcuts. Shortcuts can be remapped from their
  defaults through the Help display (F1 or the help icon).
- Setting to disable GPU compositing (Settings > Behaviour), for Linux system
  configurations where compositing causes visual glitches.
- Typst syntax highlighting inside the visual editor's code blocks, matching the
  other code-block displays.

### Changed

- Mycelial View: anchor-specific scoring, support for small noteboxes, and new
  gap signals surfacing weak hubs and open questions.
- Journal Scroll now defaults to the most recently modified note as its anchor
  when opened without another note already active.
- Inserting a scaffold when no note is open now automatically starts a new note.
- Visual editor pills gain a trailing space on the right for a cleaner
  appearance, and no longer collapse markup into a pill until the user closes a
  parenthesis rather than assuming it.
- Reworded the calendar task-list options.
- Bumped the Typst compile pipeline 0.15.0 to 0.15.1 and the Tinymist language
  server sidecar 0.14.16 to 0.15.2.

### Fixed

- Heading detection now uses Typst's own parser instead of a line regex, so edge
  cases parse correctly.
- Search: typing in the Replace field no longer steals the caret back to Find on
  macOS/WebKit.
- Zooming now works in the SVG and HTML view modes.
- Bookmarks update when a file is renamed or moved, and the system no longer
  creates duplicate bookmarks.
- Blockquote: wrapping existing text with `>` places the quote correctly, and the
  cursor now lands inside the quotation marks for inline quotes.
- Code blocks no longer advance a line before letting the user specify the
  language.

## [26.6.2] - 2026-06-09

First public release. InkyCap is a local-first personal knowledge management and
writing application built on Typst: notes are plain Typst source that compiles
anywhere, with metadata queryable by the `typst` command-line tool. Available in
English and Français.

### Added

- Reciprocal note-linking with wikilinks and automatic backlinks at the centre
  of the navigation model.
- Portable, typed metadata via the bundled `inkycap-notebox` Typst package
  (`#note(...)` properties queryable by any Typst tool).
- Three editor modes: source (full Typst), visual (write-what-you-mean over live
  Typst markup), and reading (the rendered document).
- First-class bibliography: native Typst BibTeX/Hayagriva citations, a dedicated
  References sidebar, and Zotero integration.
- The Mycelial View: a graph surfacing emergent concepts and latent links from
  corpus statistics.
- Optional whole-notebox git collaboration with a merge-first sync model.
- Import from Markdown / Obsidian-flavoured vaults; export to PDF (incl. PDF/A
  and PDF/UA), HTML, Markdown, and ODT/DOCX/LaTeX via Pandoc.
- In-app update checker (Windows installs in place; Linux is notified and links
  to the releases page), privacy-first: no check without user action.

### Distribution

- Windows: NSIS installer (`-setup.exe`) and an MSI. Linux: `.deb`, `.rpm`, and
  a downloadable Flatpak bundle. Updater artifacts are signed with the project's
  minisign key; OS-level code signing is not yet set up.
