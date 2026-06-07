#import "/.inkycap/notebox.typ": *

#note(
  title: "Quick Start",
  description: "The fastest path from installing InkyCap to creating a notebox, writing your first note, and linking notes together with wikilinks.",
  tags: ("documentation",),
)

= Quick Start

== Welcome to InkyCap

This page is the shortest route from a fresh install to writing and linking your first notes. It's written for people who have never used InkyCap, Typst, or git before. If you'd like the bigger picture, #wikilink("1 - Getting Started") and #wikilink("1 - The InkyCap Interface") fill in the surroundings.

A *_notebox_* is the folder where all your notes live, and InkyCap always works inside a notebox.

#callout("note")[ A notebox is just an ordinary folder on your computer. InkyCap adds a small hidden `.inkycap/` area inside it for templates, settings, and the writing tools. Your notes stay plain, portable text files within it. ]

== Before you begin

If InkyCap isn't installed yet, follow #wikilink("2 - Installing InkyCap") first, then come back here. Once the app launches, you're ready to open or create a notebox.

== Step 1 — Open or create a notebox

Because InkyCap can't do anything useful without an active #highlight[notebox], the very first thing you'll see on a fresh install is a screen titled *"Open a notebox to continue."* 

To start a brand-new notebox:

+ Click *"Open or create a notebox…"*.
+ Your computer's normal folder chooser opens (titled "Select notebox folder"), starting in your home folder. Pick an empty folder, or make a new one, anywhere you like.
+ Confirm your choice. InkyCap turns that folder into a notebox by quietly setting up its `.inkycap/` workspace inside it.

The folder is now your notebox, and the main editor appears.

#callout("note")[ If you already have at least one other notebox, InkyCap asks *"Copy from an existing notebox?"* before opening. Choose *"Use defaults"* to start clean (this is the safe default; pressing Enter or Escape also chooses it), or *"Copy and open"* to bring over another notebox's settings, templates, and property types. ]

#callout("tip", title: "For Typst users")[ The notebox folder becomes the Typst project root. Every note auto-imports the bundled library with a stable, version-less path:
```typ
#import "/.inkycap/notebox.typ": *
```
That single line is what makes `#note(...)`, `#wikilink(...)`, `#tag(...)`, and the other notebox primitives available. You never write it yourself. New notes include it from their scaffold. ]

=== The other two ways to start

Creating a fresh notebox is the common path, but there are two more, both meant for joining a notebox someone else has shared to collaborate with you:

- *Clone from remote* lets you join a collaborative notebox by its git address. You don't need any command-line knowledge.
- *Import package* lets you join a notebox that a collaborator handed to you offline as a single package file.

You'll find all three options together later in #wikilink("2 - Settings") under the Overview tab. For the full story on working with others, see #wikilink("1 - Collaboration"). If instead you have existing notes that you'd like to bring in, #wikilink("2 - Importing Existing Notes") walks you through it.

For a guided tour of laying out your new notebox, see #wikilink("3 - Setting Up Your Notebox").

== Step 2 — Write your first note

Press *Ctrl+N* to create a new note. (You can also use the *New note* button in the file tree on the left, or right-click a folder there and choose *New Note*.)

A new note opens from a template, already containing a few helpful fields and a heading, ready for you to type. Start writing under the heading. There's nothing to set up first.

#callout("tip")[ There's no Save button or save shortcut, and you don't need one. InkyCap saves your work automatically as you type, and writes each file safely so you never end up with a half-saved note. ]

You write using Typst's light markup (for example `*bold*`, `_italic_`, `= Heading`, and `- ` for a bullet list). #wikilink("3 - Formatting Your Writing") covers the full set, and #wikilink("2 - Editing Notes") explains the editor's day-to-day moves.

#callout("important")[ InkyCap reads Typst markup, not Markdown. Use `*bold*` (one asterisk) and `= Heading` (an equals sign). Markdown habits like `**bold**` or `# Heading` won't be styled. They'll appear literally. ]

== Step 3 — Link notes together

Linking is the heart of how you navigate in InkyCap. To link from one note to another, type two square brackets:

```typ
[[
```

A picker appears suggesting your existing note names. Choose one, and InkyCap inserts a link to it. (Behind the scenes this becomes a `#wikilink(...)` call, but you'll usually just see and type the `[[Name]]` form). If you type a name for a note that does not yet exist, your wikilink will appear, ready to use. Click it and the new note will be created with your page name so that you can start writing in it.

Every link you make is automatically two-way. When you link from note A to note B, note B gains a _backlink_ pointing back to A. Over time this web of connections becomes a map of your thinking and means you have an automatic organization of all of the information related to the topic of a note. See #wikilink("4 - Links and Backlinks") to go deeper.

#callout("example")[ While drafting a literature note, type `[[`, then start typing the title of your methods note. Pick it from the list. Your literature note now links to the methods note, and the methods note automatically shows your literature note in its backlinks. ]

== Step 4 — Turn on automatic backups

InkyCap can keep zipped backups of your whole notebox while you work. Backups are switched on by default, but they only start running once you tell InkyCap _where_ to put them.

+ Open #wikilink("2 - Settings") (*Ctrl+,*).
+ Go to the *Import/Export & Backup* tab and find *Notebox backup*.
+ Set a *Destination folder* (somewhere outside your notebox, such as an external drive or a synced cloud folder).

Once a destination is set, InkyCap backs up on a schedule (every 24 hours by default) and keeps the most recent few archives. You can also back up on demand with the *Back up now* button, or from the command palette (*Ctrl+P*, then "Back up notebox now").

#callout("warning")[ You can password-protect backups with strong encryption, but if you lose that password the backup cannot be recovered. There is no reset. ]

The #wikilink("2 - Settings") page explains every backup option, including retention, encryption, and restoring from an archive.

== You're up and running

You now have a notebox, a first note, your first link, and a safety net. From here:

- Get comfortable with the workspace in #wikilink("1 - The InkyCap Interface").
- Learn the editor's controls in #wikilink("2 - Editing Notes").
- Build out your connected library with #wikilink("4 - Links and Backlinks").

== Related pages

- #wikilink("2 - Installing InkyCap")
- #wikilink("3 - Setting Up Your Notebox")
- #wikilink("1 - The InkyCap Interface")
- #wikilink("2 - Editing Notes")
- #wikilink("3 - Formatting Your Writing")
- #wikilink("4 - Links and Backlinks")
- #wikilink("2 - Importing Existing Notes")
- #wikilink("1 - Collaboration")
- #wikilink("2 - Settings")
