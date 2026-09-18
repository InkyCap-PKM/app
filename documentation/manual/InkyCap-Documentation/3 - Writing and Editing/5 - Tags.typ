#import "/.inkycap/notebox.typ": *

#note(
  title: "Tags",
  description: "How tags work in InkyCap: adding inline and property tags, browsing them in the flat tag sidebar, and using them to build Collections.",
  tags: ("documentation",),
)

= Tags

== What tags are for

A _tag_ is a short label you attach to a note to group it with others on the same topic. Tag a handful of notes, for example `to-read`, `meeting`, or `submit`, and you can pull them all back together in a single click, without digging through folders.

Tags in InkyCap are more than visual labels: they are _queryable metadata_. That means InkyCap keeps a live index of every tag and which notes carry it, so the tag browser, search, and #wikilink("2 - Collections") all stay up to date automatically as you write.

#callout("note")[
Tags are a flat list by design; there is no nesting or tag hierarchy. A tag written like `project/alpha` will be treated as one plain label. Using wikilinks, custom properties, folders, and #wikilink("2 - Collections") can provide additional, rule-based organization.
]

== Two ways to add a tag

A note can be tagged in two ways, and both feed the same index. If the same name appears both ways on one note, it is counted once.

=== Tags as a note property

Tags are primarily intended to be used at the very top of a note as a document property, alongside the note's title, author, and other properties, see #wikilink("6 - Note Properties"):

```typ
#note(tags: ("research", "typst"))
```

These live in the note's metadata, outside of the content. You can edit them as source or through the property panel. Tags support better retrieval of your notes through a special search parameter and are useful for grouping notes in a collection filter.

In the *Properties* panel, the *tags* row is a visual picker. Click it, or press Enter while it has the focus, and a list opens of the tags already set on your other notes, so you can reuse a name rather than retype it. Type to narrow the list, move through it with the arrow keys, and press Enter to add or remove the highlighted tag. If you type a name that isn't there yet, an `+ Add "..."` row lets you create it; Escape closes the list. #wikilink("6 - Note Properties") describes the picker in full.

#callout("warning")[The `tags:` property does *not* split on commas. Writing `tags: "a, b"` gives you one tag literally named `a, b`. To record two separate tags, use an array with each name in its own quotes: `tags: ("a", "b")`. (This is deliberate, so a tag that genuinely contains a comma isn't quietly broken apart.)]

=== Inline tags

Rather than place tags within the note's content, it is usually better to use wikilinks as an organizational principle. That creates a note to serve as a way of connecting ideas (even if it lacks content). However, in some cases it might be useful to include a metadata property within the note content so it is also possible to place a tag anywhere in the body of a note. You can type the tag function with the name in quotes: 
```typ
#tag("methodology")
```

In the visual editor this shows up as a coloured tag icon followed by the name (the `#` is just a visual indicator in the markup, not part of the tag's name). In your finished, rendered document it appears as an inline box (you can turn that off, as shown below).

#callout("tip", title: "For Typst users")[Both forms emit `[#metadata((name: name)) <inkycap-tag>]`, so everything resolves through `typst query` against the stable `<inkycap-tag>` label. The `tags:` property is a list field: a bare string is coerced to a one-element array, and an explicit empty `tags: ()` is preserved in source. Property and inline names are merged and de-duplicated per note in the index.]


== Browsing and finding notes by tag

Open the *Tags* sidebar by clicking the *Tags* button in the left sidebar's mode rail. The pane lists every tag in your notebox as a flat list, each row showing the tag name and a count of how many notes carry it.

You can shape the list to suit you:

- *Sort* with the sort button. The default is *Alphabetical (A – Z)* but you can choose *Alphabetical (Z – A)*, *Quantity (high – low)*, or *Quantity (low – high)*.
- *Filter* with the filter button, which reveals a *Filter tags…* box. Type a few letters to narrow the list to matching names.

*Click any tag* to open the search panel pre-filled with that tag, listing every note carrying it. (If you have no tags yet, the pane simply reads "No tags found.")

You can also search by tag directly from the #wikilink("1 - Views and Navigation") search panel using the `tag:` prefix, for example `tag:research`. You may combine this with the rest of InkyCap's search language. For example to find all of your research notes on owls, you might write a search expression that includes the word `owl` and includes `tag:research`, which will limit the scope of your results to only files tagged with `research` and that contain the word `owl` somewhere in their content.

#callout("note")[Tag matching in search is _case-insensitive_ and matches on _part_ of the name, not the whole thing. So `tag:rust` will turn up notes tagged with any of the following:  `Rustacean`, `rust-lang`, or `rust`.]

== Renaming and deleting tags

_Right-click_ any tag in the *Tags* left sidebar for two notebox-wide actions:

+ *Rename* lets you type a new name inline and press Enter. If a tag with that name already exists, InkyCap asks whether to *merge* the two; confirming folds them together everywhere.
+ *Delete* removes the tag from every note that uses it (you'll be asked to confirm, since this cannot be undone).
\

== Using tags to build collections

Tags are useful in #wikilink("2 - Collections"), a living, rule-based group of notes. A collection filter can include or exclude notes by tag:

- `file.tags.contains("rust")` matches notes that carry the tag (shown as *contains* in the filter builder).
- `!file.tags.contains("rust")` matches notes that don't (*not contains*).
- `tags.isEmpty()` matches notes with no tags at all.

In the Collections filter builder, `file.tags` lives under the *File* group of properties. Because the rules are evaluated live, any note you tag later automatically joins the collection, with no manual upkeep.

== Showing or hiding tags in your output

By default, inline tags appear as small boxes in reading mode and in exports. If you'd rather keep them as invisible organizing metadata, go to *Settings → Appearance → Rendering Defaults* and turn off *Show inline tags*. The tags still index and remain fully searchable; they just don't print.

#callout("note")[This setting affects rendered and exported output only. In the visual editor, the tag remains visible so you can see and click your tags while writing.]

== Tags elsewhere in InkyCap

Tags help in a few other places:

- In #wikilink("4 - Journal Scroll"), the Scroll Context panel surfaces a *Tags* section showing which tags concentrate across the entries you're viewing.
- On export, a note's `tags:` become PDF keywords or HTML `<meta>` tags, helping your published work be found.
- Tasks can carry their own tags too (see #wikilink("3 - Agenda, Tasks, and Dates")).

== Related pages

- #wikilink("6 - Note Properties"). Set tags and other metadata at the top of a note.
- #wikilink("4 - Links and Backlinks"). The other half of InkyCap's connect-your-notes toolkit.
- #wikilink("2 - Collections"). Turn tags into living, rule-based groups.
