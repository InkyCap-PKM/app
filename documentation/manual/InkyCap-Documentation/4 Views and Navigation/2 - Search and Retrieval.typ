#import "/.inkycap/notebox.typ": *

#note(
  title: "Search and Retrieval",
  description: "How to search across the whole notebox and within a single note, the search operators and filters, saving searches as bookmarks, Quick Open, find-and-replace, and bookmarks.",
  tags: ("documentation",),
)

= Search and Retrieval

InkyCap gives you several ways to get back to what you need: a notebox-wide *Search* panel, a quick find-and-replace _inside_ the note you're editing, a keystroke to jump straight to any file, and *bookmarks* for the places you return to often.

This page covers each of them, the search operators you can use, and how to run a replacement across many files without causing yourself grief.

== Searching the whole notebox

Open the *Search* panel from the left sidebar, or press `Ctrl+Shift+F` (the "Search in Notebox" command). Type into the box at the top and results appear as you pause typing; press `Enter` to search immediately without waiting.

#callout("note")[
*InkyCap searches for whole words by default.* Typing `ink` finds the word _ink_, but it does *not* match _inkycap_ or _inking_. This keeps results precise. To match partial words, use the truncation operator described below.
]

=== Whole words versus `*` truncation

Because the default is whole-word matching, use the asterisk `*` when you want a stem to match longer words:

- `ink*` matches _ink_, _inkycap_, _inking_, and anything else starting with "ink".
- `*ography` matches _bibliography_, _typography_, and so on.
- `d*g` anchors at both ends, matching _dog_, _debug_, _digging_, and similar.

Think of `*` as "any run of characters here". Without it, you get the exact word and nothing more.

=== Operators

You can combine terms with a small query language. The Search panel has a *Search tips* overlay (the question-mark/tips button) that lists these inline, but here they are in full:

#table(
  columns: 2,
  stroke: 0.5pt + luma(200),
  inset: 7pt,
  [*Operator*], [*What it does*],
  [`"exact phrase"`], [Find an exact multi-word phrase by wrapping it in straight double quotes.],
  [`AND`], [Both terms must appear. Two words with no operator between them are already treated as `AND`, so `tax law` means `tax AND law`.],
  [`OR`], [Either term may appear: `cat OR dog`.],
  [`NOT`], [Exclude a term: `cat NOT dog`.],
  [`-term`], [Minus sign is shorthand for `NOT`: `cat -dog`.],
  [`( )`], [Group sub-expressions, including nested groups: `(cat OR dog) AND vet`.],
  [`a W/5 b`], [Proximity, *ordered*: _a_ appears within 5 words *before* _b_.],
  [`a N/5 b`], [Proximity, *any order*: _a_ and _b_ appear within 5 words of each other.],
)

#callout("tip")[
Boolean operators (`AND`, `OR`, `NOT`) must be written in *uppercase* so InkyCap can tell them apart from ordinary words you're searching for.
]

=== Filters

Prefix a term with one of these filters to narrow the search to a specific kind of match rather than the note body:

#table(
  columns: 2,
  stroke: 0.5pt + luma(200),
  inset: 7pt,
  [*Filter*], [*What it matches*],
  [`tag:research`], [Notes carrying a given #wikilink("5 - Tags", display: "tag").],
  [`property:status=draft`], [Notes whose #wikilink("6 - Note Properties", display: "property") has a value. Bare `property:status` matches any note that has that property at all.],
  [`section:methods`], [Notes that contain a heading matching the keyword.],
  [`file:2026`], [Match by file name.],
  [`path:journal`], [Match by the file's path within the notebox.],
  [`annotation:fixme`], [Match text inside an `#annotation[…]` or `#suggestion[…]`. Bare `annotation:` finds any note that has annotations.],
  [`collection:Reading`], [Limit results to notes belonging to a particular #wikilink("2 - Collections", display: "collection").],
)

Filters combine freely with the operators above, so `tag:research methods -draft` is a perfectly good query.

=== Search options

Three toggles next to the search box change how matching works:

- *Case sensitive* makes the search respect the exact upper- and lower-case letters you typed. Off by default.
- *Use regex* treats the whole query as a regular expression, for when the operators above aren't enough. The phrase, boolean, and filter syntax does not apply in this mode — it's raw regex.
- *Annotation scope* is a three-way switch: *All text* (the default), *Annotations only* (search just inside annotations and suggestions. An empty query in this mode lists _every_ annotation in the notebox), or *Exclude annotations* (search prose only and ignore annotation text).

=== Reading and arranging the results

Results are grouped by file, with a match count beside each file name. Click any line to open that note at the match; when a note opens this way, *all* of its matches are highlighted so you can scan them.

- *Expand / Collapse results* shows or hides the matched lines under each file. You can also override one file at a time with the chevron on its row.
- *Show more context* widens each result to include a couple of lines above and below the match, so you can read the surrounding text without leaving the panel. (The note's leading `#import` line is always hidden from results.)
- *Sort order* offers Relevance (the default), File name A–Z or Z–A, and Modified or Created time, newest or oldest first. A file whose name matches your query exactly jumps to the top.
- Long result sets are *paginated* in pages of 500, with Previous / Next buttons and a `{from}–{to} of {total} results` counter.

== Saving a search as a bookmark

A query you run often can be saved so you never retype it. Run the search, open the *More actions* menu at the bottom of the Search panel, and choose *Bookmark search expression…*. The query is stored in your #wikilink("1 - The InkyCap Interface", display: "Bookmarks panel"); clicking it later reopens the Search panel with the query already filled in and re-run. (See #wikilink("1 - The InkyCap Interface") for how bookmarks work in general.)

== Quick Open: jump straight to a file

When you already know roughly _which_ note you want, you don't need full search. Press `Ctrl+O` for *Quick Open*, a fast file finder. Start typing part of a file's name and InkyCap fuzzy-matches it, ranking the closest matches first and breaking ties by most-recently-edited. An empty box lists your files newest-first. Use the arrow keys (or `Page Up` / `Page Down`, `Home` / `End`) to move the selection and `Enter` to open it. If a file lives in a folder, the folder is shown beside its name.

Think of Quick Open as "go to file" and the Search panel as "find this text".

== Finding and replacing inside the current note

Within the note you're editing, press `Ctrl+F` to open the find bar at the bottom of the editor. Use *Next* and *Previous* (or `Enter` / `Shift+Enter`) to step through matches, or turn on *All* to highlight every match at once. The same options you know from search are here: *Match case*, *Regexp*, and *By word* (whole-word matching). `Escape` closes the bar.

To replace within the note, press `Ctrl+H` ("Find and Replace (in note)"), or reveal the replace row from the find bar's disclosure chevron. Type a replacement and use *Replace* for the current match or *Replace all* for the whole note. The replace row stays tucked away until you ask for it, so you won't trigger a replacement by accident.

== Replacing across the whole notebox

InkyCap can also replace text in *every* file at once. This command has no keyboard shortcut, reach it through the *command palette* (`Ctrl+P`) by running *Search and Replace (notebox-wide)*. It opens the Search panel with a replacement field; enter a query and a replacement, then use *Replace all* to apply it across the notebox, or *Replace in this file* on a single file group to limit the scope. It honours the *Case sensitive* and *Use regex* toggles (regex replacements can use capture groups such as `$1`).

#callout("warning", title: "Notebox-wide replace is not undoable in one step")[
A notebox-wide replacement edits many files at once and there is no single "undo" that reverses all of them. Before running one:

- *Preview first.* Run the same query as a plain search and read the results, so you know exactly what will change and where.
- *Be specific.* A short or common term will match far more than you expect. Lean on whole-word matching, phrases, or filters to tighten the query.
- *Keep a safety net.* If your notebox is under #wikilink("1 - Collaboration", display: "git sync") or you keep backups, make sure you can roll back. Use the command palette (`Ctrl+P`) and select the "Backup notebox now" option. The lack of a shortcut for this command is itself a guardrail — treat it with the same care.
]

== Other ways to find your notes

Search and Quick Open are the direct tools, but several other features in InkyCap are really about retrieval too:

- *Collection filters.* A #wikilink("2 - Collections", display: "collection") gathers notes that match a saved filter (for example `status == "draft"` or `tags.contains("research")`). That's a standing, reusable query you build once and revisit, rather than a one-off search — and you can fold a collection into a search with the `collection:` filter above.
- *Links and backlinks.* Following #wikilink("4 - Links and Backlinks", display: "wikilinks and backlinks") is navigation by deliberate connection.
- *Tags.* The #wikilink("5 - Tags", display: "tag") browser groups notes by the labels you've given them.
- *Mycelial View.* The #wikilink("5 - Mycelial View") surfaces connections you _haven't_ made yet, rather than ones you're searching for.

#callout("note")[
A saved search is one of three kinds of *bookmark* InkyCap keeps (alongside notes and collections). For how bookmarks work and all the ways to create them, see #wikilink("1 - The InkyCap Interface").
]

== Related pages

- #wikilink("1 - The InkyCap Interface")
- #wikilink("2 - Collections")
- #wikilink("4 - Links and Backlinks")
- #wikilink("5 - Tags")
- #wikilink("5 - Mycelial View")
- #wikilink("3 - Keyboard Shortcuts")
