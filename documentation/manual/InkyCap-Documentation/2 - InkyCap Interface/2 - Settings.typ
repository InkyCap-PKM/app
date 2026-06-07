#import "/.inkycap/notebox.typ": *

#note(
  title: "Settings",
  description: "A guided tour of every InkyCap Settings tab — Overview, Editor, Language, Appearance, Files, Citations, Export, Creation Rules, Behaviour, Extensions, About.",
  tags: ("documentation",),
)

= Settings

Use InkyCap's Settings to tailor the app to the way you like to write. You can change how notes open, pick a citation style, set up automatic backups, adjust colours and fonts, and more.

== Opening Settings

+ Open the command palette (`Ctrl+P`) and choose the *Settings* command (it lives under the View category), or go direct by pressing the shortcut combination: `Ctrl+,`.
+ The panel opens with a list of tabs down the left side and the chosen tab's controls on the right.
+ Close it with the *×* button, the *Escape* key, or by clicking the dimmed area outside the panel.

#callout("info")[ Some settings apply to InkyCap everywhere (these are _user-global_); others apply only to the notebox you have open. Anything scoped to the current notebox is marked with a small *"this notebox"* badge beside its label. If there's no badge, the setting is global (for all your noteboxes). ]

== A note about "Reset to Defaults"

Many tabs have a red *"Reset to Defaults"* button in the footer. It resets _every_ group of settings that tab owns (it can include both global and notebox-specific settings at once).

#callout("warning")[ Resetting *Files & Links* also clears that notebox's folder paths, and resetting *Editor* wipes your spellcheck preferences (they're stored alongside the editor settings). Use these buttons deliberately. ]

== Overview

- *Version* shows which build you're running. A *"Development build"* badge appears on beta channels, and *inkycap.org* links to the project site.
- *Check for updates* lets you look for a newer release on demand. InkyCap is local-first, so it makes no network connection unless you ask it to (see the Behaviour tab below).
- The *Help* section links to *InkyCap Documentation*, opening this manual in a new window.

=== Notebox Management

This section lists every notebox InkyCap knows about on your computer and lets you add more. Each row shows the notebox's name (rename it with the pencil), its location, and buttons to *Open*, *Show* (reveal in your file manager), *Move*, or *Remove* it.

#callout("important")[ Creating or adding a notebox does *not* automatically open it. Use the row's *Open* button. ]

You can also:

- *New notebox*. Pick a location and an optional display name, then *Add*.
- *Clone from remote*. Join a shared, collaborative notebox by cloning its git repository (address, branch, and optional username/password). See #wikilink("1 - Collaboration").
- *Import package*. Join a notebox that was shared offline as a package file.

Each row also has a *Collaboration* toggle. Turning it on reveals a *Configure* button and an experimental-feature notice.

== Editor

These global settings shape how the writing surface feels.

- *Comfortable line length* caps how wide lines grow for easier reading; turning it on lets you set a *Max line length*.
- *Auto-pair brackets* and *Auto-pair Typst markup* automatically close brackets, quotes, and markup delimiters as you type.
- *Auto-expand markup* reveals the underlying Typst, in the visual editor, when your cursor enters a pill.
- *Intuitive list indentation* means Tab and Shift-Tab also move a list item's nested children.
- *Enter key inserts a line break*. In the visual editor, one Enter is a soft line break and two Enters start a new paragraph.
- *Editing mode preference* sets whether notes open in *Visual Edit* or *Source Mode* by default (see #wikilink("2 - Editing Notes")).
- *Typewriter mode* (keeps the cursor at the middle of the page), *Focus mode* (Off / Line / Section), and *Dim unfocused text* help you concentrate on the current line or section. 

Under *Visual editor convenience* you'll find the *Popup toolbar on selected text* and the *Slash / command shortcut* (type `/` for a quick formatting palette). InkyCap warns you if you switch both off, since they're how you reach many visual-editor conveniences.

== Language

- *Interface language* chooses the language of InkyCap's menus and buttons. Your note content is unaffected, and the panel re-renders live when you switch.
- *Spellcheck* checks spelling as you type using bundled Hunspell dictionaries; misspellings are underlined and right-clicking offers suggestions. When it's on you can enable one or more *Dictionaries* (handy for bilingual notes, where a word is accepted if any enabled dictionary knows it) and *Install dictionaries* by dropping in your own files.
- *Personal dictionary* is the per-notebox list of words you've chosen to accept. These are recognized throughout the notebox by both spellcheck and concept detection, and they travel with it.

== Appearance

These settings affect InkyCap's _interface_, not your compiled documents (except for the *Rendering Defaults* grouped near the bottom).

- *Theme* (Light / Dark / Follow system) and matching light/dark *Background* variants.
- *Accent color* offers Default, a Custom colour, or Match OS.
- Font roles for the *Interface*, *Editor*, *Monospace*, and *Verse* text, plus *Editor font size* and a *User interface scale*.
- *Zoom shortcut target* sets whether Ctrl+/Ctrl- adjusts content, the interface, or both.
- *File tree folder grouping* puts folders before files, after files, or mixed in.
- *Date format* sets how dates appear throughout the interface (agenda, backup times, the "Last backup" line). It does not change backup filenames or the dates stored in your notes.

=== Rendering Defaults

These do affect both compiled output (e.g. PDF export) and reading view. These can be overridden per collection or per note.

- *Reading view format preference* offers *SVG* (precise, paginated but appears as an image) or *HTML* (copyable text but less precise).
- *Show inline wikilinks* and *Show inline tags* in rendered output.
- *Text font*, *Text size*, and *Page size* (A4, US Letter, A5, and more) for compiled documents. See #wikilink("3 - Exporting and Publishing").

== Files & Links

- *New note location* (this notebox) sets where new notes are created: the notebox root, the current folder, or a specified folder (which reveals a *New note folder* path).
- *Attachment folder* (this notebox) sets where dragged, pasted, or imported images and embeds are stored.
- *Auto-update links on rename* keeps your wikilinks pointing to the right place when a file is renamed (see #wikilink("4 - Links and Backlinks")).
- *Confirm before delete* and *Display filename extensions in file tree* control everyday file-tree behaviour.

Under *Zettelkasten IDs* you can have InkyCap automatically assign each new note a unique `zid` based on a date-and-time *pattern*, and optionally use that ID as the filename.

== Citations

This tab tells InkyCap where your references come from and how they should look. For the full workflow, see #wikilink("7 - Citations and Bibliography").

- *Citation source* (this notebox) is a *Bibliography file* (`.bib`, `.yml`, `.json`) or a *Zotero database*. For a file you can *Browse* to it; for Zotero you can *Detect* the database path.
- *Citation style* is a built-in style (the default is *Chicago (Author-Date)*; APA, MLA, IEEE, and many others are available) or a *Custom CSL file* of your own (this notebox). This can be overridden per file or by collection in rendered output.

== Import/Export & Backup

This tab configures importing notes, the Pandoc helper, and automatic backups.

- *Import markdown files* lets you point InkyCap at a `.tar.gz` or `.zip` archive of markdown files, choose the *Standard* or *Obsidian* dialect, and *Run import*. See #wikilink("2 - Importing Existing Notes").
- *Export* lets you set a *Pandoc path* (or let InkyCap auto-detect it) so you can export through Pandoc in addition to InkyCap's native Typst exports.

#callout("note")[ This tab only configures Pandoc and markdown import. The actual export actions live in the Export dialogue elsewhere (see #wikilink("3 - Exporting and Publishing")). ]

=== Backups

Turn on *Enable* to schedule automatic backups, then set:

- *Destination* is a folder outside your notebox.
- *Interval (hours)* and *Keep count* set how often to back up and how many archives to retain.
- *Only back up when changed* and *Include user config* to fine-tune what's saved.
- *Filename pattern* is a template using tokens like `{notebox}`, `{YYYY}`, `{MM}`, and `{DD}`.
- *Password* is an optional password that encrypts each archive, stored securely in your operating system's keychain.

The *Last backup* line shows when the most recent archive ran, with *"Run backup now"* and *"Browse and restore…"* buttons.

#callout("warning")[ Each archive uses the password that was active when it was created. InkyCap does not store your passwords. If you lose the password, those archives cannot be recovered. InkyCap warns you of this when you set one. ]

== Creation Rules

Creation rules turn repetitive note-making into one click or one shortcut. This tab lists your rules and lets you add new ones with *+ New Rule*. For the bigger picture, see #wikilink("3 - Scaffolds, Templates, and Packages"). For example do you like to format notes with specific headings or tags to capture lecture notes? You could create a Lecture Note creation rule, which lets you start a new note automatically formatted by a scaffold you define.  

InkyCap ships with *New Note* and *Daily Note* built-in rules. A rule can specify a name and icon, a *Filename pattern*, a *Target folder*, a *Scaffold file* for starting content, a *Typst template*, a *Creation mode*, an optional *Hotkey*, and whether it shows a toolbar button.

#callout("note")[ The *New Note* rule backs the New Note button and `Ctrl+N`, so it can't be disabled or deleted. ]

== Behaviour

- *Startup behaviour* (global) sets what InkyCap shows when it opens: the file tree, your last file, a launched rule, or a specific page or collection (those last options add a target picker for the current notebox).
- *Tabs*. *Switch to new tabs immediately* decides whether a new tab takes focus or opens in the background.
- *Software updates*. *Check for updates on startup* is *off by default*, so InkyCap makes no network connection unless you turn it on or check manually. You can also opt in to development (beta) releases.
- *Journal Scroll* (this notebox). *Sort by* and *Anchor scope* control how the continuous journal view is assembled. See #wikilink("4 - Journal Scroll").

== Extensions

The Extensions tab lets you register external programs you trust to extend InkyCap (for example a grammar checker or a custom script). For the full guide, see #wikilink("4 - Extensions").

#callout("warning")[ This feature is experimental and might not function perfectly. InkyCap ships no tools of its own; you register executables you trust. ]

Each tool you add can specify a *Command* (the program's path), *Arguments*, what text to *Send to the tool*, how to *Use the result*, and where to *Show* it (command palette, editor menu, or both).

== About

The About tab is purely informational. There are no settings here.

- *About InkyCap* gives the copyright and licensing: code under the LiLiQ-P (Québec Free and Open Source Licence – Permissive), documentation under Creative Commons CC BY-SA.
- *Open Source and Free Culture* credits the fonts, the Typst engine and tooling, the editor and interface libraries, spellcheck dictionaries, and more, each with a licence badge and a link.
- *Show full notices* reveals the complete third-party notices for the Rust and JavaScript dependencies.
\

== Related pages

- #wikilink("7 - Citations and Bibliography")
- #wikilink("3 - Scaffolds, Templates, and Packages")
- #wikilink("4 - Extensions")
- #wikilink("3 - Exporting and Publishing")
- #wikilink("1 - Collaboration")
- #wikilink("1 - The InkyCap Interface")
- #wikilink("3 - Keyboard Shortcuts")
