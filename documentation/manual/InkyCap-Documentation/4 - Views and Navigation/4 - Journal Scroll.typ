#import "/.inkycap/notebox.typ": *

#note(
  title: "Journal Scroll",
  description: "How to use Journal Scroll, InkyCap's continuous date-ordered timeline feed, including sort axis, anchor scope, navigation, and daily-note pairing.",
  tags: ("documentation",),
)

= Journal Scroll

Journal Scroll lets you read your notes as a single, continuous timeline. It is a flowing feed where one note follows the next in chronological order. It is ideal for daily notes, research logs, and journalling.

You pick a starting note (the _anchor_) and the feed shows the notes that come after it in time, each one rendered the way it looks in the HTML reading view, stacked one below the other. Scrolling carries you forward (or backward) through your notes in time.

Think of it as a newspaper of your own writing: a daily journal you can scroll through, a research log you can skim end-to-end, or a way to revisit a string of related notes without opening each in its own tab.

#callout("note")[ Journal Scroll is a reading and review surface inside the app, not a print preview. Its body text uses the editor's own reading font rather than your document's font, as a gentle reminder that you are looking at an app view. It never changes your notes; switching it on or off only affects what you see. ]

== Opening and closing the scroll

Journal Scroll is a per-tab view: turning it on, replaces the editor in the *current* note tab with the feed, anchored on the note you had open. There are three equivalent ways to switch it on or off:

+ *The editor-header button.* In the right-hand group of the editor header, look for the scroll icon. Click it to start the feed from the note you are viewing; its tooltip reads "Journal Scroll anchored from this note." Click again to turn it off.
+ *The command palette.* Run the command *Toggle Journal Scroll* (found under the Tools category).
+ *The keyboard.* Press `Ctrl+Shift+J`.

All three do the same thing: they anchor the feed on whatever note is active in the current tab. The view only works when you have a note (file) tab open.

When you turn the scroll off, the feed and its saved scroll position for that tab are discarded, and your ordinary editor returns untouched.

== How the feed flows

The anchor note is always the very top of the feed. From there, the scroll unfolds *downward* only. It never loads notes above the anchor. To see notes on the other side of the anchor in time, you flip the date direction (below) or re-anchor on a different note.

The feed loads in small batches as you scroll, so even a large notebox stays responsive: you get the anchor plus a first handful of notes, and more appear automatically as you reach the bottom. When you reach the end and there are no more notes to show, the feed stops being scrollable.

#callout("tip")[ If you ever feel "stuck" because scrolling won't take you back past your starting note, try using the date-direction toggle to point the feed the other way in time, or open a different note and re-anchor there. ]

== Choosing how notes are dated: "Sort by"

Because Journal Scroll is a _timeline_, it needs to know which date property to order your notes by. You choose this in #wikilink("2 - Settings"), under the *Behaviour* tab, in the *Journal Scroll* section. The control is labelled *Sort by*, and it sets "the axis the feed is ordered along." Your options:

- *File creation date* orders notes by when each file was created. This is the default.
- *File modification date* orders by when each note was last changed.
- *Note's zid property* orders by the note's Zettelkasten ID, a long numeric identifier either set as an explicit property or read from the filename.
- *Note's date property* orders by the `date` you record in a note's #wikilink("6 - Note Properties"), which is perfect for hand-dated journal entries.

This setting is saved per notebox, so each notebox can have its own timeline.

#callout("important")[ A note that is missing the date you chose is never dropped. It is placed in a second tier at the very end of the feed, ordered by file creation date. So nothing disappears; it just sorts last. ]

#callout("warning")[ If you imported your notes from another tool, their file creation and modification dates may all have been reset to the same day. In that case, sorting by *Note's date property* (which you author yourself) or the `zid` if you imported an equivalent, usually gives a truer timeline than the file dates. See #wikilink("2 - Importing Existing Notes"). ]

== Pointing the feed forward or backward in time

By default, the feed runs from recent toward older notes. Scrolling down moves you further into the past. You can reverse this with the *date-direction* toggle, which lives in the right panel beside the scroll-context indicator (not on the editor-header button).

While the scroll is on, the editor header shows a short status line telling you which way you are reading, for example "Viewing new to old from _\<note name>_" or "Viewing old to new from _\<note name>_." Toggling the direction rebuilds the feed; the anchor stays put, and only the temporal side that unfolds downward changes. The direction resets to recent-first each time you switch the scroll on.

== Confining the feed: "Anchor scope"

By default the feed may draw from your *entire* notebox. If you would rather keep it to one part of your notebox (say, only your journal entries) use the *Anchor scope* setting, also in *Settings → Behaviour → Journal Scroll*. It sets "the largest set of notes the feed may show." Your options:

- *All notes* (the whole notebox). This is the default.
- *Daily Notes folder* confines the feed to the folder you selected to store notes that the *Daily Note* creation rule writes into (and its subfolders).
- *Custom folder* reveals a *Custom scope folder* field where you type a folder path, relative to your notebox root. The feed is then confined to that folder and everything beneath it.

All folder scopes are recursive: the chosen folder _and_ its subfolders are included. Like *Sort by*, anchor scope is saved per notebox.

#callout("note")[ If you choose *Daily Notes folder* but your Daily Note rule has no fixed target folder set (its destination is entirely dynamic), there is no folder to scope to, and the feed quietly falls back to all notes. To fix this, give the Daily Note rule a fixed target folder under your creation rules. See #wikilink("3 - Setting Up Your Notebox"). ]

== Pairing with daily notes

Journal Scroll has no hard requirement for daily notes; it reads any notes. But the two were made for each other. Set *Sort by* to *Note's date property* (or *File creation date*) and *Anchor scope* to *Daily Notes folder*, and the feed becomes a clean, chronological journal you can scroll through day-by-day.

The notes that fill that folder come from the built-in *Daily Note* scaffold, reachable with `Ctrl+D`, which creates a dated note in your Daily folder. To learn how scaffolds and creation rules work, see #wikilink("3 - Scaffolds, Templates, and Packages").

== Reading and moving around an entry

Each note in the feed has a small header of its own:

- *Title.* Click the note's title to open that note in a new tab (useful when you want to edit the note).
- *Compile-warning button.* If a note has any compile issues (formatting problems), a warning button appears. Diagnostics stay hidden until you click it open; the button's tooltip tells you how many issues there are. If a note only partly compiled, the feed still shows what it can and skips the errored part, with a note explaining why.
- *Connection badges.* Small icons showing how that note relates to your anchor (described next).

Wikilinks inside the feed are smart about where they take you:

- A plain click on a link whose target is already part of this feed scrolls to it (or, if it isn't loaded yet, re-anchors the feed on it so it becomes the new top).
- A plain click on a link _outside_ the current feed opens it in a new tab.
- *Ctrl/Cmd-click* or *middle-click* always opens the target in a new tab.
- *Right-click* opens the link's context menu of open-as choices.

Header *back* and *forward* arrows let you retrace link jumps you made _within_ the scroll, separate from your tab's ordinary history. And in the right panel, a *Return to the anchor note* button jumps you instantly back to the top of the feed.

== Seeing how notes connect to the anchor

Journal Scroll highlights how each note relates to your anchor. There is no toggle to turn this on or off. A note that relates to the anchor shows a coloured strip down its left edge and one or more matching icon badges in its header, each with a tooltip. The relations are:

- *Anchor* is the note the feed is scrolling relative to.
- *Links to anchor* means this note contains a link pointing to the anchor.
- *Linked from anchor* means the anchor links to this note.
- *Shares tags* means this note shares at least one tag with the anchor.

This makes it easy to spot, at a glance, which notes in your timeline are part of the same conversation. To learn more about these relationships, see #wikilink("4 - Links and Backlinks") and #wikilink("5 - Tags").

== The right panel while you scroll

When Journal Scroll is on, the right panel sets aside its usual single-note tabs and shows *Scroll Context* instead (a live summary of just the entries currently in view). It includes the date-direction and return-to-anchor controls, plus four collapsible sections:

+ *Outline* lists the headings across all the visible notes; click one to scroll straight to it.
+ *Connections* are notes _outside_ the feed that link to or from what you are currently reading; click to open them in a new tab.
+ *Tags* shows which tags are concentrated in the notes on screen.
+ *Citations* are the references cited across the visible notes; click one to highlight where it appears.

Before you have scrolled any note into view, this panel invites you to "Scroll into the view to populate context." For more on the panels and overall layout, see #wikilink("1 - Views and Navigation").

== An example

#callout("example")[ Suppose you keep a daily research log.
+ In #wikilink("2 - Settings") → *Behaviour* → *Journal Scroll*, set *Sort by* to *Note's date property* and *Anchor scope* to *Daily Notes folder*.
+ Open today's daily note (press `Ctrl+D` to create one if needed).
+ Press `Ctrl+Shift+J`. The feed appears, anchored on today and unfolding into earlier days below.
+ Scroll down to revisit last week; click a note's title to open and edit it, or follow a wikilink to jump to a related idea.
+ Use the right-panel anchor button to leap back to today whenever you like. ]

== Related pages

- #wikilink("3 - Setting Up Your Notebox") (folders, creation rules, and the Daily Note rule that feeds the scroll).
- #wikilink("3 - Scaffolds, Templates, and Packages") (the daily-note scaffold behind dated entries).
- #wikilink("2 - Settings") (where *Sort by* and *Anchor scope* live).
- #wikilink("3 - Agenda, Tasks, and Dates") (another way to work with dated notes, tasks, and deadlines).
- #wikilink("1 - Views and Navigation") (how Journal Scroll fits among InkyCap's other views).
