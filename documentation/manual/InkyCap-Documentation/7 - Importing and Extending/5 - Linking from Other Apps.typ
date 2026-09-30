#import "/.inkycap/notebox.typ": *

#note(
  title: "Linking from Other Apps",
  description: "How to open a note from other apps with an inkycap:// link: copying links, what they look like, and what happens when you click one.",
  tags: ("documentation",),
)

= Linking from Other Apps

An *InkyCap link* opens a particular note or collection in InkyCap from anywhere on your computer: a calendar entry, an email draft, a task manager, another app's notes, or a script. Clicking one brings InkyCap to the front with that note open, starting InkyCap first if it is not running.

InkyCap links start with `inkycap://`. They work only on your own computer, and send nothing over the internet.

== Copying a link

Right-click a note or collection and choose *Copy InkyCap link*. The link is copied to your clipboard, ready to paste wherever you like. You will find the command in:

- the file tree, for notes and collections;
- the *Collections* list;
- the *Tab options* menu at the right end of the tab bar, for the note or collection in the active tab;
- the *Outline* panel, where *Copy InkyCap link to this heading* makes a link that opens the note scrolled to that heading.

== What happens when you click a link

- *The notebox is open in a window:* that window comes to the front and the note opens in a new tab beside what you were working on.
- *The notebox is not open anywhere:* InkyCap asks before opening it, and then opens it in a new window so your current tabs are left alone.
- *InkyCap is not running:* InkyCap starts and opens the link's notebox straight away, without asking.
- *The note no longer exists:* InkyCap shows a short message and does nothing else. Unlike a #wikilink("4 - Links and Backlinks", display: "wikilink"), a link from outside InkyCap never creates a note.

#callout("note")[A link names its notebox by the name shown under *Manage noteboxes*, so renaming a notebox stops its existing links from working. Links can only open noteboxes listed there; a link can never make InkyCap open a folder you have not added yourself.]

== Linking between noteboxes

Wikilinks only reach notes in the same notebox. To link to a note in a _different_ notebox, paste an InkyCap link into a regular Typst link:

```typst
#link("inkycap://open?notebox=Professional&file=Reading%20list.collection")[My reading list]
```

Clicking it follows the link inside InkyCap, as described above.

== What a link looks like

```text
inkycap://open?notebox=Professional&file=1%20Ephemera%2FTestpad.typ
inkycap://open?notebox=Professional&file=Testpad.typ&heading=Method
inkycap://open?notebox=Professional&zid=20260916T0930
inkycap://search?notebox=Professional&query=hydrology
```

You can write links by hand, or build them in a script. Each link has a verb (`open` or `search`) and some values:

#table(
  columns: 3,
  table.header[*Value*][*Used with*][*Meaning*],
  [`notebox`], [both], [The notebox's name under *Manage noteboxes*. Always needed.],
  [`file`], [`open`], [The note or collection, as a path inside the notebox, with `/` between folders. `.typ` can be left off a note's name.],
  [`zid`], [`open`], [The note's `zid` property, used instead of `file`. A link by zid keeps working when the note is renamed or moved.],
  [`heading`], [`open`], [Optional. A heading's text, or its label, to scroll to.],
  [`query`], [`search`], [Text to search for in the notebox's *Search* panel.],
)

Spaces and other special characters in the values must be written the way web addresses write them: a space as `%20`, a `/` inside a value as `%2F`, `&` as `%26`, `#` as `%23`. Links that InkyCap copies for you already do this. If a link gives both `file` and `zid`, the `zid` is used.

A link can only open notes and collections, or run a search. It never changes, creates, or deletes anything, and a link that is written incorrectly is ignored.

== When links do nothing

Clicking a link needs your computer to know that InkyCap handles `inkycap://`. InkyCap's installers (for Linux, Windows, and macOS) and the Flatpak take care of this. The AppImage does it itself each time it starts, so if you move the AppImage file, start it once from its new place. Starting an AppImage also makes it the copy of InkyCap that receives links, even when another copy is installed.

On macOS, InkyCap must be in your *Applications* folder for links to reach it.
