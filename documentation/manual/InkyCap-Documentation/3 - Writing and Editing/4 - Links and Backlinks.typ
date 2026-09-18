#import "/.inkycap/notebox.typ": *

#note(
  title: "Links and Backlinks",
  description: "How to connect notes with wikilinks, link to headings, use aliases, follow external links, and read the automatic backlinks every note collects.",
  tags: ("documentation",),
)

= Links and Backlinks

Link related ideas to each other to organize your ideas or information as a knowledge graph. InkyCap tracks connections in both directions. InkyCap makes links between notes easily visible in different contexts while you're working with your notes. They also are valuable to making use of other InkyCap functionality such as the Mycelial View.  \


== Creating a link to another note

The fastest way to link notes is to use the InkyCap shortcut of typing two square brackets:
```typ
[[
```

As soon as you type `[[`, a small search picker opens. Start typing part of a note's name and InkyCap fuzzy-matches your notes as you go (it searches your notebox's `.typ` files). An empty search lists every note.

To choose a note:

- Use *ArrowUp* and *ArrowDown* to move through the list.
- Press *Enter* to insert the link.
- Or use the mouse to select from the list.

When you pick a note, InkyCap completes the visual editor's wikilink with `]]` and writes out the real underlying Typst markup for you. You don't have to type it yourself, but here is what it looks like:

```typ
#wikilink("My Other Note")
```

The text between the quotes is the target note's file name (without its extension).

#callout("tip")[ You can also select some text first, then type `[[` to wrap your selection in a link.  The complete wikilink looks like `[[filename]]` in the visual editor]

=== Linking to a note that doesn't exist yet

You don't need to create a note before you can link to it. If the name you type doesn't match any existing note, the picker shows an extra row at the bottom:

- *Create: {name}* inserts the link now; the note itself is created whenever you first click through to it.

When that first click happens, InkyCap makes the note with the built-in *New Note* creation rule, the same one behind the *New Note* button and *Ctrl+N*. So a note born from a link starts with the same content (title, date, and so on) and lands in the same folder as any other new note; only its file name comes from the link. Creation rules are described in #wikilink("3 - Scaffolds, Templates, and Packages").

#callout("note")[ Note names are unique across a notebox and regardless of which folder it appears within. This means every link must resolve to exactly one note. If you ever try to create a note whose name is already taken (with the *New Note* button, for example), InkyCap stops and asks what you meant: *Open existing note*, *Append ZID* (offered when Zettelkasten IDs are turned on), or *Use a different name*. ]

This is a natural way to write: #highlight(fill: rgb("#c8f0c8"))[jot down a link to an idea you haven't fleshed out, keep writing, and fill in that note later]. Until the note exists, InkyCap marks the link as *unresolved* so you can tell at a glance which links still need a destination. An unresolved link gets a distinct style in the visual editor (and a dashed-icon "create" affordance in the Links panel, described below).

== Showing different text on a link

Sometimes the note's file name isn't the wording you want in your sentence. You can give a link its own display text. In the underlying markup this is the `display:` option:

```typ
#wikilink("Theory of Mind", display: "how we model other minds")
```

The link still points to the same note, but your sentence reads naturally. An alternative technique is to use the `aliases` property (see below).

== Aliases: letting a note answer to several names

Often one note deserves more than one name. A note titled "Machine Learning" might also be referred to as "ML." Aliases let a note be found and linked by any of its alternate names.

You set aliases as a note property (covered in #wikilink("6 - Note Properties")). In the property's value, list the alternate names separated by commas (for example `ML, Machine Learning`). InkyCap splits that on the commas, so each becomes its own alias.

Once set, aliases feed the wikilink picker. When you type an alias, the picker shows the real note with a muted hint like *via alias "ML"*, and choosing it inserts a link that *displays* the alias text while still pointing at the right note:

```typ
#wikilink("Machine Learning", display: "ML")
```

#callout("important")[ Aliases help you *find and label* a link in the picker, and they set the displayed text. They do not, by themselves, create a backlink under a made-up name: backlinks are resolved by the actual note file name. A link will register as a backlink as long as it points at a real note file. ]

== Linking to a specific heading

A link can jump not just to a note but to a particular section inside it. Use InkyCap's shortcut by typing a double colon after the note name to pick a heading.

After you've chosen a note in the picker, you have two ways into *heading mode*:

- Type `::` after the note name (for example `[[My Note::`), or
- Press *Tab* on a highlighted note in the list.

The picker then shows that note's headings, indented by level, followed by any labels its writer has attached to prose, figures, or equations (a label row leads with the words it tags, with the label's name underneath). A footer reminds you: "Select a heading or label to link straight to that spot". If the note has neither, the picker says "No headings or labels in this note". Choose one, and InkyCap inserts a link that lands the reader on that exact spot and scrolls it into view. The underlying markup uses the `label:` option:

```typ
#wikilink("My Note", label: "the-section")
```

The footer hints inside the picker walk you through this:

- "Type :: after a note name to link to a heading"
- "…or press Tab on a page above to pick from its headings"

#callout("tip", title: "For Typst users")[A wikilink is a Typst function: `#wikilink(name, display: none, label: none)`. The positional `name` is the file stem; `display:` overrides the rendered text; `label:` anchors to a heading. Every call also emits queryable `<inkycap-link>` metadata (`(target, from: "body")`) which is the source that backlinks are determined from. When you target a heading, InkyCap reuses the heading's existing label if it has one, otherwise it slugifies the heading text and inserts a `<label>` into the target note so the anchor is stable. That is why, in the visual editor's bracket form, you see the label *slug* (`My Note::the-section`) rather than the human heading text; the slug is the editable `label:` source. ]

== Following links as you read and write

Wikilinks are clickable wherever they appear:

- *Click* a link to open the note in your current tab. If the note doesn't exist yet, the click creates it.
- *Ctrl/Cmd-click* or *middle-click* to open it in a new tab instead.
- *Right-click* for more options: *Open in new tab*, *Open in Journal Scroll tab*, and *Open in Mycelial View tab*.

These behave the same everywhere a link can appear: in the body of a note, inside callouts and quotes, in the property editor, and in the #wikilink("4 - Journal Scroll").

For more on how the editor renders links as you move your cursor, see #wikilink("2 - Editing Notes").

== External links: the web, e-mail, files

Links can point outside of your notebox. You can link to websites, an e-mail address, or a file on your computer.

The `/` command palette has two ready-made inserts:

- *Wikilink* (under "InkyCap") inserts a note link.
- *Link* (under "Insert") inserts an external link with its own text:

```typ
#link("https://inkycap.org")[friendly text]
```

In the source editor, a bare web address or a `#link(...)` becomes clickable with *Ctrl/Cmd+Click*. Hold the modifier key and hover, and InkyCap shows a "Ctrl/Cmd+Click to follow link" tooltip with a pointer cursor.

Where a link goes depends on what it is:

- Addresses with a scheme (`https`, `http`, `mailto:`, `zotero://`, and the like) open in your operating system's default handler (your browser, mail app, or reference manager).
- A path that starts with `/`, (or on Windows, a drive letter such as `C:\`), is treated as a file inside your notebox and opened with its default application.

=== Pasting a web address

You can also paste a web address straight from your clipboard. What happens depends on where your cursor is:

- If you have *selected some text* first, a small *Paste as* popup appears with two choices. *Link* turns your selection into the link's text (`#link("https://…")[your words]`), and *Plain text* replaces the selection with the address itself. Use the arrow keys and *Enter*, or click, to choose; *Escape* cancels.
- If nothing is selected, the address is simply inserted as text. There is no popup, because the visual editor already shows a bare web address as something you can click.
- If your cursor is already inside the address part of a `#link(...)` call, the pasted address drops straight into place.


== Backlinks matter: the reciprocal model

When you mention (link) one note inside another, two things happen:

+ Clicking the link takes you straight to the other note (and creates it for you if it doesn't exist yet).
+ The other note automatically gains a *backlink*, a record that says "this note links to me." 

This reciprocal model is what lets your notebox grow into a connected web rather than a pile of loose files. The more you link, the more your notes gain new contexts for your work and consideration. Over time, you can build thousands of connections, which the #wikilink("5 - Mycelial View") will visualize into concepts your notes themselves suggest you might explore.

You read these connections in the *Links* tab of the right-hand panel. It has three collapsible sections, each with a count and a remembered open/closed state:

+ *Inbound Links* are the notes that link *to* the note you're viewing (its _backlinks_). Expand a row to preview the line where the link appears, with optional surrounding context; double-click a row to toggle that preview.
+ *Outbound Links* are the notes your active note links *out to*. Links to notes that don't exist yet show up as *unresolved*, with a dashed file icon and a *create* button; clicking the row or the button makes the missing note on the spot.
+ *Possible wikilinks* are notes that *mention this note's name in plain text* but haven't actually linked to it yet.  

The panel gives you a few ways to find notes in a busy list:

- *Sort links* by name, modified date, created date, or ZID (the Zettelkasten identifier, if your notes carry one), ascending or descending. Unresolved entries always sort to the bottom.
- *Expand previews / Collapse previews* show or hide the context lines for every row at once.
- *Filter links by name* with a search box ("Search within links...") that narrows the lists. It supports the full search syntax (quoted phrases, `AND`/`OR`/`NOT`, and filters like `tag:`, `file:`, `path:`, and `property:`) scoped to just this note's links. (For more on tags, see #wikilink("5 - Tags").)

#callout("note")[When you first open a large notebox, InkyCap builds its link index in the background. The Links panel may look empty for a moment and will fill in automatically once that finishes. ]

=== Links survive renaming and moving

You can rename or reorganize freely without breaking your links' connections. The setting *Auto-update links on rename* ("Automatically update wikilinks when a file is renamed") is on by default. When you rename a note, InkyCap rewrites every link that pointed at the old name (in both the bracket and full forms) so they all follow the note to its new name.

=== For Typst users

#callout("tip", title: "Advanced Typst users")[ Links and backlinks flow through Typst-native metadata. Both body wikilinks and metadata `link-ref` values emit the `<inkycap-link>` label (`from: "body"` vs `from: "metadata"`), and backlinks are the reverse of those edges. Resolution matches a target to a file by *case-insensitive stem*; when several files match, the shortest path wins, and heading suffixes (`Note::heading`) are stripped first. A `link-ref(name)` value lets a typed property in `#note(...)` point at another note and still produce a real backlink. Whether wikilinks render in reading mode and export is governed by the *Show inline wikilinks* setting (default on), which maps to a `#set-notebox(show-inline-wikilinks: …)` state you can also override per document. When exporting a collection as a book, a separate *Wikilinks* option lets you resolve links to in-book chapters, keep them pointing at source files, or strip them to plain text. ]
\

== Related pages

- #wikilink("6 - Note Properties"). Where you set a note's aliases.
- #wikilink("2 - Editing Notes"). How links render as you write.
- #wikilink("5 - Mycelial View"). See your links as a visual map of connections.
- #wikilink("5 - Tags"). Another way to group and find related notes.
- #wikilink("4 - Journal Scroll"). A continuous reading surface where links stay live.
