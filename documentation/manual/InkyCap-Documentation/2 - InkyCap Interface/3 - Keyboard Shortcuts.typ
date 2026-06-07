#import "/.inkycap/notebox.typ": *

#note(
  title: "Keyboard Shortcuts",
  description: "A grouped reference of InkyCap's most useful keyboard shortcuts, with notes on macOS keys and the live in-app Help panel.",
  tags: ("documentation",),
)

= Keyboard Shortcuts

This page is a quick reference to the keyboard shortcuts that help you move around InkyCap, write faster, and show or hide panels (without reaching for the mouse). You do not need to memorize any of it. InkyCap keeps an up-to-date list of shortcuts built into the app.

The handful of shortcuts in the #wikilink("2 - Editing Notes") and #wikilink("3 - Formatting Your Writing") sections are the ones most writers reach for first.

== A note for Mac users

The shortcuts below are written with *Ctrl* (the key Linux and Windows users press). On macOS, press *⌘ (Command)* instead wherever you see _Ctrl_. InkyCap treats them as the same key. The in-app Help panel displays the Mac glyphs for you (`⌘` for Ctrl, `⇧` for Shift, `⌥` for Alt).

#callout("tip")[
The fastest way to find any shortcut is to press *F1* to open the Help panel, then type a word into its filter box. More on that below.
]

== Getting help within InkyCap

Press *`F1`* (or click the *Info* button in the editor toolbar) to open the Help panel. It offers three views you can switch between:

- *UI shortcuts*. Every global shortcut grouped by category.
- *Visual editor*. The formatting keys and typing shortcuts you use while writing.
- *Typst markup*. A cheat-sheet of Typst markup, useful alongside #wikilink("3 - Formatting Your Writing").
\

== Navigation

Use these to jump between notes, tabs, and the different parts of the window. The window regions referred to here (the sidebars, editor, and status bar) are explained in #wikilink("1 - The InkyCap Interface"). 
#table(
  columns: (auto, auto),
  table.header([Shortcut], [Action]),
  [`Ctrl+O`], [Quick Open file finder],
  [`Ctrl+P`], [Command Palette],
  [`Ctrl+Tab`], [Next tab],
  [`Ctrl+Shift+Tab`], [Previous tab],
  [`Ctrl+1` … `Ctrl+9`], [Switch directly to tab 1–9],
  [`Ctrl+Shift+F`], [Search in notebox],
  [`F6`], [Focus the next region (sidebar, editor, panel…)],
  [`Shift+F6`], [Focus the previous region],
  [`Ctrl+Shift+0`], [Jump straight to the active editor],
  [`Esc`], [From a panel, return focus to the editor],
)

#callout("tip")[
*F6* steps through the visible regions of the window in order, skipping any panel you have collapsed. It is the keyboard-only way to reach the sidebar or a side panel and operate it entirely from the keyboard.
]

When a panel is focused, you can flip through its own internal tabs with *Ctrl+PageDown* and *Ctrl+PageUp*. (These only act once you have focused the panel with *F6* first.)

Inside the file tree and other lists, the arrow keys move the selection, *Enter* or *Space* opens or activates the highlighted item, and *Home* / *End* jump to the ends. In the file tree specifically, *→* expands a folder (or steps into it) and *←* collapses it (or steps out to the parent).

== Editing

These act on the note you are writing. See #wikilink("2 - Editing Notes") for the bigger picture of how editing works.
#table(
  columns: (auto, auto),
  table.header([Shortcut], [Action]),
  [`Ctrl+N`], [New note],
  [`Ctrl+D`], [Daily note (today's note)],
  [`Ctrl+T`], [New empty tab],
  [`Ctrl+W`], [Close tab],
  [`Ctrl+Shift+T`], [Reopen the last closed tab],
  [`Ctrl+M`], [Move file to…],
  [`Ctrl+Shift+D`], [Delete file],
  [`F2`], [Rename the current file],
  [`Ctrl+H`], [Find and replace (within the current note)],
  [`Ctrl+=` / `Ctrl++`], [Zoom in],
  [`Ctrl+-`], [Zoom out],
  [`Ctrl+0`], [Reset zoom],
)

#callout("note")[
*Ctrl+N* and *Ctrl+D* come from InkyCap's built-in note-creation rules, and unlike most shortcuts, _these two you can change yourself_. Each creation rule has an editable hotkey. See #wikilink("3 - Scaffolds, Templates, and Packages") for how creation rules work.
]

=== Formatting keys (while writing)

These act inside note content. They are toggles; press the same combo again to remove the formatting. There is much more on this in #wikilink("3 - Formatting Your Writing").

#table(
  columns: (auto, auto, auto),
  table.header([Shortcut], [Action], [Produces]),
  [`Ctrl+B`], [Bold], [`*…*`],
  [`Ctrl+I`], [Italic], [`_…_`],
  [`Ctrl+E`], [Inline code], [`` `…` ``],
  [`Ctrl+Shift+X`], [Strikethrough], [`#strike[…]`],
  [`Ctrl+Shift+H`], [Highlight], [`#highlight[…]`],
  [`Ctrl+Shift+M`], [Inline math], [`$…$`],
  [`Tab`], [Indent list item], [],
  [`Shift+Tab`], [Outdent list item], [],
  [`Shift+Alt+Up`], [Move line / item up], [],
  [`Shift+Alt+Down`], [Move line / item down], [],
  [`Ctrl+Shift+Up`], [Decrease heading level], [],
  [`Ctrl+Shift+Down`], [Increase heading level], [],
)

#callout("tip")[
You can also format by simply *typing* the markup as you go: `*bold*`, `_italic_`, `= ` for a heading, `- ` for a bullet, and so on. Start a line with `/` to open the editor's command menu. These typed shortcuts are listed in the Help panel's *Visual editor* view, and explained in #wikilink("3 - Formatting Your Writing").
]

== Panels and views

Show, hide, and switch between InkyCap's panels and editing modes.

#table(
  columns: (auto, auto),
  table.header([Shortcut], [Action]),
  [`Ctrl+/`], [Toggle the left sidebar],
  [`Ctrl+\`], [Toggle the right panel],
  [`Ctrl+,`], [Open Settings],
  [`Ctrl+Shift+N`], [New window],
  [`Ctrl+Shift+L`], [Toggle dark / light theme],
  [`Ctrl+Shift+M`], [Toggle Source / Live Preview mode],
  [`Ctrl+Shift+R`], [Toggle Reading mode],
  [`Ctrl+Shift+1`], [Toggle Distraction-Free mode],
  [`Ctrl+Shift+]`], [Split the editor to the right],
  [`Ctrl+Shift+[`], [Split the editor downward],
  [`Ctrl+Shift+W`], [Close the current editor pane],
  [`Ctrl+Shift+Y`], [Open the Mycelial View],
  [`Ctrl+Shift+J`], [Toggle the Journal Scroll],
)

The editing modes and views above have their own pages: #wikilink("1 - Views and Navigation"), #wikilink("5 - Mycelial View"), and #wikilink("4 - Journal Scroll").

#callout("important")[
In Distraction-Free mode, press *Esc* to return to the normal layout.
]

=== References and collaboration

#table(
  columns: (auto, auto),
  table.header([Shortcut], [Action]),
  [`Ctrl+Shift+C`], [Search references and cite],
  [`Ctrl+Shift+\`], [Insert a scaffold],
  [`Ctrl+Shift+S`], [Sync (git)],
  [`Ctrl+Shift+U`], [Check for updates (git)],
  [`Ctrl+Shift+E`], [Export package (offline handoff)],
  [`Ctrl+Shift+G`], [Import package (offline handoff)],
)

For what these do, see #wikilink("1 - Collaboration",
) and #wikilink("7 - Citations and Bibliography")

#callout("tip")[
Not every command has a shortcut. Anything without one easily accessed in the Command Palette (*Ctrl+P*). Start typing the name to see a list of possibilities.
]

== Can I change the shortcuts?

You can customize the hotkeys for *note-creation rules* (such as New Note, Daily Note, or other rules you make) from the Creation Rules editor (see #wikilink("2 - Settings")). Reassigning the other built-in shortcuts (for example, remapping *Ctrl+P*) is not currently possible.


== Related pages

- #wikilink("1 - The InkyCap Interface")
- #wikilink("2 - Editing Notes")
- #wikilink("3 - Formatting Your Writing")
- #wikilink("1 - Views and Navigation")
- #wikilink("2 - Settings")
\
