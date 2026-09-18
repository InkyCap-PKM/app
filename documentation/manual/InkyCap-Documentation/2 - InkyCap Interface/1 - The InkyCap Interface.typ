#import "/.inkycap/notebox.typ": *

#note(
  title: "The InkyCap Interface",
  description: "A guided tour of the InkyCap window: toolbar, left and right sidebars, tabs and split panes, status bar, Command Palette, Quick Open, the Help panel, and focus modes.",
  tags: ("documentation",),
  aliases: ("InkyCap Interface",),
)

= The InkyCap Interface

InkyCap's window is laid out in vertical bands, left to right:

+ A narrow *vertical toolbar* of icons at the far left, always visible.
+ The *left sidebar*, which holds application tools (your files, collections, properties, agenda, search, and so on).
+ The *editor area* in the middle, where your notes open as tabs that you can split into additional panes.
+ The *right panel*, which shows information about whatever you are currently working on.

Running along the bottom is the *status bar*, with your notebox name, word count, and other at-a-glance details.

You can hide either sidebar to make more room. Press `Ctrl+/` to toggle the left sidebar and `Ctrl+\` to toggle the right panel. 

== The vertical toolbar

This is the slim strip of icons at the very far left. It remains even when you collapse the left sidebar. From top to bottom you will find:

- A *sidebar show/hide toggle* (the panel icon at the top). When the left sidebar is collapsed, this is how you bring it back.
- *Search* opens a full-notebox search in the sidebar. You can also press *Ctrl+Shift+F*.
- *Creation-rule buttons*. If you have set up note-creation shortcuts that opt into the toolbar, each appears here with its own icon, ready to make a new note in one click. See #wikilink("3 - Scaffolds, Templates, and Packages") for how to set these up.
- A *theme toggle* (a sun or moon) to switch between light and dark mode. Shortcut: *Ctrl+Shift+L*.
- *Templates* opens the Scaffolds, Templates, & Packages panel.
- *Help* opens the in-app Help panel (described in its own section below). You can also press *F1*.
- *Settings* opens the Settings window. Shortcut: *Ctrl+,*. See #wikilink("2 - Settings").
\

== The left sidebar: your tools

Across the top of the left sidebar is a row of icon buttons, the *mode bar*. Each one switches the pane below to a different tool. The built-in modes include:

+ *File Tree* is every file in your notebox, shown as a folder tree.
+ *Collections* are your gathered groups of notes for projects, publishing into a paper, a book, or querying information like a database within InkyCap. See #wikilink("2 - Collections").
+ *Agenda* gathers tasks and dated items pulled from across your notebox. See #wikilink("3 - Agenda, Tasks, and Dates").
+ *Properties* are the typed fields you have used across notes, like _tags_ or _due dates_. See #wikilink("6 - Note Properties").
+ *Tags* is a flat list of every tag, with how often each is used. See #wikilink("5 - Tags").
+ *Bookmarks* are notes or search expressions you have flagged to find quickly.

A couple of other panes (Search, Templates, Help, and Collaboration) live in this sidebar too but are opened from the toolbar or a shortcut rather than the mode bar.

=== The file tree

Use the file tree to browse your folders and open notes. It will display folders and files sequenced according to your preference in the settings.

- Notes (`.typ` files) and collection files open right inside InkyCap. Other files (images, PDFs, bibliography files, data) are shown but dimmed, and open in your computer's default application when clicked.
- The header has a *sort menu* (Name A→Z or Z→A, Modified, Created, or ZID ascending or descending), an *expand-all / collapse-all* toggle, and a *"New"* button for making a new note, a new folder, or uploading a file into your notebox. Names are sorted the way a person would sort them, so "Chapter 2" comes before "Chapter 10".
- Right-clicking a file or folder gives you *Open in new tab*, *New Note*, *New Folder*, *Bookmark* (on notes), *Rename*, *Move file to…* (or *Move folder to…*), and *Delete*. Right-clicking a folder also offers *Search in folder*, which opens the Search panel limited to that folder.
- To open a note in a *new tab* instead of the current one, hold *Ctrl* (or *Cmd*) while you click it, or click it with the middle mouse button. Whether that new tab comes to the front or stays in the background follows the *Switch to new tabs immediately* setting under *Behaviour* in #wikilink("2 - Settings").

You can also *drag a file onto a folder* to move it.

#callout("important")[ If your active tab is a #wikilink("4 - Journal Scroll"), clicking a note in the file tree _re-anchors_ the scroll on that note rather than opening it in a new tab. Hold *Ctrl* (or *Cmd*) and click if you want a normal tab instead. ]

=== Agenda
The Agenda pane lets you filter by task state and tags, and sort by due date, creation, or name.


=== Properties and Tags panes
The Properties and Tags panes each show a list of all property names or tags used within the notebox, including a count. Clicking on any of these will start a search for files that include them.

=== Bookmarks

Bookmarks come in four kinds: notes, collections, saved searches, and saved Agenda views. They are things you have flagged to reach in one click. They live in the *Bookmarks* pane and persist between sessions. There are several ways to add one:

- *A note from the file tree.* Right-click a note in the file tree and choose *Bookmark*.
- *A note from the File actions menu.* In the right panel's *File actions* menu (described below), choose *Bookmark…*.
- *A collection.* Right-click a collection in the Collections list and choose *Bookmark*.
- *A search.* In the #wikilink("2 - Search and Retrieval", display: "Search panel"), open the *More actions* menu and choose *Bookmark search expression…*.
- *An Agenda view.* In the #wikilink("3 - Agenda, Tasks, and Dates", display: "Agenda pane"), set up the filters you want, then choose *Bookmark current view* and give it a name.

In the Bookmarks pane, click any bookmark to open it: a note opens in a tab, a collection in its collection view, a saved search reopens the Search panel and runs, and a saved Agenda view reopens the Agenda with those filters applied. Drag the grip handle to reorder them, and use the `×` button to remove one. 


== The right panel: context

The right panel's tabs change depending on what you have open. It shows what is relevant in the editor.

When a *note* is active, the right panel offers:

- *File actions* is a menu with *Rename…*, *Move file to…*, *Bookmark…*, *Export…*, *Find…*, *Replace…*, *Show in file tree* (highlights the file), *Show in system file manager*, and *Delete file*.
- *Outline* is the heading tree of your document. It is like a table of contents that you can click to jump to sections in long notes.
- *Properties* is an editor for the note's own metadata like title, tags, date, and due. See #wikilink("6 - Note Properties").
- *Links* shows your note's connections, grouped into Inbound (backlinks), Outbound, and Potential Links. See #wikilink("4 - Links and Backlinks").
- *References* is the bibliography pane. See #wikilink("7 - Citations and Bibliography").
- *Changes & History* lets you review suggestions, tracked changes, and annotations. A small dot appears on this tab when suggested changes are waiting for you to accept or reject them.

When you open a *collection*, the right panel switches to Characteristics, Style Overrides, and Book Metadata and Structure. When you open a #wikilink("5 - Mycelial View"), it shows three tabs instead: *Linked Context*, *Growth*, and *Filtering*.

== Tabs and split panes

Notes open as *tabs* across the top of the editor area. A tab shows a type icon for special views (a scroll for a #wikilink("4 - Journal Scroll"), a brain for a #wikilink("5 - Mycelial View"), and so on), and a *dot* (●) when it has unsaved changes.

- *Reorder* tabs by dragging them within a pane.
- *Move* a tab to another pane by dragging it across.
- Open a new empty tab with the *+* button at the end of the tab strip. When there are more tabs than fit, small arrows appear at either end to scroll through them.
- Common tab shortcuts: New empty tab *Ctrl+T*, close tab *Ctrl+W*, reopen the last closed tab *Ctrl+Shift+T*, and next / previous tab with *Ctrl+Tab* / *Ctrl+Shift+Tab*.

Every pane, whether it shows a note or a collection, has a small *navigation bar* at its top with *Go back* and *Go forward* arrows. They walk through the history of what that tab has shown, so after following a few wikilinks you can step back the way you came.

If you would like InkyCap to bring back your tabs the next time you open a notebox, choose *Previously open tabs* under *Startup behaviour* in #wikilink("2 - Settings").

To work on two things at once, *split the editor*. At the right edge of the tab strip is a *Tab options* menu with *Split right*, *Split down*, *Split with preview*, and *Close this pane*, plus a quick list of that pane's tabs.

- Split right: `Ctrl+Shift+]`
- Split down: `Ctrl+Shift+[`
- Close the pane: *Ctrl+Shift+W*

Each pane keeps its own reading format and its own right-panel context, so you can, for example, draft in one pane while reading a reference in another.

*Split with preview* opens a live reading view of the _same_ note beside the editor, and that preview updates as you type. The editing tab is marked as a *Synced preview* so you can tell the pair apart, and each note can have one such pair at a time. The preview uses your *Reading view format preference* from #wikilink("2 - Settings"). You can also start one from the command palette with *Split with synced preview*; it has no keyboard shortcut of its own.

#callout("tip")[ Each note can be viewed in three modes: *Source edit*, *Visual edit*, and *Reading view*. Switch between source and visual with *Ctrl+Shift+M*, and toggle reading view with *Ctrl+Shift+R*. See #wikilink("2 - Editing Notes") for what each mode is best for. ]

In reading view, zooming works in both the SVG and HTML formats, and wikilinks behave as they do in the editor: click one to follow it in the same tab, hold *Ctrl* (or use the middle mouse button) to open it in a new tab, or right-click it for a menu. Links to web pages open in your usual browser or the appropriate system application.

== The status bar

The bar along the bottom gives you quick status and quick actions. From left to right:

- *Notebox name*. Click it to switch noteboxes, open one in a new window, start a new window, or manage your noteboxes.
- *File count* shows how many files are in the notebox.
- *Collaboration pill* appears only in a shared notebox, showing sync status at a glance. See #wikilink("1 - Collaboration").
- *File path* is the location of the active note, with an inline *rename* button (you can also rename with *F2*).
- *Cursor position* (line and column) is shown only in Source edit mode, where the positions line up.
- *Spellcheck pill* shows the current dictionary and lets you change it.
- *Word / character count* shows your word count; *click it* to switch to a character count, and click again to switch back.
- *Distraction-free toggle* sits at the far right side, always available.

== Command Palette and Quick Open

The *Command Palette* (*Ctrl+P*) lists every command in InkyCap. Start typing to fuzzy-search; the matching letters are highlighted, and each result shows its keyboard shortcut. With the box empty, commands are grouped into collapsible categories (File, Edit, View, Navigate, and more) that you can browse with the arrow keys.

*Quick Open* (*Ctrl+O*) is for jumping to a note by name. With the box empty it _lists your notes with the most recently edited first_; start typing to fuzzy-match on the file name. Press Enter to open the highlighted note.

#callout("tip", title: "Command palette tips")[Command Palette rows also show a markup hint next to formatting commands (for example `*…*` for bold), so you can learn the underlying Typst syntax as you go. The palette is the only place to launch a notebox-wide search-and-replace. ]

== The Help panel

Press *F1*, or click the *Help* button on the vertical toolbar, to open the Help panel in the left sidebar. It has a filter box at the top (type a word to narrow every list below it) and two buttons that open the full manuals: *InkyCap Documentation*, which opens this manual in its own window, and *Typst Documentation*, which opens the official Typst reference in your browser. Beneath those, a selector switches between three views:

- *UI shortcuts* lists every keyboard shortcut in the app, grouped by category.
- *Visual editor* lists the formatting keys and the typing shortcuts that work while you write.
- *Typst markup* is a cheat-sheet of standard Typst markup, with a few additional InkyCap simplifications.

=== Set custom shortcuts (hotkeys)

The *UI shortcuts* view is where you change shortcuts. Click the key combination shown beside any command, then press the new keys you want. Press *Backspace* instead to remove the shortcut (it then reads *Unassigned*), or *Esc* to leave it as it was. If the combination you press already belongs to another command, or is reserved by the editor (such as *Ctrl+B* for bold) or by the system, InkyCap refuses it and tells you what it is used for. A changed shortcut shows a small reset arrow beside it that restores the default, and a *Reset all shortcuts* button appears at the top of the view once anything has been customized. Shortcuts for note-creation rules (such as *Ctrl+N*) are listed here for reference but are changed in *Creation Rules* in #wikilink("2 - Settings"). See #wikilink("3 - Keyboard Shortcuts") for the full reference.

== Distraction-free, focus, and typewriter modes

These are three separate ways to calm the screen, and you can mix them:

- *Distraction-free mode* hides some user interface elements (sidebars) and shrinks the status bar into the corner. Toggle it with the status-bar button or *Ctrl+Shift+1*, and leave it with *Esc*.
- *Focus mode* gently highlights just the line or section you are working on. In #wikilink("2 - Settings") you choose between *Off*, *Line*, and *Section*. A separate setting, *Dim unfocused text*, fades everything outside the focused area; it also works on its own, with Focus mode off, in which case it keeps the paragraph you are writing in clear.
- *Typewriter mode* keeps the line you are typing pinned to the vertical centre of the screen, so your eyes stay in one place. It is also a setting, and is active in Visual edit mode.

== Moving around with the keyboard

InkyCap divides the window into *regions* (the sidebar, each editor pane, the right panel, and the status bar) that you can move between without the mouse:

- *F6* / *Shift+F6* cycle forward and back through the visible regions.
- *Ctrl+Shift+0* jumps straight to the editor.
- *Esc* from any non-editor region returns you to the editor.
- *Ctrl+PageDown* / *Ctrl+PageUp* cycle the focused panel's own tabs.

Menus in InkyCap, including right-click menus and their submenus, can be controlled via the keyboard: the arrow keys move through the items, *Home* and *End* jump to the first and last, *Enter* or *Space* chooses the highlighted item, and *Esc* closes the menu. *Right* or *Enter* steps into a submenu and *Left* steps back out.

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
