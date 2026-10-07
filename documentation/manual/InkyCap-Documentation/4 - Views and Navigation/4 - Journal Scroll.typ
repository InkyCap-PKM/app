#import "/.inkycap/notebox.typ": *

#note(
  title: "Journal Scroll",
  description: "How to use Journal Scroll, InkyCap's continuous date-ordered feed of notes, including Timeline and Neighbourhood, sort axis, anchor scope, navigation, daily-note pairing, and composing a new note from linked notes.",
  tags: ("documentation",),
)

= Journal Scroll

Journal Scroll lets you read your notes as a single, continuous timeline. It is a flowing feed where one note follows the next in chronological order. It is ideal for daily notes, research logs, and journalling.

The note that you're currently working with in the editor is your starting note (the _anchor_) and the feed shows the notes that come after it in time, each one rendered the way it looks in the HTML reading view, stacked one below the other. Scrolling carries you forward (or backward) through your notes in time.

Think of it as a newspaper of your own writing: a daily journal you can scroll through, a research log you can skim end-to-end, or a way to revisit a string of related notes without opening each in its own tab.

#callout("note")[Journal Scroll is a reading and review surface inside the app, not a print preview. Its body text uses the editor's own reading font rather than your document's font. It cannot change your notes; switching it on or off only affects what you see. ]

== Opening and closing the scroll

Journal Scroll is a per-tab view: turning it on, replaces the editor in the *current* note tab with the feed, anchored on the note you had open. There are three equivalent ways to switch it on or off:

+ *The editor-header button.* In the right-hand group of the editor header, look for the scroll icon. Click it to start the feed from the note you are viewing; its tooltip reads "Journal Scroll anchored from this note." Click again to turn it off.
+ *The command palette.* Run the command *Toggle Journal Scroll* (found under the Tools category).
+ *The keyboard.* Press `Ctrl+Shift+J`.

All three do the same thing: they anchor the feed on whatever note is active in the current tab. The editor-header button is only there when a note (file) tab is open. If you run the command or press the shortcut with no note in front of you (an empty tab, a collection, or a freshly opened window), InkyCap opens your most recently modified note in a new tab and starts the scroll from there.

When you turn the scroll off, the feed and its saved scroll position for that tab are discarded, and your ordinary editor returns untouched.

== Timeline and Neighbourhood

While the scroll is on, a two-part switch in the editor header picks which notes the feed holds:

- *Timeline* (the default) is every note within your *Anchor scope*, unfolding in time from the anchor. Most of this page describes it.
- *Neighbourhood* is the anchor together with every note it links to and every note that links to it. The anchor stays at the top and its whole neighbourhood follows below it, in date order, so nothing linked to the anchor is hidden on the other side of it in time. The *Anchor scope* setting doesn't apply here.

In Neighbourhood, every note but the anchor is shortened to what connects it to the anchor: each passage that links to the anchor, with the paragraph before and after it. A note the anchor links to (that doesn't link back) shows its opening instead. A gap where text was left out shows as \[…\]. When a note has more than this, a *Show more* strip runs along its bottom; click it to show the whole note in place, and click *Show less* to shorten it again.

Switching rebuilds the feed from the anchor; the date direction stays as it was. Each time you switch the scroll on, it starts in Timeline.

== How the feed flows

The anchor note is always the very top of the feed. From there, the scroll unfolds *downward*. To see notes on the other side of the anchor in time, you flip the date direction (see below for details) or re-anchor on a different note.

The feed loads in small batches as you scroll, so even a large notebox stays responsive: you get the anchor plus a first handful of notes, and more appear automatically as you reach the bottom. When you reach the end and there are no more notes to show, the feed stops being scrollable.

#callout("tip")[ If you ever feel "stuck" because scrolling won't take you back past your starting note, try using the date-direction toggle to point the feed the other way in time, or open a different note and re-anchor there. ]

== Choosing how notes are dated: "Sort by"

Because Journal Scroll is a _timeline_, it needs to know which date property to order your notes by. You choose this in #wikilink("2 - Settings"), under the *Behaviour* tab, in the *Journal Scroll* section. The control is labelled *Sort by*, and it sets "the axis the feed is ordered along." Your options:

- *File creation date* orders notes by when each file was created. This is the default.
- *File modification date* orders by when each note was last changed.
- *Note's zid property* orders by the note's Zettelkasten ID, a long numeric identifier either set as an explicit property or read from the filename.
- *Note's date property* orders by the `date` you record in a note's #wikilink("6 - Note Properties"), which is useful for hand-dated journal entries.

This setting is saved per notebox, so each notebox can have its own timeline.

#callout("important")[A note that is missing the date you chose gets placed in a second tier at the very end of the feed, ordered by file creation date. So nothing disappears; it just sorts last. The exception is the anchor: if the note you start from is missing that date, its file creation date places it among the dated notes, so the feed still continues from the notes nearest to it in time. ]

#callout("warning")[If you imported your notes from another tool, their file creation and modification dates may all have been reset to the same day. In that case, sorting by *Note's date property* (which you author yourself) or the `zid` if you imported an equivalent, usually gives a truer timeline than the file dates. See #wikilink("2 - Importing Existing Notes"). ]

== Pointing the feed forward or backward in time

By default, the feed runs from recent toward older notes. Scrolling down moves you further into the past. You can reverse this with the *date-direction* toggle, which lives in the right panel beside the scroll-context indicator (not on the editor-header button).

While the scroll is on, the editor header shows a short status line telling you which way you are reading, for example "Viewing new to old from _\<note name>_" or "Viewing old to new from _\<note name>_." Toggling the direction rebuilds the feed; the anchor stays put, and only the temporal side that unfolds downward changes. The direction resets to recent-first each time you switch the scroll on.

== Confining the feed: "Anchor scope"

By default the feed may draw from your *entire* notebox. If you would rather keep it to one part of your notebox (for example, a folder with only your journal entries) use the *Anchor scope* setting, which is in *Settings → Behaviour → Journal Scroll*. It sets "the largest set of notes the feed may show." Your options:

- *All notes* (the whole notebox). This is the default.
- *Daily Notes folder* confines the feed to the folder you selected to store notes that the *Daily Note* creation rule writes into (and its subfolders).
- *Custom folder* reveals a *Custom scope folder* field where you type a folder path, relative to your notebox root. The feed is then confined to that folder and everything beneath it.

All folder scopes are recursive: the chosen folder _and_ its subfolders are included. Like *Sort by*, anchor scope is saved per notebox.

#callout("note")[If you choose *Daily Notes folder* but your Daily Note rule has no fixed target folder set (its destination is entirely dynamic), there is no folder to scope to, and the feed will fall back to all notes. To fix this, give the Daily Note rule a fixed target folder under your creation rules. See #wikilink("3 - Setting Up Your Notebox"). ]

== Pairing with daily notes

Journal Scroll has no hard requirement for daily notes; it reads any notes. But the two complement each other. Set *Sort by* to *Note's date property* (or *File creation date*) and *Anchor scope* to *Daily Notes folder*, and the feed becomes a clean, chronological journal you can scroll through day-by-day.

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

When Journal Scroll is on, the right panel sets aside its usual single-note tabs and shows *Scroll Context* instead (a live summary of just the entries currently in view). It includes the date-direction and return-to-anchor controls (and, in Neighbourhood, the *Compose* button described below), plus four collapsible sections:

+ *Outline* lists the headings across all the visible notes; click one to scroll straight to it.
+ *Connections* are notes _outside_ the feed that link to or from what you are currently reading; click to open them in a new tab.
+ *Tags* shows which tags are concentrated in the notes on screen.
+ *Citations* are the references cited across the visible notes; click one to highlight where it appears.

Before you have scrolled any note into view, this panel invites you to "Scroll into the view to populate context." For more on the panels and overall layout, see #wikilink("1 - Views and Navigation").

== Composing a new note from the neighbourhood

The notes around an idea are often the raw material for something new: everything you have written about it, gathered in one place. *Compose* turns them into a writing session.

In Neighbourhood, click the *Compose* button in the right panel, just after *Return to the anchor note*. InkyCap creates a new note exactly as *Ctrl+N* would, with your usual naming, folder, template, and ZID settings, and opens it in the editor. The right panel switches to the *Compose* tab, which lists as cards passages from the notes linked with the anchor, oldest note first (by ZID, then by creation date):

- For a note that links to the anchor, there is a card for each passage holding such a link.
- For a note the anchor links to (that doesn't link back in its text), there is one card holding the note's opening passage, marked *Opening*.

Each card offers:

- *Copy the whole note into the draft* inserts the card's entire note at your cursor, without its properties. Use this when the whole note, not just one passage, belongs in the new piece.
- *Copy into the draft* inserts the passage at your cursor as it is, ready to rework. Use this for your own writing that you want to carry forward in a new form.
- *Copy into the draft as a quote* inserts it as a block quote, credited with a link to its note.
- *Insert a link to this note* inserts just the link, for when you would rather write the idea afresh.
- *Dismiss* hides the card for this session.

The same four insert buttons sit at the top of the panel beside *All passages*; they insert every card still showing, in the order shown. Copying whole notes copies each note once, even when it has several cards. Inserting links for several cards makes a bulleted list with one link per note.

Drag a card by its handle to reorder the list; arranging the cards is a quick way to outline the new piece. Once your draft links to a card's note, the card fades so you can see what you haven't used yet. Click a card's note name to open that note in a new tab.

Copied text is a copy: editing the original later doesn't change your draft, and editing the draft doesn't touch the original. Images and other files the copied text uses keep working, wherever the draft is saved. A copied whole note leaves out any `#bibliography(...)` call, since a document can hold only one. To keep track of where text came from, each note you copy from (whole, as it is, or as a quote) is added to the draft's *derived-from* property (see #wikilink("6 - Note Properties")). Those entries are real links, so the sources show up in the draft's Outbound Links and the draft shows up in each source's Inbound Links. If you rename a source note, its entry is updated along with every other link to it.

The Compose tab belongs to the draft and lasts until you close the draft's tab. A notice under the draft's toolbar reminds you of this, and its *Show cards* button brings the Compose tab back if you have switched to another tab in the right panel. To keep a gathering of linked notes that you can return to and export, use a collection with a *Links to* filter instead (see #wikilink("2 - Collections")).

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
- #wikilink("4 - Links and Backlinks") (the links that make up a Neighbourhood).
