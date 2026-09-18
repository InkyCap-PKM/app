#import "/.inkycap/notebox.typ": *

#note(
  title: "Formatting Your Writing",
  description: "How to format text in InkyCap using Typst-native syntax, the slash menu, and the selection toolbar — bold, headings, lists, math, callouts, tables, images, and verse.",
  tags: ("documentation",),
)

= Formatting Your Writing

This page shows you how to make your writing _look_ the way you want: bold and italic text, headings, lists, quotes, math, callouts, tables, images, and more. It's for anyone who wants polished, professional documents. If you're new to writing notes at all, start with #wikilink("2 - Editing Notes") first and come back here.

#callout("important")[
  Markdown shortcuts do *not* work in InkyCap. Learn the Typst syntax, which is often even quicker. See the #link("https://typst.app/docs/reference/syntax/")[Typst Documentation] for a complete reference. *Press `F1` while using InkyCap to get a simple cheatsheet*. 
]

#highlight()[Don't worry about memorizing everything]. Selecting some text makes a toolbar pop up with buttons or you can type *"/"* in the editor to get a menu. In *visual mode* your marks turn into real formatting as you type.

#callout("tip", title: "Looking for a quick lookup?")[
  For a fast, scannable reference that shows every mark you type *beside the result it produces*, see #wikilink("3.1 - Formatting Examples"). And while you're writing, press `F1` for the same cheat sheet inside the app.
]

== Bold, italic, and other inline marks

Type the mark, your text, then the mark again. The most common ones:

- *Bold*: wrap with asterisks
- _Italic_: wrap with underscores (not asterisks, which give you bold)
- Inline code: wrap with single backticks

Here's the literal syntax, so you can see the marks themselves:

```typ
This word is *bold* and this one is _italic_.
Use `backticks` for a snippet of code.
```

#callout("tip")[
  Select some words first, then press *Ctrl/Cmd+B* for bold or *Ctrl/Cmd+I* for italic, and InkyCap wraps the selection for you. Press the same shortcut again on already-bold text to remove the formatting. Typst only reads `*` and `_` as marks at the edges of a word, so if you use the shortcut (or the toolbar) on part of a word, InkyCap writes `#strong[…]` or `#emph[…]` instead; that form works anywhere.
]

Other inline effects (strikethrough, highlight, underline, superscript, subscript, footnotes) are available from the *"/" menu* and the *selection toolbar* described below, so you don't have to type their syntax by hand. A few also have keyboard shortcuts: *Ctrl/Cmd+Shift+X* for strikethrough, *Ctrl/Cmd+Shift+H* for highlight, *Ctrl/Cmd+E* for inline code, and *Ctrl/Cmd+K* for a link.

== Headings and structure

Start a line with one or more `=` signs followed by a space. One `=` is a top-level heading, two is the next level down, and so on up to six:

```typ
= Chapter title
== A section
=== A subsection
==== A fourth heading
===== A fifth heading
====== A sixth heading
```

#callout("note")[
  The trailing space after the `=` signs is necessary. `=Heading` without a space won't become a heading.
]

In visual mode you can also raise or lower the current heading's level with *Ctrl+Shift+Up* and *Ctrl+Shift+Down*, without retyping the signs.

== Lists

Begin each line with a marker and a space:

- A bullet uses a hyphen: `- item`
- A numbered list uses a plus: `+ item` (InkyCap numbers it for you, so you can reorder freely)
- For fixed numbers, use `1. item`
- For a term-and-definition list, use `/ Term: definition`

```typ
- First point
- Second point

+ Step one
+ Step two
```

When you're working in a list, *Enter* starts the next item automatically, and pressing Enter on an empty item ends the list. *Tab* and *Shift+Tab* indent and outdent items, and *Shift+Alt+Up / Down* moves an item up or down, together with its nested items, while keeping any numbering tidy. A few smaller courtesies:

- *Home* lands on the item's text, just after the bullet, and the *left arrow* at the start of an item's text steps back to the end of the line above.
- Fixed `1.` numbers are renumbered only when the list's shape changes (an item indented, outdented, or moved). A list you deliberately start at `5.` keeps running 5, 6, 7.
- A list item with nested items can be *folded*: hover to its left and click the chevron that appears. See #wikilink("2 - Editing Notes") for more on folding.

== Quotes, callouts, and highlights

A *blockquote* sets off a passage, often for citing a source. Type `> ` at the start of a line and InkyCap turns it into a proper quote block for you; if the line already has text, that text becomes the quote. Right-click the quote's pill for its options: *Style* (*Block* or *Inline*), an *Attribution* (plain text, or a bibliography key written as `<key>` so it links to your reference list), and a *Link URL* that turns the attribution into a link.

*Callouts* are the tinted, bordered boxes you've seen on this page, great for tips, warnings, and worked examples. Insert one from the "/" menu (choose *Callout*) or the selection toolbar, then pick the kind by right-clicking its `#pill`. InkyCap offers fifteen types, each with its own colour:

- *note*, *tip*, *info*, *abstract*, *quote*
- *warning*, *caution*, *important*, *danger*, *failure*, *bug*
- *example*, *question*, *todo*, *success*

The kind sets the box's word and colour, and you can override either one from the pill's menu: type your own *heading words* in the Title field, or pick any *colour* you like. The kind stays in the note either way, so clearing the title, or choosing "Match the kind", puts the box back the way it started.

The literal form, if you ever want to type one directly, is:

```typ
#callout("warning")[ Save your work before exporting. ]
#callout("tip", title: "My own title")[ You can rename the box. ]
#callout("note", color: rgb("#7c4dff"))[ Any colour you like. ]
```

To *highlight* text, select it and use the toolbar's highlighter (or *Ctrl/Cmd+Shift+H*). You can switch the highlight colour from its pill menu: *Red*, *Orange*, *Yellow* (the default), *Green*, *Blue*, *Violet*, or *Pink*.

== The "/" slash menu

Type `/` at the start of a line or right after a space, then start typing what you want, and the menu filters as you go. Use the arrow keys, *Enter*, or *Tab* to accept, *Escape* to dismiss, and the *right arrow* to open a submenu. When a feature also has a quick typing shortcut, the menu shows it on the right edge of the row.

Entries are grouped into these categories:

- *Format*: bold, italic, strikethrough, highlight, underline, overline, subscript, superscript, inline code, inline math
- *Structure*: headings, bullet/numbered/term lists, inline and block quotes
- *Insert*: links, images, video, audio, code blocks, math blocks, horizontal rules, footnotes, citations, tables, figures, page and line breaks, callouts, and more
- *Symbol*: em dash, en dash, ellipsis, non-breaking space, and a curated set of more symbols
- *InkyCap*: wikilinks, verse, tasks, due dates, annotations, and suggested edits
- *Style*: page size, margins, numbering, columns, fonts, text size and language, justification, and spacing
- *Tools*: items contributed by external tools (see #wikilink("4 - Extensions"))

== The selection toolbar

Whenever you select text in the visual editor by hand (dragging, double- or triple-clicking, or holding Shift and using the arrow keys), a small toolbar appears above your selection. It gives you one-click access to the most common formatting:

- A *block-type dropdown* to turn the selection into a bulleted list, numbered list, heading (levels 1–6), highlight, or callout, or back to *Regular Text*
- *Bold*, *Italic*, *Underline*, *Strikethrough*
- *Superscript*, *Subscript*, and *Footnote*
- *Link*, *text alignment* (left, centre, right), *verse*, *inline code*, and *inline math*

Every inline button toggles: click it once to apply the formatting, click it again on the same text to remove it. The toolbar stays out of your way inside code blocks.

== Math

InkyCap has first-class math but understand that most of the math displays in the reading mode or outputs like PDF, not in the Visual editor mode. Wrap an expression in dollar signs:

- *Inline math* sits in your sentence: `$x^2$`
- *Display math* is centred on its own line; add spaces just inside the dollar signs: `$ x^2 $`

```typ
The identity $e^(i pi) + 1 = 0$ is famous.

$ sum_(k=1)^n k = (n (n+1)) / 2 $
```

You can also insert math from the toolbar (the *∑* button) or the "/" menu. While your cursor sits inside an equation, the visual editor shows it as plain source so you can edit it; the surrounding text holds still while you type the closing `$`.

== Tables

Choose *Table* from the "/" menu to drop in a starter grid. In the visual editor it becomes an interactive table you can work with directly:

- Click a cell to *edit it in place*. A cell is a small piece of the note, so everything you can do in the body works inside it: wikilinks, bold and italic, the "/" menu, spellcheck.
- Move between cells with *Enter* and *Tab*; *Home* and *End* jump to the first or last cell of the row. With a cell selected, just start typing to replace its content.
- *Drag a column edge* to set its width, or *double-click the edge* to fit the content. Rows grow with their content; if a table has fixed row heights, the row menu's *Let rows fit their content* removes them.
- *Right-click the corner handle* (top left) for the whole table's options: *Copy table* (as tab-separated text you can paste into a spreadsheet), *Reset column widths*, *Set as header* or *Remove header* for the first row, *Edit source*, and *Delete table*.
- *Right-click a row or column handle* to insert, delete, duplicate, or move rows and columns, sort by a column, or set a column's alignment. *Drag a handle* to reorder rows or columns.
- *Paste* a grid copied from a spreadsheet straight into the table

== Images and media

To add an *image*, choose *Image* from the "/" menu (it opens a file picker), or simply *drag a file into the editor* or *paste* an image. However you add it, InkyCap copies the file into your notebox's attachment folder so the picture travels with your notes.

Once it's in, you can set the image's *File* path, *width*, *alt text*, and *alignment* from its pill menu in the visual editor. A plain image sits on the left; centre or right alignment is available when you want it. Right-click the image itself for *Show in file tree* and *Show in system file manager*, which take you to the file behind it.

InkyCap supports *video* and *audio*. These play live in the editor. When you publish to a web page they become real playable players; in a PDF (which can't play media) they appear as a tidy placeholder naming the file. See #wikilink("3 - Exporting and Publishing") for what each output format supports.

== Verse: writing that keeps its shape

For poetry or other text where the exact spacing and indentation matters, use *verse*. Unlike ordinary paragraphs (where the layout engine collapses extra spaces) verse preserves every space exactly as you typed it, so deliberate indentation or extra lines survives. Insert it from the "/" menu (*Verse*) or the selection toolbar's *verse* button. 

Unlike many other PKM tools that only provide an awkward pre-formatted code block, InkyCap's verse mode let's you work with your usual font and you can still use inline formatting inside verse: *bold*, _italic_, highlights, and links all work line by line. 

Verse accepts options for alignment, line numbering, and letter spacing, and you can set a default verse font for the whole notebox. It will appear in a normal flow with the document's output.

== For Typst users

#callout("tip", title: "For Typst users")[
  Everything in the editor is plain Typst markup, and you can always drop into raw Typst to do anything the menus don't surface: set rules, show rules, custom functions, packages. Function calls you write appear behind a small circled `#` pill in the visual editor; click it to reveal and edit the source inline, or right-click for a menu with *Edit source*, *Open in source editor*, and *Copy / Duplicate / Remove style / Delete*. Switch to source mode anytime to see and edit the full Typst directly.
]

== Related pages

- #wikilink("3.2 - Advanced Formatting"). The Style menu — page, font, and spacing set rules that show in exports and the reading view
- #wikilink("2 - Editing Notes"). Editor modes and the basics of working in a note
- #wikilink("4 - Links and Backlinks"). Connecting notes with wikilinks
- #wikilink("7 - Citations and Bibliography"). Adding references and a reading list
- #wikilink("3 - Exporting and Publishing"). Turning your formatted notes into PDFs and web pages
