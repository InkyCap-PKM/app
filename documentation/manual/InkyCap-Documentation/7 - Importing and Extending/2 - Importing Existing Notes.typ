#import "/.inkycap/notebox.typ": *

#note(
  title: "Importing Existing Notes",
  description: "How to bring Markdown and Obsidian notes into InkyCap: importing a folder or vault, mapping YAML frontmatter to properties, and pasting Markdown.",
  tags: ("documentation",),
)

= Importing Existing Notes

== Bringing your existing notes in

If you already keep notes in markdown files (including in a tool like Obsidian), you don't have to start from scratch. InkyCap can read those files, convert their markdown format into Typst-formatted notes, and tidy up their links, images, and metadata along the way. This page walks you through importing a whole folder of notes, and through the smaller everyday task of pasting a snippet of Markdown into a note you're already writing.

#callout("note")[
Import always runs *into the notebox you currently have open*. There is no separate "create a notebox from an import" wizard. If you want a clean slate, first create or open an empty notebox (see #wikilink("3 - Setting Up Your Notebox")), then import into it.
]

== Importing a Markdown folder or Obsidian vault

InkyCap reads your notes from an *archive* (a `.zip` or `.tar.gz` file), so the first small step is to bundle your notes up.

+ Put the notes you want to import (and any images they reference) into one folder, then compress that folder into a `.zip` or `.tar.gz` archive. If you're importing an Obsidian vault, just zip the whole vault folder. InkyCap knows how to read it (you may later want to delete some of the files that are not useful to InkyCap).
+ In InkyCap, open *Settings* and go to the *Import/Export & Backup* tab.
+ Under *Import markdown files*, click *Choose archive…* and pick your archive in the file picker.
+ Confirm (or change) the *Source dialect*, then click *Run import*.

That's the whole process. InkyCap scans your files, may ask you a few questions about your metadata (see _Mapping your properties_ below), converts everything to Typst, and copies your images into place. When it finishes you'll see a summary like _"Imported 123 note(s) and 16 file(s)."_

#callout("important")[
You need a notebox open before you can import. If none is open, InkyCap stops you with _"No notebox is open. Open a notebox first."_ Open or create one, then try again.
]

=== Standard or Obsidian: which dialect?

When you pick your archive, InkyCap peeks inside. If it finds the tell-tale `.obsidian` folder, it auto-selects the *Obsidian* dialect for you; otherwise it chooses *Standard*. You can always override the choice before running the import.

The difference is mostly about how the `#` and `$` characters are treated:

- *Obsidian* treats extras (`#tag` hashtags, `$math$`, and `%%comments%%`) and assumes any literal `#` in your text was written as `\#`.
- *Standard* treats every `#` as a plain character. Choose this for ordinary (non-Obsidian) Markdown so that things like a price (`$3000`) or an issue reference (`#42`) come through intact rather than being mistaken for special syntax.

#callout("tip")[
If you're not importing from Obsidian, *Standard* is likely the right choice. When in doubt, run a small test archive of a handful of notes first and see how they look.
]

== Mapping your properties

Many notes carry metadata at the top (a title, tags, a date, a list of aliases). For Markdown notes this typically lives in a *YAML frontmatter* block. InkyCap turns that metadata into #wikilink("6 - Note Properties"), the typed fields that InkyCap understands.

Because your field names might not match InkyCap's, a *Map imported properties* dialogue appears whenever frontmatter is found. (If your notes have no frontmatter, this step is skipped and the import just proceeds.) For each field you'll see:

- *YAML property* is the original field name, a sample value, and how many files use it.
- *Maps to* is where it should go. You can map it onto a built-in *system property*, onto one of *your* existing custom properties, *create a new property* for it, or choose *Don't import* to leave it out.
- *Type*, for a brand-new property, is what kind of value it holds: Text, Number, List, Comma list, Date, Date & time, or Checkbox. When you're mapping onto an existing property, the type is fixed for you.

InkyCap makes sensible first guesses. Common names map themselves automatically. For example `title` becomes the title, `tags` (or `tag`) becomes tags, `aliases` becomes aliases, `date`/`created` becomes the date, and `description`/`summary` becomes the description. Anything it doesn't recognize is offered up as a new property named after your field, with its type guessed from a sample value.

#callout("note")[
You can map your own field onto a system property, but you can't *create a new* property that uses a reserved system name. InkyCap will ask you to map onto it instead. Empty values and deeply nested YAML are quietly dropped.
]

#callout("tip", title: "For Typst users")[
Frontmatter lands as a `#note(...)` call at the top of each imported note. It uses the same typed-metadata mechanism you'd write by hand. Values are parsed with proper YAML typing (lists, numbers, booleans, ISO dates), and a frontmatter value of `"[[Name]]"` is emitted as a real reference rather than a quoted string:
```typ
link-ref("Name")
```
]

== What converts, and what to expect

InkyCap's converter handles the everyday building blocks of Markdown and turns them into their Typst equivalents. You generally don't need to think about any of this (it just happens), but here's the shape of it:

- *Headings, bold, italic, lists* (bulleted and numbered, including nesting) all carry over.
- *Task lists* (`- [ ]` and `- [x]`) become InkyCap tasks, so they show up in your #wikilink("3 - Agenda, Tasks, and Dates").
- *Tables, blockquotes, and code blocks* convert directly, with code-block languages preserved.
- *Obsidian callouts* like `> [!note] Title` become InkyCap callouts.
- *Highlights* (`==like this==`) and editorial *CriticMarkup* (insertions, deletions, comments) are recognized.

Links get special care, which is what makes your notebox feel connected from day one:

- A `[[Wikilink]]` (or `[[Name|Display text]]`) becomes an InkyCap wikilink; see #wikilink("4 - Links and Backlinks") for how these power navigation and automatic backlinks.
- An internal link to another `.md` file is turned into a wikilink to that note.
- An external web link or e-mail address stays a normal link.

#callout("warning")[
A few things have honest limits. Footnotes are recognized but their text isn't fully re-attached, so check any footnotes after import. Headings deeper than four levels may draw a warning when rendered to the web. And LaTeX math needs special handling; see below.
]

=== Math from Markdown

Markdown math is written in LaTeX, which Typst doesn't typeset on its own. Simple expressions that happen to be valid Typst (like `E = mc^2`) come through as native math and just work. More elaborate LaTeX is handled one of two ways:

- If the *#link("https://typst.app/universe/package/mitex")[mitex]* Typst package is installed in your notebox, the LaTeX is wrapped so it renders properly.
- If not (the default), the equation is kept verbatim as a code block so *nothing is lost* and the note still compiles. The import summary will remind you that you can install the `@preview/mitex` package and re-import to render it. See #wikilink("3 - Scaffolds, Templates, and Packages") for installing packages.

#callout("note")[
Math is only interpreted in the *Obsidian* dialect, since plain Markdown has no math syntax.
]

== Your images and attachments

You don't have to move images around by hand. Both standard Markdown images (`![alt](path/picture.png)`)  and Obsidian-style embeds (`![[picture.png]]`)  are copied into your notebox's attachment folder, and the note is pointed at the new location. You set that folder under *Settings → Files → Attachment folder* (it's called *Assets* by default).

A few details worth knowing:

- Images are matched by filename, the way Obsidian looks them up, so it doesn't matter which subfolder they lived in.
- Web-hosted images (`http://`, `https://`) are left exactly as they are.
- Image *alt text* is carried over.
- Hidden folders such as `.obsidian` and `.trash` are skipped.
- If an image is referenced but missing from your archive, InkyCap reports it as an error rather than guessing. That way you can find and fix it.

#callout("tip")[
Include your images in the same archive as your notes. If you export your notes without their attachments, the references will still convert, but the pictures won't be there to copy in.
]

== Pasting Markdown into a note

For smaller jobs (a paragraph from a webpage, a snippet from a colleague) you don't need a full import. With a note open, run the *Paste from Markdown* command (find it in the command palette under _Edit_ or filter the palette by typing `markdown`). InkyCap reads the Markdown from your clipboard, converts it to Typst, and drops it in at your cursor.

This quick paste always uses the *Standard* dialect (things like prices or references survive) and applies InkyCap's default property guesses without asking; it's meant to be fast and unobtrusive.

#callout("note")[
On Linux, this command reads the system clipboard directly and has been a little finicky to trigger in some setups. If a paste doesn't seem to take, a full archive import is reliable.
]

== Round-trips (import and export)

InkyCap aims to keep importing and exporting evenly matched; tables, highlights, callouts, and the like travel both directions (you can export InkyCap's Typst notes into Markdown notes). Nevertheless, conversion between formats is not necessarily perfect. After a large import it's worth verifying some notes to confirm that everything landed the way you expect, especially footnotes and any complex math.

== Related pages

- #wikilink("3 - Setting Up Your Notebox"). Create or open the notebox you'll import into.
- #wikilink("6 - Note Properties"). How the metadata mapping ends up in your notes.
- #wikilink("4 - Links and Backlinks"). What your converted wikilinks unlock.
- #wikilink("3 - Scaffolds, Templates, and Packages"). Installing the mitex package for LaTeX math.
- #wikilink("3 - Exporting and Publishing"). Sending notes back out to Markdown and other formats.
