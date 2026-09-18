#import "/.inkycap/notebox.typ": *

#note(
  title: "Advanced Formatting",
  description: "The slash menu's Style category with page size, margins, numbering, columns, fonts, text size and language, justification, and spacing. How these document-level set rules show up only in the reading view and exports, why the visual editor presents them as a pill, and how to edit them there or in source mode.",
  tags: ("documentation",),
)

= Advanced Formatting

The #wikilink("3 - Formatting Your Writing") page covers the marks that style _individual words and blocks_ including bold, headings, lists, callouts, and so on. This page covers the other half: the *Style* category of the `/` menu, which sets the look of the _whole document_, its page, its body text, and its paragraphs.

#callout("note")[
  Everything in the Style menu is a Typst *set rule*: a one-line instruction like `#set text(size: 12pt)` that changes a default from that point onward. It styles the document; it does not insert anything you read.
]

== The one thing to understand first

A set rule changes how your note is *typeset*. Its effect appears in the *Reading View* and in your *exports* (PDF, book, web page), where the document is actually laid out into pages and paragraphs. It does *not* change the appearance of the source or visual editor, where you are working with the markup itself.

Remember that the visual editor is only a mode for making writing with Typst easier and more convenient for personal knowledge management workflows, it is not a page preview. Asking it to re-paginate, swap the body font, or re-column your text on every keystroke would interfere with writing. Thus, a set rule that you drop into a note shows up in the visual editor as a small *pill* (a marker you can see, click, and edit) and has an affect once the note is rendered (e.g. preview or PDF export).

#callout("tip")[
  To check the effect of a Style setting, switch to the *Reading View* (or export). That is where page size, margins, columns, fonts, and spacing become visible.
]

== The Style menu at a glance

Type `/`, choose *Style* (or start typing the name), and pick a setting. InkyCap inserts the set rule with a sensible starting value and places your cursor on the part you'll want to change. The full list:

#table(
  columns: (auto, 1fr),
  inset: 8pt,
  stroke: 0.5pt + luma(85%),
  table.header([Menu item], [What it inserts]),
  [Page size], [`#set page(paper: "a4")`],
  [Page margins], [`#set page(margin: (top: 2cm, bottom: 2cm, left: 2cm, right: 2cm))`],
  [Page numbering], [`#set page(numbering: "1")`],
  [Page columns], [`#set page(columns: 2)`],
  [Text font], [`#set text(font: "")`],
  [Text size], [`#set text(size: 12pt)`],
  [Text language], [`#set text(lang: "en")`],
  [Justify], [`#set par(justify: true)`],
  [Line spacing], [`#set par(leading: 0.65em)`],
  [Paragraph spacing], [`#set par(spacing: 1.2em)`],
  [First line indent], [`#set par(first-line-indent: 1em)`],
  [Heading numbering], [`#set heading(numbering: "1.")`],
)

A few notes on the values:

- *Page size* takes a named paper such as `"a4"`, `"us-letter"`, or `"a5"`.
- *Page numbering* and *Heading numbering* take a pattern string: `"1"` for plain numbers, `"i"` for roman numerals, `"1.1"` for `1`, `1.1`, `1.1.1` nested headings, and so on.
- *Text font* starts empty, type a font name between the quotes (the same names you'll find in #wikilink("2 - Settings")). Leave it blank and nothing changes.
- *Text language* tells Typst which language's rules to use for hyphenation, spacing, and quotation marks. If *Use corresponding language typesetting* is on under *Language* in #wikilink("2 - Settings") and InkyCap's interface language is not English, every new note already starts with a `#set text(lang: …, region: …)` line matching that language, hidden in the visual editor along with the import; existing notes are left as they are.
- *Heading numbering* also decides how cross-references to headings are written. Typst's `@label` reference shows the heading's _number_, so it only compiles while headings are numbered. Without numbering, the `@` popup writes a text link (`#link(<label>)[…]`) instead, and if a note already contains an `@` reference to an unnumbered heading, the problem margin offers *Enable heading numbering* and *Use a text link instead* as quick fixes.
- Lengths use Typst units: `pt`, `cm`, `mm`, `in`, or `em` (a multiple of the current font size). `0.65em` line spacing is relative to the type size; `2cm` margins are absolute.

== Where a set rule takes effect

A set rule applies *from where it sits to the end of the note*. Put it near the *top of the note* (just under the properties) and it will apply to the whole document.

Placing one partway down is occasionally useful, for example, to switch to two columns for the second half of a note.

#callout("note")[
These rules live in *one note*. They do not reach across your notebox. To style many notes at once, group them into a #wikilink("2 - Collections", display: "collection") (e.g. for creating a book) and then use the collection's *Style Overrides*, which apply the same kinds of settings to every note in the collection at export time. See #wikilink("2 - Collections") and #wikilink("3 - Exporting and Publishing").
]

== Editing a Style setting in the visual editor

In the visual editor a set rule appears as a labelled pill that names what it configures: `set text: font`, `set par: leading`, `set page: margin`, and so on. You can tell two `#set text(...)` rules apart at a glance. To change it:

- *Click the pill* (or move your cursor onto its line). The pill expands to reveal the raw `#set …` line, fully editable in place. Adjust the value, then click or move away and it collapses back to a pill.
- *Right-click the pill* for a menu: *Edit source*, *Open in source editor*, and *Copy / Duplicate / Remove style / Delete*. *Delete* removes the setting entirely.

#callout("tip")[
A leading run of set rules at the very top of a note is treated as the note's setup and tucked together above your text, out of the way, in a pill labelled *Document setup*. The pill also gathers any `#show` rules and `#let` definitions in that leading run. A set rule you add later, in the body, gets its own pill where it sits. Either way the markup is never lost, it is only folded for tidiness.
]

== Editing it in source mode

In source mode there is no pill; you see the literal `#set …` line and edit it like any other text. This is the most direct way to fine-tune values, combine several settings into one rule, or do anything the menu doesn't surface:

```typ
#set page(paper: "a4", margin: 2.5cm, numbering: "1")
#set text(font: "EB Garamond", size: 11pt, lang: "en")
#set par(justify: true, leading: 0.7em, first-line-indent: 1em)
```

Each `#set` call accepts several arguments at once, so the three lines above configure the page, the body text, and the paragraphs for an entire note. Source mode and the visual editor are two views of the *same* Typst so a change in one shows up in the other.

== For Typst users

#callout("tip", title: "For Typst users")[
The Style menu is just a friendly front end to Typst's `set` rules for the `page`, `text`, `par`, and `heading` elements; it's not InkyCap-specific. Anything you can write in a set rule works: `#set heading(numbering: "1.a")`, `#set page(header: …)`, a `#show` rule, your own functions, an imported package. For the complete reference, see the #link("https://typst.app/docs/reference/")[Typst documentation].
]

== Related pages

- #wikilink("3 - Formatting Your Writing"). The everyday marks for styling words and blocks
- #wikilink("3.1 - Formatting Examples"). A scannable cheat sheet of the common marks
- #wikilink("2 - Editing Notes"). Editor modes, the slash command, and how pills work
- #wikilink("2 - Collections"). Style Overrides that apply settings across many notes
- #wikilink("3 - Exporting and Publishing"). Where page, font, and spacing settings become visible
