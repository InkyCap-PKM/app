#import "/.inkycap/notebox.typ": *

#note(
  title: "The InkyCap Interface",
  description: "A guided tour of the InkyCap window: toolbar, left and right sidebars, tabs and split panes, status bar, Command Palette, Quick Open, and focus modes.",
  tags: ("documentation",),
  aliases: ("InkyCap Interface",),
)

= The InkyCap Interface

InkyCap's window is laid out in vertical bands, left to right:

+ A narrow *vertical toolbar* of icons at the far left, always visible.
+ The *left sidebar*, which holds application tools (your files, collections, properties, agenda, and so on).
+ The *editor area* in the middle, where your notes open as tabs that you can split into additional panes.
+ The *right panel*, which shows information about whatever you are currently working on.

Running along the bottom is the *status bar*, with your notebox name, word count, and other at-a-glance details.

You can hide either sidebar to make more room. Press `Ctrl+/` to toggle the left sidebar and `Ctrl+\\` to toggle the right panel. 

== The vertical toolbar

This is the slim strip of icons at the very far left. It remains even when you collapse the left sidebar. From top to bottom you will find:

- A *sidebar show/hide toggle* (the panel icon at the top). When the left sidebar is collapsed, this is how you bring it back.
- *Search* opens a full-notebox search in the sidebar. You can also press *Ctrl+Shift+F*.
- *Creation-rule buttons*. If you have set up note-creation shortcuts that opt into the toolbar, each appears here with its own icon, ready to make a new note in one click. See #wikilink("3 - Scaffolds, Templates, and Packages") for how to set these up.
- A *theme toggle* (a sun or moon) to switch between light and dark mode. Shortcut: *Ctrl+Shift+L*.
- *Templates* opens the Scaffolds, Templates, & Packages panel.
- *Help* opens the in-app help panel. You can also press *F1*.
- *Settings* opens the Settings window. Shortcut: *Ctrl+,*. See #wikilink("2 - Settings").
\

== The left sidebar: your tools

Across the top of the left sidebar is a row of icon buttons, the *mode bar*. Each one switches the pane below to a different tool. There are six built-in modes:

+ *File Tree* is every file in your notebox, shown as a folder tree.
+ *Collections* are your gathered groups of notes for publishing. See #wikilink("2 - Collections").
+ *Agenda* gathers tasks and dated items pulled from across your notebox. See #wikilink("3 - Agenda, Tasks, and Dates").
+ *Properties* are the typed fields you have used across notes, like _tags_ or _due dates_. See #wikilink("6 - Note Properties").
+ *Tags* is a flat list of every tag, with how often each is used. See #wikilink("5 - Tags").
+ *Bookmarks* are notes you have flagged to find quickly.

A couple of other panes (Search, Templates, Help, and Collaboration) live here too but are opened from the toolbar or a shortcut rather than the mode bar.

=== The file tree

Use the file tree to browse your folders and open notes. It will display folders and files sequenced according to your preference in the settings.

- Notes (`.typ` files) and collection files open right inside InkyCap. Other files (images, PDFs, bibliography files, data) are shown but dimmed, and open in your computer's default application when clicked.
- The header has a *sort menu* (Name A→Z or Z→A, Modified, or Created), an *expand-all / collapse-all* toggle, and a *"New"* button for making a new note, a new folder, or uploading a file into your notebox.
- Right-clicking a file or folder gives you New File, New Folder, Bookmark (on notes), Rename, Move, and Delete.
- To open a note in a *new tab* instead of the current one, hold *Ctrl* (or *Cmd*) while you click it.

You can also *drag a file onto a folder* to move it. The destination highlights, the file you are dragging dims, and a small chip follows your cursor so you can see exactly where it will land.

#callout("important")[ If your active tab is a #wikilink("4 - Journal Scroll"), clicking a note in the file tree _re-anchors_ the scroll on that note rather than opening it in a new tab. Hold *Ctrl* (or *Cmd*) and click if you want a normal tab instead. ]

=== Agenda
The Agenda pane lets you filter by task state and tags, and sort by due date, creation, or name.


=== Properties and Tags panes
The Properties and Tags panes each show a list of all property names or tags used within the notebox, including a count. Clicking on any of these will start a search for files that include them.

=== Bookmarks

Bookmarks are notes, collections, and saved searches you have flagged to reach in one click. They live in the *Bookmarks* pane and persist between sessions. There are several ways to add one:

- *A note from the file tree.* Right-click a note in the file tree and choose *Bookmark*.
- *A note from the File actions menu.* In the right panel's *File actions* menu (described below), choose *Bookmark…*.
- *A collection.* Right-click a collection in the Collections list and choose *Bookmark*.
- *A search.* In the #wikilink("2 - Search and Retrieval", display: "Search panel"), open the *More actions* menu and choose *Bookmark search expression…*.

In the Bookmarks pane, click any bookmark to open it: a note opens in a tab, a collection in its collection view, and a saved search reopens the Search panel and runs. Drag the grip handle to reorder them, and use the `×` button to remove one. When you have none, the pane reminds you: "No bookmarks yet. Right-click a file or collection to bookmark it."


== The right panel: context that follows you

The right panel's tabs change depending on what you have open. It shows what is relevant in the editor.

When a *note* is active, the right panel offers:

- *File actions* is a menu with Rename, Move, Bookmark, Export, Find, Replace, Show in explorer, Show in File Tree (highlights the file), and Delete.
- *Outline* is the heading tree of your document. It is like a table of contents that you can click to jump to sections in long notes.
- *Properties* is an editor for the note's own metadata like title, tags, date, and due. See #wikilink("6 - Note Properties").
- *Links* shows your note's connections, grouped into Inbound (backlinks), Outbound, and Potential Links. See #wikilink("4 - Links and Backlinks").
- *References* is the bibliography pane. See #wikilink("7 - Citations and Bibliography").
- *Changes & History* lets you review suggestions, tracked changes, and annotations. A small dot appears on this tab when suggested changes are waiting for you to accept or reject them.

When you open a *collection*, the right panel switches to Characteristics, Style Overrides, and Book Metadata and Structure. When you open a #wikilink("5 - Mycelial View"), it shows Linked Context and Concept Filtering instead.

== Tabs and split panes

Notes open as *tabs* across the top of the editor area. A tab shows a type icon for special views (a scroll for a #wikilink("4 - Journal Scroll"), a brain for a #wikilink("5 - Mycelial View"), and so on), and a *dot* (●) when it has unsaved changes.

- *Reorder* tabs by dragging them within a pane.
- *Move* a tab to another pane by dragging it across.
- Common tab shortcuts: New empty tab *Ctrl+T*, close tab *Ctrl+W*, reopen the last closed tab *Ctrl+Shift+T*, and next / previous tab with *Ctrl+Tab* / *Ctrl+Shift+Tab*.

To work on two things at once, *split the editor*. At the right edge of the tab strip is a *Tab options* menu with "Split right", "Split down", and "Close this pane", plus a quick list of that pane's tabs.

- Split right: `Ctrl+Shift+]`
- Split down: `Ctrl+Shift+[`
- Close the pane: *Ctrl+Shift+W*

Each pane keeps its own reading format and its own right-panel context, so you can, for example, draft in one pane while reading a reference in another.

#callout("tip")[ Each note can be viewed in three modes: *Source edit*, *Visual edit*, and *Reading view*. Switch between source and visual with *Ctrl+Shift+M*, and toggle reading view with *Ctrl+Shift+R*. See #wikilink("2 - Editing Notes") for what each mode is best for. ]

== The status bar

The bar along the bottom gives you quick status and quick actions. From left to right:

- *Notebox name*. Click it to switch noteboxes, open one in a new window, start a new window, or manage your noteboxes.
- *File count* shows how many files are in the notebox.
- *Collaboration chip* appears only in a shared notebox, showing sync status at a glance. See #wikilink("1 - Collaboration").
- *File path* is the location of the active note, with an inline *rename* button (you can also rename with *F2*).
- *Cursor position* (line and column) is shown only in Source edit mode, where the positions line up.
- *Spellcheck chip* shows the current dictionary and lets you change it.
- *Word / character count* shows your word count; *click it* to switch to a character count, and click again to switch back.
- *Distraction-free toggle* sits at the far right side, always available.

== Command Palette and Quick Open

Two overlays let you do almost anything without hunting through menus.

The *Command Palette* (*Ctrl+P*) lists every command in InkyCap. Start typing to fuzzy-search; the matching letters are highlighted, and each result shows its keyboard shortcut. With the box empty, commands are grouped into collapsible categories (File, Edit, View, Navigate, and more) that you can browse with the arrow keys.

*Quick Open* (*Ctrl+O*) is for jumping to a note by name. With the box empty it _lists your notes with the most recently edited first_; start typing to fuzzy-match on the file name. Press Enter to open the highlighted note. It stays fast even in a notebox of thousands of notes.

#callout("tip", title: "Command palette tips")[ Command Palette rows also show a markup hint next to formatting commands (for example `*…*` for bold), so you can learn the underlying Typst syntax as you go. The palette is the only place to launch a notebox-wide search-and-replace; it has no dedicated key by design. ]

== Distraction-free, focus, and typewriter modes

These are three separate ways to calm the screen, and you can mix them:

- *Distraction-free mode* hides the sidebars and chrome and shrinks the status bar into the corner. Toggle it with the status-bar button or *Ctrl+Shift+1*, and leave it with *Esc*.
- *Focus mode* gently highlights just the line or paragraph you are working on (and can dim the rest). You turn it on in #wikilink("2 - Settings").
- *Typewriter mode* keeps the line you are typing pinned to the vertical centre of the screen, so your eyes stay in one place. It is also a setting, and is active in Visual edit mode.

== Moving around with the keyboard

InkyCap divides the window into *regions* (the sidebar, each editor pane, the right panel, and the status bar) that you can move between without the mouse:

- *F6* / *Shift+F6* cycle forward and back through the visible regions.
- *Ctrl+Shift+0* jumps straight to the editor.
- *Esc* from any non-editor region returns you to the editor.
- *Ctrl+PageDown* / *Ctrl+PageUp* cycle the focused panel's own tabs.

For the full list of shortcuts, see #wikilink("3 - Keyboard Shortcuts").

== Drag-and-drop from outside InkyCap

You can drag files straight from your desktop into the editor. InkyCap copies them into your attachment folder and inserts the right kind of reference at the drop point. An image becomes an inline image, a video or audio file becomes a player, another note becomes a link to that note, and anything else becomes a clickable file link. Pasted web addresses are turned into links automatically.

== Related pages

- #wikilink("1 - Getting Started")
- #wikilink("2 - Editing Notes")
- #wikilink("2 - Settings")
- #wikilink("3 - Keyboard Shortcuts")
- #wikilink("4 - Journal Scroll")
- #wikilink("5 - Mycelial View")
- #wikilink("3 - Agenda, Tasks, and Dates")
- #wikilink("2 - Collections")
