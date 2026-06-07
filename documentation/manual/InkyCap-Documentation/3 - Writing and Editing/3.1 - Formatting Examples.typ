#import "/.inkycap/notebox.typ": *

#note(
  title: "Formatting Examples",
  description: "A quick, example-driven reference for InkyCap's formatting: every common element shown as the markup you type beside the result you get — text styles, headings, lists, quotes, callouts, rules, math, tables, images, verse, symbols, links, and the InkyCap elements (tasks, dates, annotations, suggestions).",
  tags: ("documentation",),
  aliases: ("Syntax Reference", "Cheat Sheet"),
)

// ── Documentation-only helpers ─────────────────────────────────────────────
// These build the "You type → You see" demonstration boxes used throughout
// this page. They are local to this note (not part of the inkycap-notebox
// package): a reader's own notebox never needs a documentation-authoring
// helper. Each example is written as plain Typst markup once on the left
// (inside a code block, shown verbatim) and once on the right (rendered live),
// so the page is itself a working example of everything it documents.

// `demo` — a two-column table for compact, inline examples. Pass alternating
// (code, result) content cells.
#let demo(..cells) = block(width: 100%, table(
  columns: (1fr, 1fr),
  inset: 9pt,
  stroke: 0.5pt + luma(85%),
  align: (left + horizon, left + horizon),
  table.header(
    text(0.8em, fill: luma(45%), weight: "bold")[You type],
    text(0.8em, fill: luma(45%), weight: "bold")[You see],
  ),
  ..cells.pos(),
))

// `demo-block` — code above, rendered result below, both full width. For
// elements too wide for a column (callouts, verse, tables, images, display
// math, horizontal rules).
#let demo-block(code, result) = block(width: 100%, breakable: false, {
  code
  block(
    width: 100%,
    inset: (left: 12pt, top: 6pt, bottom: 6pt),
    stroke: (left: 2pt + luma(80%)),
    result,
  )
  v(0.4em)
})

= Formatting Examples

#highlight[To see these examples properly, view this page using the *Reading View (SVG)*.]

Each element below shows the markup you *type* on the left and the result you *see* on the right. 

#callout("important")[
  InkyCap uses #link("https://typst.app/docs/reference/syntax/")[Typst]'s own syntax, *not* Markdown. Typing `**bold**` shows the literal characters `**bold**`, and `# heading` shows a literal `#`. The marks you actually use are below. Press `F1` in InkyCap for a compact cheatsheet at any time.
]

#callout("tip")[
  You rarely have to type these by hand. Type `/` for the insert menu, or select text to raise the formatting toolbar. The syntax is here so you can recognize it, type it quickly when you prefer, and read your own source.
]

== Text styles

Common inline marks. Type the mark, your text, then the mark again. Typst requires a space or punctuation after the closing mark so it cannot appear mid-word.

#demo(
  [```typ
This is *bold* text.
```],
  [This is *bold* text.],
  [```typ
This is _italic_ text.
```],
  [This is _italic_ text.],
  [```typ
A #strike[crossed-out] word.
```],
  [A #strike[crossed-out] word.],
  [```typ
A #highlight[highlighted] word.
```],
  [A #highlight[highlighted] word.],
  [```typ
An #underline[underlined] word.
```],
  [An #underline[underlined] word.],
  [```typ
An #overline[overlined] word.
```],
  [An #overline[overlined] word.],
  [```typ
H#sub[2]O and E = mc#super[2].
```],
  [H#sub[2]O and E = mc#super[2].],
  [```typ
Some `inline code` here.
```],
  [Some `inline code` here.],
  [```typ
Euler's $e^(i pi) + 1 = 0$ identity.
```],
  [Euler's $e^(i pi) + 1 = 0$ identity.],
)

#callout("tip")[
  Most of these toggle from the keyboard: *Ctrl/Cmd+B* (bold), *Ctrl/Cmd+I* (italic). Select text and press the same shortcut again to remove the mark. Strikethrough, highlight, underline, overline, sub- and super-script are one click away on the selection toolbar.
]

== Headings

Start a line with one to six `=` signs and a space. The trailing space matters — `=Heading` without it stays literal text.

#demo-block(
  [```typ
= Heading level 1
== Heading level 2
=== Heading level 3
==== Heading level 4
```],
  [
    #text(1.5em, weight: "bold")[Heading level 1] \
    #text(1.3em, weight: "bold")[Heading level 2] \
    #text(1.15em, weight: "bold")[Heading level 3] \
    #text(1.05em, weight: "bold")[Heading level 4]
  ],
)

In visual mode, *Ctrl+Shift+Up / Down* raises or lowers the current heading's level without retyping the signs.

== Lists

Begin each line with a marker and a space. Press *Enter* to start the next item, *Enter* on an empty item to end the list, and *Tab* / *Shift+Tab* to indent or outdent.

#demo(
  [```typ
- First point
- Second point
  - A nested point
```],
  [
    - First point
    - Second point
      - A nested point
  ],
  [```typ
+ Step one
+ Step two
+ Step three
```],
  [
    + Step one
    + Step two
    + Step three
  ],
  [```typ
1. Fixed number
7. Stays seven
```],
  [
    1. Fixed number
    7. Stays seven
  ],
  [```typ
/ Typst: a typesetting system
/ Notebox: your collection of notes
```],
  [
    / Typst: a typesetting system
    / Notebox: your collection of notes
  ],
)

#callout("note")[
  Numbered lists with `+` are renumbered for you, so you can reorder items freely (*Shift+Alt+Up / Down* moves an item and keeps the numbering tidy). Use `1.` form only when you need the number to stay fixed.
]

== Quotes

An inline quote sits inside your sentence; a blockquote sets a whole passage apart. Type `> ` at the start of a line for a blockquote.

#demo-block(
  [```typ
As #quote[essence does not involve existence] reminds us, we should take a deep breath.
```],
  [As #quote[essence does not involve existence] reminds us, we should take a deep breath.],
)

#demo-block(
  [```typ
#quote(block: true, attribution: [Benedictus de Spinoza, The Ethics, Translated from the Latin by R. H. M. Elwes])[
  If a thing can be conceived as non—existing, its essence does not involve existence.
]
```],
  [#quote(block: true, attribution: [Benedictus de Spinoza, The Ethics, Translated from the Latin by R. H. M. Elwes])[
      If a thing can be conceived as non—existing, its essence does not involve existence.
    ]],
)

== Callouts

Callouts are the tinted, bordered boxes used throughout this manual — ideal for tips, warnings, and worked examples. Insert one from the `/` menu (*Callout*) or the toolbar, then choose the kind by right-clicking its pill. The literal form is `#callout("kind")[ ... ]`, with an optional `title:`.

#demo-block(
  [```typ
#callout("warning")[Save your work before exporting.]
```],
  [#callout("warning")[Save your work before exporting.]],
)

#demo-block(
  [```typ
#callout("tip", title: "A title of your own")[
  You can rename any callout.
]
```],
  [#callout("tip", title: "A title of your own")[
      You can rename any callout.
    ]],
)

InkyCap offers fifteen kinds, each with its own colour and default heading:

#demo-block(
  [```typ
#callout("note")[ ... ]      #callout("info")[ ... ]
#callout("tip")[ ... ]       #callout("success")[ ... ]
#callout("question")[ ... ]  #callout("example")[ ... ]
```],
  [
    #grid(
      columns: (1fr, 1fr),
      column-gutter: 8pt,
      row-gutter: 6pt,
      callout("note")[Note], callout("info")[Info],
      callout("tip")[Tip], callout("success")[Success],
      callout("question")[Question], callout("example")[Example],
    )
  ],
)

The complete set: *note*, *tip*, *info*, *abstract*, *quote*, *warning*, *caution*, *important*, *danger*, *failure*, *bug*, *example*, *question*, *todo*, *success*.

== Horizontal rules and breaks

A horizontal rule draws a full-width divider between sections. Type `+++` or pick *Horizontal Rule* from the `/` menu.

#demo-block(
  [```typ
Text above the divider.

#line(length: 100%)

Text below the divider.
```],
  [
    Text above the divider.
    #line(length: 100%)
    Text below the divider.
  ],
)

For other breaks:

- `#linebreak()` forces a new line without starting a new paragraph (or just press *Shift+Enter*).
- `#pagebreak()` starts a new page — visible in the reading view, PDF, and book exports.

== Math

Wrap an expression in dollar signs. With no spaces inside, it sits *inline* in your sentence; add a space just inside each `$` and it becomes a centred *display* block on its own line. Math typesets in the reading view and in exports.

#demo(
  [```typ
The sum $a^2 + b^2 = c^2$ is famous.
```],
  [The sum $a^2 + b^2 = c^2$ is famous.],
)

#demo-block(
  [```typ
$ sum_(k=1)^n k = (n (n + 1)) / 2 $
```],
  [$ sum_(k=1)^n k = (n (n + 1)) / 2 $],
)

== Tables

Choose *Table* from the `/` menu to drop in a starter grid; in the visual editor it becomes an interactive table (click a cell to edit, drag an edge to resize, paste a grid from a spreadsheet). The underlying markup is `#table(...)`:

#demo-block(
  [```typ
#table(
  columns: (auto, auto, auto),
  [Element], [Mark], [Result],
  [Bold], [`*x*`], [*x*],
  [Italic], [`_x_`], [_x_],
)
```],
  [#table(
      columns: (auto, auto, auto),
      [Element], [Mark], [Result],
      [Bold], [`*x*`], [*x*],
      [Italic], [`_x_`], [_x_],
    )],
)

== Images and media

Add an image from the `/` menu (*Image*), or just drag a file in or paste one — InkyCap copies it into your notebox's attachment folder so the picture travels with your notes. Set width, alt text, and alignment from its pill menu.

#demo-block(
  [```typ
#image("/Assets/inkycap-logo.svg", width: 20%, alt: "Otto, the InkyCap mascot")
```],
  [#align(center, image("/Assets/inkycap-logo.svg", width: 20%, alt: "Otto, the InkyCap mascot"))],
)

Video and audio work the same way — `#video("/Assets/clip.mp4")` and `#audio("/Assets/take.mp3")`. They play live in the editor and become real players when you publish to the web; in a PDF they appear as a tidy placeholder naming the file. See #wikilink("3 - Exporting and Publishing").

== Verse

For poetry, lyrics, or any text where exact spacing and indentation must survive, use *verse*. Unlike ordinary paragraphs (where extra spaces collapse), verse preserves every space you type and unlike the pre-formatted code block other tools fall back on, it keeps your normal font and lets inline marks work line by line. 

_Note that our example here shows the markup in a monospace font and it switches in the rendering to a  proportional (variable-width) font, which makes the spacing appear different. The purpose is to show that idiosyncratic spacing can be preserved but you can choose your own font._

#demo-block(
  [```typ
#verse("NOTHING



          of the memorable crisis
                       or might
                                  the event        have been accomplished in view of all results  null
                                                                                                                             human

                                                                                               WILL HAVE TAKEN PLACE
                                                                        an ordinary elevation pours out absence")
```],
  [#verse("
  
  NOTHING



          of the memorable crisis
                       or might
                                  the event        have been accomplished in view of all results  null
                                                                                                                             human

                                                                                               WILL HAVE TAKEN PLACE
                                                                        an ordinary elevation pours out absence
                                                                        ")],
)

#align(right)[(_Stéphane Mallarmé, A Dice Throw At Any Time Never Will Abolish Chance, 1914, translated by E. H. and A. M. Blackmore_)] 

Verse accepts options for alignment, line numbering (`numbered: true`), and letter spacing, and you can set a default verse font for the whole notebox. See #wikilink("3 - Formatting Your Writing") for more.

== Symbols and smart punctuation

InkyCap turns these shortcuts into proper typographic characters as you type. The full set lives under *Symbol* in the `/` menu.

#demo(
  [```typ
An em dash --- like this.
```],
  [An em dash --- like this.],
  [```typ
Pages 10--20 use an en dash.
```],
  [Pages 10--20 use an en dash.],
  [```typ
And so on...
```],
  [And so on...],
  [```typ
10~kg stays on one line.
```],
  [10~kg stays on one line.],
)

A non-breaking space (`~`) keeps two words together so they never split across a line. A soft hyphen (`-?`) marks an invisible spot where a long word *may* break.

== Links

External links use `#link`; links to other notes in your notebox use `#wikilink` (or just type `[[`). Wikilinks are the heart of how InkyCap connects notes — see #wikilink("4 - Links and Backlinks").

#demo(
  [```typ
Visit #link("https://typst.app")[the Typst site].
```],
  [Visit #link("https://typst.app")[the Typst site].],
  [```typ
See the #wikilink("2 - Editing Notes") page.
```],
  [See the #wikilink("2 - Editing Notes") page.],
  [```typ
#wikilink("2 - Editing Notes", display: "editing")
```],
  [#wikilink("2 - Editing Notes", display: "editing")],
)

== Footnotes

A footnote drops a small marker in your text and collects the note at the bottom of the page (or end of the document, depending on output). Type `++…++`, pick *Footnote* from the `/` menu, or write it directly:

```typ
The result was conclusive.#footnote[Otlet et al., 2024, p. 42.]
```

== InkyCap elements

These are InkyCap's own elements — the queryable pieces that power the Agenda, panels, and collaboration. Each is documented in depth on its own page; here is the markup at a glance.

*Tasks* are inline checkboxes that also gather in the Agenda. Type `- [ ]` or use *Task* in the `/` menu:

#demo(
  [```typ
#task("Read the proofs")
```],
  [#box[☐ Read the proofs]],
  [```typ
#task("Email the editor", due: datetime(year: 2026, month: 6, day: 30))
```],
  [#box[☐ Email the editor] #box(fill: rgb("#eef2ff"), inset: (x: 4pt, y: 1pt), radius: 2pt, text(0.85em)[2026-06-30])],
)

*Dates* attach a reminder to your prose and surface in the Agenda — `#due(datetime(year: 2026, month: 6, day: 30), label: "Grant deadline")`. See #wikilink("3 - Agenda, Tasks, and Dates").

*Annotations* are margin-style comments that stay visible in the reading view without becoming body text:

```typ
#annotation([Double-check this figure before submitting.], by: "JC", on: datetime(year: 2026, month: 6, day: 7))
```

*Suggested edits* are tracked-change marks — the "suggesting mode" primitive. In the visual editor they show the familiar green-insert / red-delete face; a compiled document shows the change as if accepted. See #wikilink("1 - Collaboration").

```typ
This draft is #suggestion([clear and], kind: "insert") well argued.
```

== For Typst users

#callout("tip", title: "For Typst users")[
  Nothing here is a closed box. Everything is plain Typst markup, so you can always drop into raw Typst for anything the menus don't surface: set rules, show rules, custom functions, packages. A function call you write appears behind a small circled `#` pill in the visual editor — click it to edit the source inline, or switch to source mode to see the full Typst directly. The two-column boxes on *this* page are built with an ordinary Typst `#table` and a tiny local helper, nothing more.
]

== Related pages

- #wikilink("3 - Formatting Your Writing"). The narrated walk-through of the same features, the slash menu, and the selection toolbar
- #wikilink("3.2 - Advanced Formatting"). The Style menu — page, font, and spacing set rules that show in exports and the reading view
- #wikilink("2 - Editing Notes"). Editor modes and the basics of working in a note
- #wikilink("4 - Links and Backlinks"). Connecting notes with wikilinks
- #wikilink("3 - Agenda, Tasks, and Dates"). How tasks and dates gather across your notebox
- #wikilink("3 - Exporting and Publishing"). Turning formatted notes into PDFs, books, and web pages
