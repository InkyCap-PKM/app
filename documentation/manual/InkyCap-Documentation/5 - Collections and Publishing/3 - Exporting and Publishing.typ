#import "/.inkycap/notebox.typ": *

#note(
  title: "Exporting and Publishing",
  description: "How to turn notes into professional outputs: single-note PDF/HTML/Pandoc export, accessible PDF/A and PDF/UA, and merged collection (book) and static-site export.",
  tags: ("documentation",),
)

= Exporting and Publishing

== Turning your notes into finished work

How will you transform your notes and writing into an output that you can distribute? Take the notes you have drafted and turn them into well-designed, professional outputs you can hand to a reader, a publisher, a repository, or the Web. InkyCap exports a single note on its own but it can also merge a whole #wikilink("2 - Collections", display: "collection") of notes into one polished document (a book) or web pages for a site.

You do not need to know anything about Typst or page layout to use this functionality. You pick a format, choose a few options, and InkyCap produces the file.

There are two starting points, depending on what you want to export:

+ *One note* → the *Export* dialogue.
+ *A whole collection* (many notes at once, or merged into a book) → the *Export* menu in the collection table. See #wikilink("2 - Collections").
\

== Exporting a single note

=== Opening the Export dialogue

You can open the dialogue in a few ways:

- From the note's overflow menu, choose *Export...*.
- From the command palette, run *Export Note as PDF* (this opens the dialogue already set to PDF).
- From the command palette, run *Export Self-Contained .typ* (this opens the dialogue already set to the portable `.typ` format).
- From a collection's table, right-click a row and choose *Export note…*. The dialogue then applies the collection's Typst template and bibliography style to that one note, and says so at the top.

The dialogue is a small window in the centre of the screen. Press *Esc*, click the backdrop, click the *×* in its corner, or use the *Cancel* button to close it (the button reads *Close* once an export has finished). When you are ready, click *Export*.

=== Choosing a format

The *Format* dropdown is split into two groups.

The *Typst* group needs no extra software. InkyCap produces these on its own:

- *PDF (.pdf)* is the default. A finished, print-ready document.
- *Self-contained (.typ)* is a portable copy of the note that includes everything it needs to be opened in a different Typst-based tool (the notebox package and any images are copied alongside).
- *HTML (.html)* is a self-contained web page. Any images, video, or audio your note references are copied next to the page so it works anywhere (for example, copied to a web server).
- *Markdown (.md)* is a plain-text Markdown version of the note.

The *Via Pandoc* group produces *OpenDocument (.odt)*, *LaTeX (.tex)*, *Microsoft Word (.docx)*, and *PDF with properties (.pdf)*. These require the free Pandoc tool to be installed on your system (see #link(<pandoc>)[Working with Pandoc] below).

=== Options you may see

Depending on the format you choose, a few options appear:

- *Note metadata* (PDF, HTML, and Pandoc formats). Choose *Exclude metadata* (the default) to keep your note's #wikilink("6 - Note Properties", display: "properties") out of the file, or *Include as document properties* to record the title, author, date, and keywords as the document's own properties (so they show up in a PDF's metadata, a web page's `<head>`, or word processor's File Properties).
- *Include bibliography in output* (PDF and HTML only). On by default. When on, your reference list appears at the end. When off, citations still resolve normally but the rendered bibliography is left out. See #wikilink("7 - Citations and Bibliography").
- *Extract figures alongside export* (all formats). When on, InkyCap also writes a folder of your figure images beside the export.
- *Remove internal links (wikilinks)* (HTML only) strips the in-note links so the page reads as standalone prose.
- *Preserve unconvertible Typst markup (as code blocks)* (Markdown only). On by default. Markdown cannot represent every Typst construct, so anything it cannot translate is wrapped in a code block rather than lost. Turn it off for a cleaner file if you do not mind dropping those bits.

== Professional and accessible PDFs

The PDF format offers a *PDF standard* dropdown. This is where you choose how rigorous and accessible the file should be:

- *Standard (PDF 1.7)* is the default. A normal, widely compatible PDF. 
- *PDF/A-4 (archival)* is a long-term archival format suitable for institutional repositories and theses that must remain readable for decades.
- *PDF/UA-1 (accessible)* means Universal Accessibility. Produces a fully tagged, structured PDF that assistive technologies such as screen readers can navigate.
- *PDF/A-2a + PDF/UA-1 (archival + accessible)* gives you both in one file: long-term preservation with full accessibility tagging. 

For the three strict standards, InkyCap automatically adds today's date as the document date if your note does not already set one (these formats require a date).

#callout("important")[*PDF/UA-1 (on its own or combined with PDF/A-2a) will refuse to export until your note is genuinely accessible.* Before it produces the file, InkyCap checks the whole note and, if there are problems, stops and lists *all* of them at once with line numbers so you can fix them in one pass. Two things that it insists on:

- *Every image needs alternative text* (a short description of what the image shows so that a screen reader can convey it).
- *Headings must not skip levels*. Go from a section to a subsection without jumping a level (no `=` straight to `===`).]

#callout("tip", title: "For Typst users")[The alt-text requirement maps to the `alt:` argument on each `#image(...)`, and the heading rule wants consecutive `=` / `==` / `===` nesting. The pre-flight check (`check_pdf_standard_requirements`) blocks the export and aggregates every offending line into one actionable error; there is deliberately no silent `alt:` fallback. The standards correspond to `typst-pdf`'s `PdfStandard::A_4` and `PdfStandard::Ua_1`; the combined preset requests `A_2a` together with `Ua_1`. PDF/A-4 is built on PDF 2.0 while PDF/UA-1 is tied to PDF 1.7, so those two cannot be paired, which is why the combination uses PDF/A-2a.]

== Working with Pandoc <pandoc>

The *Via Pandoc* formats (OpenDocument, LaTeX, Word, and PDF-with-properties) rely on #link("https://pandoc.org/")[Pandoc], a free and open source document-conversion tool you install separately.

If InkyCap cannot find Pandoc, the dialogue shows *Pandoc not found. Install it or set a custom path in Settings.* and the Export button is disabled until you sort it out. You can point InkyCap at your Pandoc installation in #wikilink("2 - Settings"), on the *Import/Export & Backup* tab, under *Export*: the *Pandoc path* field takes the location of your Pandoc program, or leave it blank to detect it automatically. A live status line tells you whether it was found.

#callout("note")[When using Pandoc, InkyCap first renders your note to HTML and then lets Pandoc convert from there. This keeps notebox features working in the output. This results in some complex mathematics appearing imperfectly through this route than in a native PDF export. If your work is heavily mathematical, prefer the native *PDF (.pdf)* format. ]

The *PDF with properties (.pdf)* option additionally needs a PDF engine. InkyCap looks for one automatically and accepts any of `typst`, `xelatex`, `lualatex`, `pdflatex`, or `tectonic`. If none is available, it tells you so and points you back to the native PDF export, which does not need extra tools.

== Tracked changes in your exports

If your note carries tracked-change suggestions or review notes from working with a collaborator, a *Review markup* dropdown appears so you can decide how those marks come through:

- *Keep tracked changes* (the default). Suggestions and review notes appear as visible tracked-change marks, just as you see them while editing.
- *Accept all changes* applies every suggested change and removes the review notes, giving you a clean published copy.
- *Reject all changes* discards suggested changes (the original text stays) and removes the review notes.

Keep is the default everywhere, and this control only shows for a single note when that note actually contains review markup. See #wikilink("1 - Collaboration").

== Exporting a whole collection

A #wikilink("2 - Collections", display: "collection") gathers many related notes, and you can publish them all at once. Open the collection's table, then click *Export* in its toolbar. The menu offers:

- *Table as CSV* / *Table as TSV* saves the collection's grid of notes as a spreadsheet file.
- *Collection as PDF files* writes one PDF per note, into a folder you choose. If a single note will not compile, InkyCap reports it but keeps going with the rest.
- *Collection merged into one PDF (book)* combines every note into a single, well-structured document (see below).
- *Collection as HTML files* publishes the collection as a small web site (see below).
- *Collection as Markdown files* writes one Markdown file per note.

The menu also carries its own *PDF standard* and *Review markup* dropdowns, with the same choices described above, so the whole batch follows your decision. The order of notes in every collection export follows the collection's current sort or manual ordering.

== Merging a collection into a "book"

*Collection merged into one PDF (book)* is how you produce a professional long-form document (a thesis, a report, an edited volume) from many notes. The result can include a title page, an abstract, a table of contents, your chapters in order, and a single bibliography.

You set this up in the collection's *Book Metadata and Structure* tab in the right panel, which saves automatically as you change it. Key choices:

- *Title*, *Subtitle*, *Date*, and *Abstract* for the front of the book.
- *Contributors* is a roster of everyone who worked on it (covered below).
- *Title page* → *Include* is on by default. If you have chosen a Typst template for the collection, a reminder appears here: when the template draws its own title page, leave this unchecked so you do not get two.
- *Table of contents* → *Include*, with a *Depth* setting and a *Placement* dropdown:
  - *Beginning* (default) places it in the front matter, before the first chapter.
  - *End* places it after the last chapter, before the bibliography.
  - *After {chapter}* places it right after a specific chapter you name.
- *Chapter heading* controls whether InkyCap supplies each chapter's top heading from the note's title, always, never, or only when a note has none of its own.
- *Wikilinks* → *Resolution* decides what the links between your notes become in the book: *Resolve to in-book chapters* turns them into jumps to the right chapter, *Link to source files (as in single-note compile)* keeps them pointing at the note files, and *Plain text only (strip linking)* leaves just the words.
- *Page numbering* → *Style* sets the scheme for the merged book. There are four: *Roman (i, ii, iii…) then arabic from chapter 1*; *Front matter unnumbered, chapters start at 1*; *Arabic numerals from page 1*; and *Arabic numerals starting at a specific page*, which adds a *Start on page* field. This choice only decides where Roman and Arabic numbering apply; the number format itself, and chapter and heading numbering, come from the *Style Overrides* tab.

=== Where the bibliography goes

The *Bibliography* dropdown decides both how reference lists are built and where they go:

- *Unified (one list at the back)*, the default, builds a single, consolidated reference list from the collection's bibliography file and places it at the end. Each note's own bibliography (if it has one) is ignored in favour of the consolidated one. \
- *Per chapter* ends every chapter with its own reference list, built from the collection's bibliography file and limited to the sources that chapter cites. Each chapter's list is numbered independently, which suits an edited volume where every author is credited with their own sources. Here too, each note's own bibliography is ignored.
- *In place (author-placed)* keeps each note's bibliography exactly where its author placed it. A book may contain several, so this is the choice when you have hand-placed categorized or per-section reference lists.

See #wikilink("7 - Citations and Bibliography") for how reference lists and citation styles work.

=== Giving credit: the byline and contributors

The *Contributors* roster is how a multi-author book gets a proper byline and credit page. For each person you can record:

- their *name*,
- a *bibliographic role*, which defaults to Author and can be Editor, Translator, Illustrator, and so on, and
- any number of *#link("https://casrai.org/credit")[CRediT] roles* (fourteen standard contribution categories used in scholarly publishing: Conceptualization, Methodology, Writing – original draft, Writing – review & editing, and the rest).

From this roster InkyCap builds the *title-page byline* (grouped by role), records the authors in the document's metadata, and (when at least one person has a CRediT role) adds an optional *contributions statement* on its own page. You can turn that statement off with the *include credit statement* option; the byline appears either way.

=== When a note will not compile

If some notes contain errors, the book export pauses with a *Some notes have errors* dialogue listing them. You can choose *Continue (exclude)* to leave those notes out and produce the rest of the book, or *Stop & fix* to go back and repair them first. (A problem in the book's own front matter is a hard stop, since there would be nothing to build.)

The finished file is named after your book's title and saved wherever you choose.

#callout("tip", title: "For Typst users")[Notes are inlined into one synthetic document anchored at the notebox root; per note the package import, the leading `#note(...)`, and (in Unified and Per chapter modes) any `#bibliography(...)` are stripped, and relative image paths are rebased. A label-collision scan blocks export if your own labels are duplicated across notes (the internal `<inkycap-*>` labels are exempt). The byline and CRediT statement are rendered by `#contributors-byline(...)` and `#credit-statement(...)` in the notebox package, so the formatting lives in editable Typst rather than hard-coded output. ]

== Publishing a collection as a website

*Collection as HTML files* turns your collection into a small, self-contained website (a set of interactive web pages you can host anywhere). InkyCap produces:

- one web page per note,
- an *index page* that lists and links to every page, and
- a stylesheet with a clean light-and-dark design that follows the reader's system preference.

Wikilinks between notes in the collection become ordinary clickable links between the pages, and any images, video, or audio are copied into the site so every page stands on its own. If a note will not compile it is skipped and reported, so you can fix it and export again. A published page is only included when it renders completely.

== Design, style, and customization

When you export a collection, InkyCap layers your styling automatically so the result looks deliberate and consistent: your app-wide defaults first, then the collection's own *Style Overrides* (paper size, margins, fonts, spacing, page and heading numbering), then any Typst template you have chosen for the collection, and finally your own custom Typst. You can find these settings in the collection's right-panel tabs; see #wikilink("2 - Collections") and #wikilink("2 - Settings").

- To *choose a Typst template for your collection*, open the collection's *Characteristics* tab and pick one from the *Typst Template* dropdown. It lists the templates you have installed, plus *None* and *Custom…* (which lets you type a package spec or a notebox path yourself). You must first install the template (see #wikilink("3 - Scaffolds, Templates, and Packages")).
- Choosing a template only makes it available. To actually apply it, click *Set up template…*, which appears once a template is chosen. This opens the collection's Custom Typst editor with the template's own setup already filled in, ready for you to add your title, authors, and whatever else the template asks for.
- The *Style Overrides* tab ends with a *Custom Typst* row. Use *Add…* (or *Edit…* once something is there) to write your own Typst styling, which is applied last and so wins over everything above it. The editor's *Insert template setup* button fills in the chosen template's setup for you, the same thing *Set up template…* does.

#callout("note")[When you choose a template, the controls on the *Style Overrides* tab are locked and a notice explains why: the template controls the layout, so those overrides would have no effect. Adjust layout through the template's own setup in the *Custom Typst* row instead. ]



== Related pages

- #wikilink("2 - Collections"): gathering notes so you can publish them together.
- #wikilink("7 - Citations and Bibliography"): reference lists and citation styles in your output.
- #wikilink("1 - Collaboration"): tracked changes and how they appear when you export.
- #wikilink("2 - Settings"): where to set the Pandoc path and other export preferences.
