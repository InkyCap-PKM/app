#import "/.inkycap/notebox.typ": *

#note(
  title: "Editing Notes",
  description: "How notes open and how you work in them: the Source, Visual, and Reading modes, reading formats, the slash command, and the right sidebar.",
  tags: ("documentation",),
)

= Editing Notes

== Working in a note

When you open a note it appears in the central *editor pane*, with a header bar across the top. From here you can write, see your work rendered as a finished page, insert anything from a heading to a citation, and use the right sidebar to navigate your work.


== The three editor modes

Every note can be viewed in one of three modes. You switch between them with the *mode toggle* (the three small buttons at the right end of the note's header bar). 
#align(center)[#image("/Assets/editor-mode-buttons.png", width: 16%, alt: "The three editor mode buttons: Source, Visual, and Reading")]
+ *Source* (the `Code` icon, tooltip *"Source edit"*) shows the raw Typst source exactly as it's stored: line numbers, syntax highlighting, code folding, bracket matching, and a margin that flags problems. This is the most direct, "show me everything" view.
+ *Visual* (the `PenLine` icon, tooltip *"Visual edit"*) is a friendly, distraction-light writing surface, useful within the InkyCap PKM paradigm. Your *bold* shows as bold, your headings look like headings, and bits of Typst markup are hidden until you need them. The visual editor's approach is similar to what is frequently referred to as a WYSIWYM (what you see is what you mean) editor. 
+ *Reading* (the `Eye` icon, tooltip *"Reading view"*) shows your note fully rendered and read-only, the way the finished page will actually look.

To change modes, click the segment you want. The choice is *per tab*, so if you've split your workspace (see #wikilink("1 - The InkyCap Interface")) you can have the same note open in different modes.

#callout("tip")[ You can pick which mode notes open in by default. Go to #wikilink("2 - Settings") → *"Editing mode preference"* and choose *Source Mode* or *Visual Edit*. New notes open in Visual Edit unless you change this. ]
#callout("note")[ A handful of behind-the-scenes files (InkyCap's own scaffolds and packages) always open in source mode and hide the mode toggle. They're working parts of your notebox, not notes you write in, so InkyCap keeps them plain. ]

=== Source mode: the full picture

Source mode is the unfiltered Typst view. If you're comfortable with Typst markup, or you want to see precisely what a note contains, this is home. It carries line numbers, fold controls, bracket matching, and a lint margin that points out mistakes before they reach your output.

=== Visual mode: a convenience layer, not a different format

Visual mode decorates on top of the Typst markup, so that the InkyCap display looks more similar to finished prose.

Visual mode recognizes Typst's *own* writing #link("https://typst.app/docs/reference/syntax/")[syntax] directly. Type `*like this*` for bold, `_like this_` for italic, `= ` to start a heading, `- ` for a bullet, `+ ` for a numbered item, and `$...$` for math. Or using functions like `#link()`.

#callout("important")[Remember InkyCap is Typst-native. It can import and export Markdown but it does not work as a Markdown editor, so Markdown habits do not carry over. Writing `**bold**` or starting a heading with `#` will appear *incorrectly* in your output. When in doubt, the slash command (below) inserts the correct markup for you. ]

So that you're not staring at code, anything more involved than plain formatting (a callout, an image, a quote with an attribution) collapses into a small *circled-`#` pill* showing the feature's name. The pill is your handle on that element:

- *Click* a simple pill to reveal its underlying Typst markup right where it sits, so you can edit it. When your cursor moves away, it tidies back into a pill.
- *Right-click* a pill (or press Enter or Space while it's focused) to open its *super-menu*. There you'll find element-specific options (an image's alt text and width, a callout's kind, a quote's attribution, a highlight's colour), quick ways to *Edit source* or jump the whole note into Source or Visual mode, and universal actions like *Copy*, *Duplicate*, *Remove style*, and *Delete*.

A few elements are always shown as their finished selves rather than as pills, because that's friendlier: wikilinks, tags, links, and tasks render inline and stay interactive (you can even tick a `#task` checkbox right inside a callout). Callout and quote bodies are real, editable text; you type into them as you would anywhere else.

#callout("tip", title: "For developers or advanced users")[ Visual mode is a CodeMirror 6 decoration layer ("Tier 1 / Live Preview"). Typst comments (`//` and `/* */`) are hidden and locked in visual mode; switch to source mode to read or edit them. Code-completion suggestions are suppressed in Visual mode and kept in Source. If you'd rather have markup reveal itself automatically as your cursor enters a pill, turn on #wikilink("2 - Settings") → *"Auto-expand markup"* (off by default). ]

=== Reading mode: see the finished page

Reading mode takes a moment to compile your note and then shows the rendered result, read-only. It's helpful for reviewing notes without accidentally changing them, for proofreading, sharing your screen, or reviewing the typesetting before exporting to other formats. When you switch into Reading mode, InkyCap saves any pending edits first, so what you see is current.

Reading mode offers *two render formats*, chosen with a second toggle (labelled *"Reading format"*) that appears beside the mode toggle:

- *SVG* (the `BookA` icon, *"Render as SVG (paginated)"*) shows your note paginated, just like the eventual PDF, with page frames, margins, and the works. This is the best preview of a printed or exported document.
- *HTML* (the `FileCode` icon, *"Render as HTML (copyable)"*) shows a flowing web-style layout whose text you can *select and copy*, and where embedded video and audio play. Reach for this when you want to grab text or check how the note reads as a web page.

The reading format is remembered per tab, falling back to your default (SVG unless you change *"Reading view format preference"* under *Appearance* in #wikilink("2 - Settings")).

#callout("note")[ If a note has an error that prevents part of it from compiling, Reading view shows a diagnostic and, where it can, still renders the rest with the note: *"Showing a partial render — the errored content below was skipped so the rest of the document stays visible."* You're never left with a blank page over one stray mistake. ]

== Inserting things with the slash command

In Visual mode, type `/` at the start of a word to open the *slash command palette*, a quick menu for inserting almost anything without remembering its markup. It's grouped into categories: *Format, Structure, Insert, Symbol, InkyCap, Style*, and *Tools*.

- Move with the *up/down* arrows (*PageUp* and *PageDown* jump several rows at a time), *expand a group* with the right arrow, and *accept* with Enter or Tab (a click works too). Esc dismisses it.
- Each row shows its typing shortcut at the right edge, so the palette doubles as a cheat sheet.
- If you have text selected when you trigger an item, your selection is wrapped. Select a phrase, choose *Bold*, and it will change appearance accordingly.

From here you can drop in headings, lists, links, images, video and audio (each opens a file picker), tables, footnotes, citations, page breaks, callouts, wikilinks, tasks and due dates, page-and-font style rules, and much more.

#callout("tip")[ The slash palette is the friendliest way to discover what InkyCap can insert. Browse the categories for a tour of the editor. You can turn it off under #wikilink("2 - Settings") → *"Slash / command shortcut"*, but most people leave it on. ]

There are also a few *typing shortcuts* that expand as you write in the Visual editor mode, for example:
```typ
[[Name]]   →  a wikilink to "Name"
> text     →  a block quote (at the start of a line)
- [ ] todo →  a checkable task
- [x] done →  a completed task
```

The task shortcuts keep the list marker, so `- [ ]` becomes a list item holding a task (`- #task("")`) and you can nest it or move it like any other item.

== Other conveniences while you write

- *Quick formatting keys* are there when you want them, for instance Ctrl/Cmd+B for bold, Ctrl/Cmd+I for italic, and Ctrl/Cmd+F to open the in-note find-and-replace panel. See #wikilink("3 - Keyboard Shortcuts") for the full set.
- *Auto-pairing* comes as two settings under *Editor* in #wikilink("2 - Settings"). *Auto-pair brackets* closes brackets and quotes for you. *Auto-pair Typst markup* wraps selected text when you type `*`, `_`, a backtick, or `$` around it, and closes a backtick into a pair.
- *Auto-save* writes your changes to disk on its own shortly after you stop typing; there's no Save button to remember.
- *Spellcheck* underlines misspelled words as you type, using bundled Hunspell dictionaries. Under *Language* in #wikilink("2 - Settings") you can turn on several dictionaries at once (handy for bilingual notes), and the status bar's *Spellcheck language* control switches between them. Right-click an underlined word for suggestions or to add it to the notebox's *Personal dictionary*, which travels with the notebox.
- *Enter key inserts a line break* (under *Editor*) makes a single Enter start a new line in the rendered output, by adding a hidden `\` at the end of the line; two Enters still start a new paragraph. Leave it off and a single Enter behaves as Typst normally does: the next line joins the same paragraph.
- *Intuitive list indentation* (under *Editor*) makes Tab and Shift+Tab move a list item's nested children along with it.
- *Folding* tucks a section or a list item's sub-items out of sight. Hover just to the left of a heading, or of a list item that has nested items, and a small chevron appears; click it to collapse, and again to reopen. Folding works in both Source and Visual mode and stays put when you switch between them.
- *Focus mode* (under *Editor*) can be *Off*, *Line*, or *Section*, and *Dim unfocused text* is a separate switch that fades everything outside the part you're working in; it works on its own, keeping your current paragraph clear even with Focus mode off. *Typewriter mode* and the *Popup toolbar on selected text* live in the same place.

== The right sidebar supports the open note

While you write, the *right sidebar* keeps useful information about the current note close at hand. In a split workspace it follows whichever pane you're focused on. Its tabs include:

- *Outline* is a live tree of the note's headings. Click any heading to jump to it, and expand or collapse the whole tree at once.
- *Properties* holds the note's typed metadata (its system properties like title, dates, collection, and any custom properties you create), plus file actions like Rename, Move, Bookmark, and Export. See #wikilink("6 - Note Properties").
- *Links* shows the note's *Outbound Links*, its *Inbound Links* (backlinks), and *Possible wikilinks* you might want to make. See #wikilink("4 - Links and Backlinks").
- *References* gathers the note's citations and bibliography. See #wikilink("7 - Citations and Bibliography").
- *Changes & History* collects suggestions, annotations, and any changes that have arrived since your last sync, with a badge when something needs your attention (this is used mostly for a collaboration set-up).

== Other perspectives

The header bar also gives you doorways to two other ways of seeing your work, each of which opens in its own space:

- The *Journal Scroll* button turns a tab into a continuous, chronological feed of your notes, useful for diaries, lab logs, daily writing, or to review notes you made near a certain point in time. See #wikilink("4 - Journal Scroll").
- The *Mycelial View* button (the `BrainCircuit` icon) opens a new tab proposing how you might grow your notes through their shared ideas, and anchored from the note you're currently reading. See #wikilink("5 - Mycelial View").

== Related pages

- #wikilink("3 - Formatting Your Writing")
- #wikilink("4 - Links and Backlinks")
- #wikilink("6 - Note Properties")
- #wikilink("7 - Citations and Bibliography")
- #wikilink("1 - Views and Navigation")
- #wikilink("3 - Keyboard Shortcuts")
- #wikilink("2 - Settings")
