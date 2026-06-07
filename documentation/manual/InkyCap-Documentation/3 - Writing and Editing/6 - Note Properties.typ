#import "/.inkycap/notebox.typ": *

#note(
  title: "Note Properties",
  description: "How to use note properties — the friendly typed metadata panel that powers collections, search, and portable Typst querying.",
  tags: ("documentation",),
)

= Note Properties

== What properties are

Every note in InkyCap can carry a little bit of structured information about itself: some are included with the system, such as a title, a description, some tags, collections it explicitly belongs to, etc. You also add any of your own. These are its _properties_: typed pieces of metadata that sit quietly at the very top of the note.

An easy way to work with them is the *Properties* tab in the right panel. You fill in fields, tick checkboxes, and pick dates without ever touching code. Behind the scenes InkyCap keeps everything in sync with the note's source.

Properties make your notes _findable_ and _organizable_. Once a note knows its own date, tags, and collection, InkyCap can gather it into the right #wikilink("2 - Collections"), surface it in searches, and let other tools read it too, all from the same small set of fields.

== Opening the Properties panel

+ Open any note in a tab.
+ Look to the *right panel* and choose the *Properties* tab.
+ You'll see one row per property already set on the note. If no note is open, the panel will read "No file selected".

The rows appear in the same order they're written in the note, so what you see in the panel always matches the note itself.

=== Anatomy of a property row

Each row has, from left to right:

- A *type icon* that also doubles as a *drag handle*. The icon tells you the shape of the value (text, number, checkbox, date, list, and so on). Drag it up or down to *reorder* your properties.
- The *property name*, shown exactly as written.
- The *value editor*, which changes depending on the property's type.
- A *kebab button* (`⋮`), labelled "Property options", that opens a small menu for that row.

== Common built-in properties

InkyCap understands a handful of properties out of the box. Their types are fixed, largely in support of different system features:

- *title* is a friendly name for the note (text).
- *description* is a one-line summary (text). This is also what shows up in tables of contents and previews.
- *tags* is a list of keywords. See #wikilink("5 - Tags") for how tags power browsing and filtering.
- *aliases* lists other names this note can be found under, entered as a comma-separated list (for example `working title, draft name`).
- *date* and *due* are calendar dates, chosen with a date picker.
- *task* is a checkbox, handy for turning a note into something actionable.
- *source* provides a field to include an associated URI.
- *collection* addresses any #wikilink("2 - Collections") that you explicitly assign this note to.

#callout("tip")[ You don't have to fill in every field or even any field. A note with just a _title_ and a couple of _tags_ is perfectly fine. Add more when a property is something you find useful. ]

== Editing values

The editor for each row matches its type, so you always get the right controls:

- *Text* fields are simple click-to-edit boxes. If you type a wikilink like `[[Some Note]]`, it becomes a clickable link right inside the value.
- *Number* fields accept digits only and gently warn you with "Not a valid number" if you slip.
- *Checkbox* fields are a single tick box; the property's name carries the meaning, so there's no separate true/false label.
- *Date* and *Date & time* fields open a calendar picker.
- *List* fields show your values as little chips. Click to open a dropdown of values already used elsewhere in your notebox, filter to narrow it down, or add a brand-new one with the `+ Add "..."` option. You
- The *collection* field has its own picker: click it to tick which collections the note belongs to. If you haven't made any yet, it'll say "No collections defined".

An empty property simply shows "Empty" until you click in and start typing.

== Adding a property

+ At the bottom of the Properties panel, click *+ Add property*.
+ Start typing in the box ("Create new or select existing property...").
+ A dropdown suggests known and previously-used property names. Ones built into InkyCap carry a small *system* badge. Click a suggestion to add it right away.
+ If you're inventing a *brand-new* field, a short type menu appears so you can choose what kind of value it holds: Checkbox, Date, Date & time, List, Comma list, Number, or Text.

Custom fields are a great way to track whatever matters to your work: a `status`, a reading rating, a course code, a manuscript word target, anything at all. InkyCap will remember the type you chose and offer that field as a suggestion on other notes too.


#callout("caution")[A list property differs from a comma list because it will provide you with an interface to select from within all of the options youve created. A comma list it a text field in which each item is separated by a comma. A comma list is likely most valuale in the case that you do not want use a large list inteface but still want to incorporate some pre-existing values.]


== Changing or removing a property

Open a row's kebab menu (`⋮`) for two choices:

- *Property type*, for your own custom fields, lets you switch the field's type. Changing a type updates that field across _every_ note that uses it, converting the existing values to fit. (Built-in fields have fixed types, so this option is hidden for them.)
- *Remove* takes the property off *this note only*, leaving other notes untouched.

#callout("note")[ Removing the very last property from a note tidies things up completely. InkyCap removes the whole metadata block rather than leaving an empty one behind. ]

== How properties are stored

You do not need to edit the source by hand because the right sidebar in the visual editor provides an interface but it helps to know what's happening. All of a note's properties live as named arguments to a single `#note(...)` call at the top of the file, just after the notebox import line. A note's properties might look like this in source mode:

```typ
#note(
  title: "My note",
  tags: ("draft", "research"),
  date: datetime(year: 2026, month: 6, day: 5),
  collection: ("Thesis",),
)
```

When you edit a field in the panel, InkyCap rewrites _only_ that one argument and leaves everything else exactly as it was. Your other values, spacing, and even comments are preserved. Reordering rows by dragging does the same: it just re-orders the arguments without disturbing their values.

#callout("tip", title: "For Typst users")[
  `#note(...)` comes from the bundled `inkycap-notebox` package and emits a `#metadata(...)` dict tagged with the stable `<inkycap-note>` label (at most one per file). That means any Typst toolchain can `query()` the label and read the same dictionary. Your metadata is plain, portable Typst (text), not a proprietary side-channel.

  A few coercions happen inside `note()`: the list-style fields (`tags`, `collection`, `aliases`) accept a bare string and wrap it into a one-element array; `aliases` additionally splits on commas; and `datetime` values are stringified to `YYYY-MM-DD`. A value of `[[Target]]` is serialized as a `link-ref("Target")` call so it joins the link graph (see #wikilink("4 - Links and Backlinks")).
]

== Typed and portable matters

Because properties are real, queryable Typst metadata under a stable label, InkyCap can index them efficiently and use them to provide features you'll meet elsewhere:

- *Collections* gather notes automatically by querying properties such as `collection` or `tags`, so getting your properties right is what makes #wikilink("2 - Collections") fill themselves.
- *Lists and pickers* offer up values you've already used across the notebox, keeping your vocabulary consistent.
- *Other Typst tools* can read the same metadata, so your notes stay useful outside InkyCap.

#callout("important")[ In the visual editor, the property block at the top of a note is hidden and locked so you cannot disturb it by accident. To change properties, use the Properties tab in the right panel (or switch to source mode where you can edit them inline). This keeps your metadata safe while you write. ]

== Related pages

- #wikilink("2 - Collections"). Gather notes automatically using their properties.
- #wikilink("5 - Tags"). Browse and filter by the `tags` property.
- #wikilink("4 - Links and Backlinks"). How `[[Target]]` values join your notes together.
- #wikilink("2 - Importing Existing Notes"). Map frontmatter from imported files onto properties.
