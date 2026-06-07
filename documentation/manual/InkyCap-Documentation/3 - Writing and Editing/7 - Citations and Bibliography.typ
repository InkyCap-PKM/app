#import "/.inkycap/notebox.typ": *

#note(
  title: "Citations and Bibliography",
  description: "How to connect a bibliography (file or Zotero), browse and insert citations, choose a citation style, render the reference list, copy a formatted bibliography, and read citation warnings.",
  tags: ("documentation",),
)

= Citations and Bibliography

InkyCap is designed for academic writing across every discipline so it treats citations and your bibliography as first-class tools. This page shows you how to connect your references, cite a source with a couple of keystrokes, pick a citation style, and have InkyCap build your reference list for you. If you are new to the editor, you may want to read #wikilink("1 - Writing and Editing") first.

== The quick version

Basic process to cite in InkyCap:

+ Point InkyCap at your references once, in #wikilink("2 - Settings") under the *Citations* tab (a BibTeX file or your local Zotero database).
+ While writing, type `@` and pick the work you want. InkyCap inserts a short citation key like `@otlet1934`.
+ When you read or export the note, InkyCap automatically gathers your citations into a formatted reference list at the end, in the style you chose.

The rest of this page explains each step and the options around it.

== Connecting your references

Open #wikilink("2 - Settings") and go to the *Citations* tab. The first choice is *Citation source* (where InkyCap looks for your bibliographic information). You have two options.

=== Option 1: a bibliography file

Choose *Bibliography file (.bib, .yml, .json)*. This is the default, and it covers the most common reference formats:

- *BibTeX* files (`.bib`), the format most reference managers can export.
- *Hayagriva YAML* files (`.yml` or `.yaml`).
- *CSL JSON* files (`.json`).

In the *Bibliography file* field you give a notebox-relative path, such as `references.bib`. If you leave it empty, InkyCap auto-detects a file for you, looking for `references.bib`, then `references.yml`, then `references.json`, and using the first one it finds. You can also click *Browse* to pick a file; if it lives inside your notebox, InkyCap stores the path relative to your notebox root so it stays portable.

#callout("tip")[ The simplest setup is to drop a file named `references.bib` at the top of your notebox and leave the path field blank. InkyCap will find it on its own. ]

=== Option 2: your Zotero database

If you keep your references in #link("https://zotero.org")[Zotero], choose *Zotero database*. InkyCap then reads directly from your Zotero library.

In the *Zotero database path* field you point InkyCap at your `zotero.sqlite` file. The easiest way is to click *Detect*, which searches the usual locations on your computer automatically (it shows *Detecting…* while it works). Because this is the location of your Zotero install, it is a *global* setting. Once set, it applies to all your noteboxes.

#callout("note")[ When you select Zotero as your reference source, InkyCap generates its own bibliography file from your Zotero library (at `.inkycap/zotero-export.bib`), which enables the rest of the application's citation machinery to read this information. This is created automatically and kept up-to-date; you do not need to manage it. However if you make some changes to a reference in Zotero while using InkyCap, you can force a quick refresh in InkyCap by clicking the `Refresh Bibliography` button in the upper right of the References panel.  ]

== Choosing a citation style

The *Citation style* setting controls how your citations and reference list are formatted (author–date, footnotes, numbered, and so on). The default is *Chicago (Author-Date)*. Built-in styles include:

- *Chicago (Author-Date)* and *Chicago (Notes)*
- *APA* and *APA (7th)*
- *MLA*
- *IEEE*
- *ACM*, *ACS*, *AIP*, *AMA*
- *Future Medicine*, *GB/T 7714 (Numeric)*

If your discipline or publisher needs a style not in the list, choose *Custom CSL file…* and point InkyCap at a `.csl` style file using *Browse…*. A custom style is set per notebox and takes precedence over the global named style. Get more styles from the #link("https://citationstyles.org/")[Citation Style Language project].

#callout("important")[ The citation style you choose here is a *default*. As the setting itself notes, it "can be overridden in rendered output per file or by collection." So one notebox can default to Chicago while a particular #wikilink("2 - Collections", display: "Collection") is set to use its own style and publishes output using MLA. ]

#callout("tip", title: "For Typst users")[ InkyCap does not invent its own citation format. It uses Typst's native citations end to end. Style names map to hayagriva's archived CSL styles, and all formatting flows through hayagriva (the same engine behind Typst's `#bibliography`). The resolution order is: a per-notebox custom `.csl` file, then the global named style, then a fallback to `chicago-author-date`. Source selection, the bibliography path, and the custom CSL path are per-notebox; the named-style default and the Zotero database path are global. ]

== The References sidebar

Once a source is configured, open the *References* tab in the right-hand panel (its icon is a quotation mark, beside the Links tab). This is your home base for everything to do with citations. It has two parts.

=== Browse references

Click *Browse references* to expand the list of every work in your bibliography. From here you can:

- *Filter* the list. Type in the *Filter entries…* box to fuzzy-search by key, title, author, or year. Wrap your text in `"double quotes"` for an exact phrase match.
- *Sort* with the sort menu, which offers *Date added (new – old)* (the default), date added the other way, and title, author, or year, each ascending or descending. Your choice is remembered.
- *Refresh* reloads your bibliography (and, for Zotero, re-exports it) so newly-added works appear.

A small badge tells you how many entries you have and whether they come from *Zotero* or a *File*. If some entries could not be read, you will see a "skipped" note explaining that a few entries had formatting errors in the source.

*To insert a citation, just click a row.* InkyCap drops `@key` at your cursor. If a reference came from Zotero, the row also offers an *Open in Zotero* link.

#callout("note")[ If you see "No bibliography configured. Check Settings › Citations.", it means InkyCap has not found a source yet. Return to the *Citations* tab and set one. ]

=== Citations in this file

Below the browser, the *Citations* section lists every work cited in the note you are currently editing, de-duplicated. It is a quick way to see your sources at a glance. When the note cites at least one work, a *Copy formatted bibliography* button appears here too. There is more on that below.

== Inserting a citation while you write

There are three ways to cite, so you can use whichever fits your flow.

=== Type @ (the quickest)

Type `@` anywhere in your text and a search popup opens over your whole bibliography, with a preview pane showing authors, year, title, and entry type. Then:

- *Arrow Up / Arrow Down* to move through results,
- *Enter* or *Tab* to accept (this inserts `@key` and closes the popup),
- *Escape* to dismiss.

A citation key starts with a letter, so typing `@sm` narrows to works whose key begins that way. Here is what a finished citation looks like in your source:

```typ
@otlet1934
```

Typst-style citations also accept a page or other supplement:

```typ
@otlet1934[p. 64]
```

If you ever need a literal at-sign (for example, in an e-mail address) escape it with a backslash `\` so InkyCap never mistakes it for a citation:

```typ
\@notacitation
```

=== Search references and cite

Press `Ctrl+Shift+C` to open the *Search references & cite* picker, a focused overlay where you can search by key, title, or author and press *Enter* to insert the citation. This is handy when you want a larger search surface than the inline popup.

=== The slash and command menus

Type `/` for the command palette and choose *Citation* to start a citation at your cursor, or *Bibliography* to insert an explicit reference-list call. These are the same actions available through InkyCap's command palette. See #wikilink("2 - Editing Notes") for more on the slash menu.

#callout("tip")[ In the visual editor, each citation shows as a tidy pill displaying `@key`. Right-click a pill and choose *Convert to advanced citation* if you want the function form instead. ]

== How your bibliography appears

Here is the part that makes citing painless: *you usually do not have to add a reference list yourself.*

When you switch to reading mode or generate a preview, InkyCap checks whether your note cites anything real and, if so, automatically adds a formatted reference list at the end (in your chosen style) so your citations resolve and the bibliography appears. Your note file on disk is never changed; this happens only in the rendered view.

InkyCap is careful here: it only treats `@something` as a citation when that key actually matches an entry in your bibliography. So an e-mail address like `user@domain.com` in your prose will not accidentally become a citation.

If you would rather control exactly where the reference list sits, you can write the bibliography call yourself. The slash menu's *Bibliography* entry inserts one for you, and it looks like this:

```typ
#bibliography("/references.bib")
```

You can add a style to that call too:

```typ
#bibliography("/references.bib", style: "apa")
```

#callout("note")[ The path begins with `/`, which InkyCap treats as your notebox root, so the reference works no matter where the note lives or how it is later exported. In Typst, the position of this call only decides *where the list renders* (conventionally the end); your citations resolve across the whole document regardless. ]

#callout("tip", title: "For Typst users")[ The auto-injection is conservative. If your note already has an explicit `#bibliography(...)`, InkyCap leaves it in place but adds your preferred `style:` if you did not specify one (otherwise Typst would fall back to its IEEE default). Otherwise it appends `#bibliography("<path>", style: "<style>")` only when at least one extracted key really exists in your bibliography, or when the note uses `attribution: <...>`. Unmatched keys are escaped to `\@` so they render literally. ]

== Copying a finished bibliography

Sometimes you want a static, formatted reference list you can paste anywhere (into an e-mail, a handout, or a note that should not depend on a live bibliography call). When the current note cites at least one work, the *Citations* section shows a *Copy formatted bibliography* button. Click it and InkyCap renders your cited references, in your notebox's citation style, as a frozen snapshot on your clipboard. Paste it into any note and it renders identically, with no `#bibliography(...)` needed.

You will see "Formatted bibliography copied to clipboard" when it succeeds, or "No references to copy" if there was nothing to copy.

#callout("warning")[ This static-copy feature works with *BibTeX* (`.bib`) and *Hayagriva YAML* (`.yml`) sources. *CSL JSON* (`.json`) bibliographies can be browsed and cited, but cannot yet be rendered to a frozen reference list. ]

== When a citation looks like an error

If you write in *source mode*, you may notice the language server flag a citation with a message like "label does not exist in the document." This is expected and harmless: when InkyCap checks a single note on its own, no bibliography is in scope yet, so the citation has nothing to point at.

To reassure you, InkyCap adds a note to that warning whenever the key is a genuine bibliography entry:

- *"this citation resolves automatically in the preview, where the bibliography is added for you."*

In other words, your citation is fine. It will resolve as soon as you preview or read the note. A warning that does *not* get this friendly hint usually means a real typo (for example, a cross-reference to a label that does not exist), which is worth checking.

== Importing notes from Zotero or BibTeX

If your Zotero items or BibTeX entries carry attached #highlight(fill: rgb("#ffd1e0"))[notes or annotations], you can pull that text straight into your writing. Use the command palette `Ctrl+P` to select *Import note text from reference (Zotero / BibTeX)* command: search for a reference that has a note attached, then choose the note to insert its plain text at your cursor. This is a quick way to bring research annotations into your draft.

== When you export

The Export dialogue includes an *Include bibliography in output* checkbox. When it is on, "The bibliography will appear at the end of the document." When it is off, "Citations resolve normally, but the rendered bibliography is omitted from the output." This is useful when a publisher supplies the reference list separately. See #wikilink("3 - Exporting and Publishing") for the full export workflow, and #wikilink("2 - Collections") for how a whole collection or book handles its bibliography.

== Related pages

- #wikilink("2 - Settings"). The *Citations* tab, where your source and style live.
- #wikilink("3 - Exporting and Publishing"). Bibliography options when you export.
- #wikilink("2 - Collections"). Per-collection style overrides and book-wide reference lists.
- #wikilink("1 - Writing and Editing"). The broader editing context for inserting citations.
