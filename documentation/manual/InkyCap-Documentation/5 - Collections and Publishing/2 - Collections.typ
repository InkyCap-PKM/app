#import "/.inkycap/notebox.typ": *

#note(
  title: "Collections",
  description: "How collections turn your notes into a queryable, spreadsheet-like database: membership, filters, the table and agenda views, and CSV export.",
  tags: ("documentation",),
)

= Collections

A *collection* gathers related notes into a single, spreadsheet-like view that you can sort, filter, and edit in place. Think of it as a saved question you ask your notebox ("show me every note for my thesis" or "every note in the Research folder that still has an open task"), which is answered as a living table that updates itself as you write.

A collection is _not_ a folder. *It does not move, copy, or contain your notes*. It is a stored query plus a view, so the same note can appear in several collections at once without ever leaving its place in your notebox's file tree structure.

#callout("note")[
  Collections are stored automatically inside your notebox and managed for you. You do not need to find or organize the collection files by hand. Create them from the *Collections* section in the left sidebar with the *"+"* button, give the collection a name, and a starter table appears.
]

#callout("tip", title: "Technical background")[
  A collection is a single YAML file with the `.collection` extension, kept in the reserved `.inkycap/collections/` folder at your notebox root. The file holds a global filter group, one or more view definitions, optional style overrides, and book-export metadata; but you edit all of it through the collection's panels, never as text.
]

== How notes join a collection

Membership is decided entirely by *filters*. There is no separate "add to collection" list to maintain. A note shows up when it matches the collection's rules. There are two complementary ways to write those rules, and you can mix them freely.

=== The simple way: the "collection" property

The most direct path is to tag a note with the collection's name using the note's *collection* property. The `collection` property is a built-in list, so one note can declare membership in several collections at once.

You set it from the note's right-panel *Properties* editor (see #wikilink("6 - Note Properties")). Add the collection's name to the list. When you create a named collection, InkyCap automatically sets up a rule that includes any note carrying that name, so this "just works".

#callout("tip", title: "For Typst users")[
  The property lives in the note's `#note(...)` call as a list:
  ```typ
  #note(collection: ("My Paper", "Thesis"))
  ```
  Markdown imports map a YAML `collections:` key onto it automatically.
]

=== The powerful way: filters on any property

You don't have to touch a note at all to include it. A collection can gather notes by _any_ criterion (the folder they live in, their #wikilink("5 - Tags"), a date, a checkbox, or any property you've defined) using nested *All / Any / None* filters. This lets you build a collection like "include everything in my Research folder _or_ tagged `my-paper`, but _not_ the collection file itself" without editing a single note.

The two approaches coexist by design: the default rule that matches your collection name sits inside an *"Any"* group precisely so you can add alternatives (a folder, a tag, a property test) right beside it.

== Building filters

Open the Collection's filter editor with the *Filter* button on the collection's toolbar. Filters are built from nested *groups*, not a flat list of rules, so you can express things like "(A or B) and C".

Each group has one combinator, shown as a plain-language label:

- *All*: Every rule in the group must be true.
- *Any*: At least one rule must be true.
- *None*: None of the rules may be true.

The group's caption reads back to you, for example "All of the following are true". Inside a group you add:

+ *"+ Add filter"* adds a single rule (a leaf).
+ *"+ Add filter group"* adds a nested sub-group, for combining ideas. Groups can nest up to three levels deep.

A single rule is a *property*, an *operator*, and a *value*. The operators are:

- *equals* / *not equals*
- *contains* / *not contains*
- *is empty* / *is not empty* (no value needed)

Pick the property from a dropdown grouped into *Properties* (the ones you've authored) and *File* (built-in details like the folder, file name, or modified date). When you're done, press *Apply*.

#callout("important")[
  An *empty filter matches every note*. A brand-new collection with no rules yet will list your whole notebox until you narrow it down. 
]

#callout("note")[
  When a rule compares a _list_ property (like `collection` or `tags`) against a single value, it tests *membership* ("is this value in the list?"). So a "contains" rule on `tags` finds notes that carry that tag, and the collection-name rule finds notes that list that collection.
]

#callout("tip", title: "For Typst users")[
  Filter rules are stored as small expression strings you can also hand-author. Property references can be bare (`title`), bracketed for awkward keys (`note["due-date"]`), file metadata (`file.folder`), or a self-reference to the collection file (`this.file.name`). `contains` is a case-sensitive substring match, an absent property counts as empty, and a malformed expression *fails closed*; it's simply skipped rather than matching by accident. The default filter keeps a collection out of its own results with `file.name != this.file.name`.
]

== Views: tables and agendas

A collection can show more than one *view*, each with its own filters, columns, and sorting. Views appear as tabs across the top of the collection. The *"+"* button adds a view and asks whether you want a *Table view* or an *Agenda view*.

- Rename a view by double-clicking its tab.
- Reorder views by dragging their tabs.
- Delete a view with its *×* (though the first view always stays, so you never end up with an empty collection).

When tabs overflow, buttons will appear to let you scroll. InkyCap remembers which view you were last looking at for each collection.

== The table view

The table is the heart of a collection: one row per matching note, one column per property you choose to show. It behaves like a familiar spreadsheet.

*Opening notes.* The file-name cell is a link. Click it to open the note, or Ctrl/Cmd-click (or middle-click) to open it in a new tab. Right-click any row for *Open note*, *Open in new tab*, or *Export note…*.

*Editing in place.* Click most cells to edit them directly: type a value and press Enter to save (Esc cancels). Checkboxes toggle with a single click. _Whatever you type is written straight back into the note's properties_, so the table is a real editing surface, not just a report.

#callout("note")[
  Columns drawn from file details (the folder, path, dates, size) are *read-only*, since they come from the filesystem itself. Everything you authored as a property is editable.
]

*Choosing columns.* The *Columns* button opens a checklist of every available property; tick the ones you want to appear as columns. Drag column headers to reorder them. The file-name column is always present.

*Sorting.* Click a column header to sort by it, cycling through ascending (▲), descending (▼), and back to none. The header you sort by shows the arrow so you always know the current order.

#callout("tip")[
  Friendly labels keep headers readable. File details show as "Folder Name", "Modified Date", "File Extension", and so on, even though InkyCap stores their precise technical keys behind the scenes.
]

== The agenda view

An *agenda* view trades the grid for a #highlight[focused list of tasks and dated items pulled from the collection's member notes (a deadline board scoped to exactly this set of notes)]. It uses the same membership rules as the table, so the two never disagree, and it needs no special opt-in: filter-based membership is enough.

Clicking an item opens its note (Ctrl/Cmd or middle-click for a new tab). If a collection has no tasks or dated items, the view says so plainly. For the full picture of how tasks and due dates work across your notebox, see #wikilink("3 - Agenda, Tasks, and Dates").

== Exporting to a spreadsheet

When you want your collection's data outside InkyCap (in a spreadsheet like LibreOffice Calc, Excel, Numbers, Google Sheets, or a statistics tool), use the *Export* button and choose:

- *Table as CSV* writes comma-separated values, the universal spreadsheet format.
- *Table as TSV* writes tab-separated values, handy when your text contains commas.

The export mirrors exactly what you see: the active view's columns, filters, and sort order. Values are quoted and escaped correctly, lists are joined into a single cell, and empty cells stay empty. You'll get a confirmation once the file is saved.

#callout("note")[
  CSV and TSV are the _spreadsheet_ exports; they capture your collection properties as data. The same *Export* menu also renders the notes themselves into PDFs, a merged book, an HTML site, or Markdown files. Those publishing workflows, including the book metadata and structure options, are covered on #wikilink("3 - Exporting and Publishing").
]

== Related pages

- #wikilink("6 - Note Properties"): the typed metadata that becomes your collection's columns and filters.
- #wikilink("5 - Tags"): a natural way to drive collection membership.
- #wikilink("3 - Agenda, Tasks, and Dates"): how the agenda view's tasks and deadlines are authored.
- #wikilink("3 - Exporting and Publishing"): turning a collection into PDFs, a book, or a website.
