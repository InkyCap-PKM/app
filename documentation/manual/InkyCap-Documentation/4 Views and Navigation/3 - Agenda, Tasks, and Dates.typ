#import "/.inkycap/notebox.typ": *

#note(
  title: "Agenda, Tasks, and Dates",
  description: "Track to-dos and deadlines inside your notes with tasks and dated reminders, and see them all gathered in one place in the Agenda panel.",
  tags: ("documentation",),
)

= Agenda, Tasks, and Dates

Use tasks and dates to keep track of things you need to do and dates you can't afford to miss (these will appear inside your notes) and then see every one of them gathered in a single list. If you've ever scattered "finish the abstract" or "grant due Friday" across a dozen documents and then lost track, this will help you.

InkyCap works based on two ideas:

- A *task* is a checkbox item. It is something to do, optionally with a due date and tags.
- A *date* is a standalone dated reminder. It is a deadline or form of milestone with no checkbox.

You write these naturally as you type and the *Agenda* panel collects all of them from across your notebox into one place that you can sort, filter, and search.

== Creating a task

A task is a checkbox you can mark as complete. There are three easy ways to make one. Pick whichever suits your need.

=== The quick shortcut: type a checkbox

At the start of a line, type a checkbox marker followed by a space:

- Type `- [ ] ` (a hyphen, a space, square brackets, a space) and it becomes an empty task with your cursor ready inside it.
- Type `- [x] ` and it becomes a task that's already marked done.

_This is a Markdown-style shortcut that InkyCap recognizes for tasks but translates to appropriate Typst markup._ Your indentation is kept, so tasks nested under a list stay where you put them.

=== The slash command

Type `/` anywhere you're writing to open the menu, look under the *InkyCap* category (or type the word `task` or `due`, and choose:

- *Task* inserts an empty task with your cursor inside the quotes.
- *Due date* inserts an empty dated reminder.

This works in both the everyday writing view and the source view. If you're not sure of the exact markup, the slash menu is an easy path.

=== Once you have a task

A task shows up as a checkbox and the text beside it. You can give it a due date and tags too. To edit any of these in the writing view, click the small circled `#` pill that appears beside the task when your cursor is on its line. A menu appears with:

- a *Task* field (placeholder: "What needs doing?") for the task text,
- a *Due* field (placeholder: "YYYY-MM-DD") for the deadline,
- and a *Mark as done* / *Mark as not done* toggle.

#callout("tip")[
  To tick a task as completed, click its checkbox. The text gets a strikethrough so you can see at a glance it's finished. Click again to un-tick it.
]

== Creating a standalone dated reminder

Sometimes you don't have a to-do. You just have a date to remember, like a conference or a submission window. That's a *date* (a dated reminder). Insert one with the *Due date* slash command, or fill in an empty one's pill.

A dated reminder shows as a small date badge in your note. Click its `#` pill to set:

- a *Date* (required; a reminder must have a valid date),
- and an optional *Description* (placeholder: "Optional caption") to give the short text that the Agenda will show for it.

#callout("important")[
  If you don't give a dated reminder a description, the Agenda has nothing to label it with, so it falls back to showing the note's title. If several reminders live in the same note, give each one a description so you can tell them apart in the list.
]

== A whole note as one agenda item

The third way to create a task (or date due item) is to mark an *entire note* as a task or give it a deadline, using its properties (see #wikilink("6 - Note Properties")). 

In the inline property panel, add:

- a *task* property checkbox (leave it unchecked for "to do", tick it for "done"); or
- a *due* property to give the whole note a deadline date.

The note will then appear in the Agenda as a single item, using its title as the text.

#callout("note")[
  A plain *date* property does _not_ put a note on the Agenda. Many notes carry a `date` as their creation or authoring date, and including those would flood your list. Only a *due* date property or a *task* property makes a note an agenda item.
]

== The Agenda panel

The Agenda gathers every task and dated reminder across your whole notebox to display in one list. Open it from the left-sidebar buttons. Look for the calendar-with-a-check icon (*Agenda*), which sits just after Collections.

The panel keeps itself up to date automatically as you add, edit, finish, rename, or delete things.

=== Sorting, filtering, and searching

Above the list you'll find a few controls:

+ *Task List* narrows what's shown: *All* (the default), *To do*, *Done*, or *Dates only* (just the standalone reminders, no checkboxes).
+ *Tags* shows only items carrying the tags you select. It's a multi-select that matches any of the tags you pick, and only lists tags actually in use right now. (See #wikilink("5 - Tags").)
+ *Sort* offers a small sort button that lets you order by *Due (Sooner – Later)* (the default), *Due (Later – Sooner)*, creation date, ZID, or name, in either direction. Items with no value for whatever you're sorting by, sink to the bottom of the list.
+ A search box (*"Filter agenda items…"*) that matches text in the item, its note's title, or its tags.

=== Reading the list

Each row tells you what kind of item it is at a glance:

- A checkbox (☑ done, ☐ to do) marks tasks.
- A small clock-on-a-calendar icon marks standalone dated reminders.
- Dated items show a date badge. If a *to-do* task's deadline is _before today_, the date is highlighted as overdue so it stands out. (Finished tasks are never flagged overdue.)

Dates follow whatever format you've chosen in #wikilink("2 - Settings") under Appearance, so they read the way you expect.

=== Opening and finishing items

- *Click a row* to jump straight to the note that contains it. *Ctrl/Cmd-click* or *middle-click* opens it in a new tab instead, and *right-click* gives you *Open* and *Open in New Tab*.

#callout("warning")[
  The checkbox shown in the Agenda list is a status indicator, not a button. Clicking a row opens the note rather than ticking the task off. To actually mark something done, do it in the note itself: click the task's checkbox in the writing view, use its pill menu, or toggle the *task* property for a whole-note item.
]

== Tasks inside callouts and quotes

You're not limited to writing tasks in the main flow of a note. A task placed inside a callout, a block quote, or an annotation still shows up as a working checkbox, and you can tick it off right there without opening it for editing.

== The literal markup

#callout("tip", title: "For Typst users")[
  Tasks and dated reminders are real Typst function calls from the bundled `inkycap-notebox` package, auto-imported into every note. Everything above is a friendly front-end over these:

  ```typ
  #task("Draft abstract")                              // open task
  #task("Draft abstract", done: true)                  // completed
  #task("Submit", due: "2026-06-23", tags: ("work",))  // dated + tagged
  #task("Submit", due: datetime(year: 2026, month: 6, day: 23))
  #due("2026-07-01")                                   // bare dated reminder
  #due("2026-07-01", label: "Keynote")                 // labelled
  ```

  The `body` of a `#task` is a required string; `done:` defaults to `false`; `tags:` accepts a string or an array. A `#due` requires a valid date and takes an optional `label:`.

  Dates accept either a quoted ISO string (`"2026-06-23"`) or a `datetime(...)`; both render correctly, and the date axis is canonically ISO `YYYY-MM-DD` throughout. The pill editors always write the quoted-string form. At the document level, your `#note(...)` can carry `task: true|false` and `due: "YYYY-MM-DD"` to make the whole note one agenda item.

  Both primitives emit a queryable `<inkycap-agenda>` label, which is how the Agenda finds them across the notebox.
]

== A collection's own agenda

If you organize notes into a #wikilink("2 - Collections", display: "collection"), that collection can show its members as an *Agenda* instead of a table. This is handy for, say, a course or a specific project: every task and deadline belonging to that collection, will appear in one focused view.

To set one up, open the collection's table, use the *Add view* (the *+* button), and choose *Agenda view*. The result uses the same Agenda list functionality that you already know, but scoped to just that collection's members. (Membership follows the collection's filter; a note appears because it matches that filter, not because of any manual marker.)

== Related pages

- #wikilink("6 - Note Properties") (mark a whole note as a task or give it a deadline).
- #wikilink("5 - Tags") (categorize tasks and filter the Agenda by tag).
- #wikilink("2 - Collections") (build a collection-scoped agenda view).
- #wikilink("4 - Journal Scroll") (for date-oriented, day-by-day writing).
- #wikilink("2 - Settings") (choose how dates are displayed).
- #wikilink("3 - Keyboard Shortcuts") (faster ways to move around InkyCap).
