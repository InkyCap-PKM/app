#import "/.inkycap/notebox.typ": *

#note(
  title: "Setting Up Your Notebox",
  description: "How a notebox works (a portable folder of .typ notes plus a hidden .inkycap config), the three ways to start one, and how to organize, open, and switch noteboxes.",
  tags: ("documentation",),
)

= Setting Up Your Notebox

== What a notebox is

A *notebox* is simply a folder on your computer. Inside it live your notes (one file per note) alongside a small hidden settings folder that InkyCap maintains for you. There is no proprietary file format to lock you in: it's plain text files on disk, which you can copy, back up, sync, or peek at with any tool you already use.

InkyCap always works inside a notebox. When you open the app, you're opening one notebox; everything you write, link, and organize belongs to it.

Each note is a Typst-formatted file (ending in `.typ`). That's what makes a notebox so portable. You can open the same folder in other Typst tools and your notes will compile. The structured information InkyCap adds (titles, tags, links, and so on, covered in #wikilink("6 - Note Properties")) is stored in a way other Typst programs can read.

#callout("note")[ A folder becomes a notebox when InkyCap adds a hidden `.inkycap/` folder to it. That folder is how InkyCap (and any cooperating tool) recognizes the folder as a notebox. ]

#callout("tip", title: "For Typst users")[ Every note begins with a single automatically-added import line:
```typ
#import "/.inkycap/notebox.typ": *
```
Because notebox properties are emitted as labelled Typst `#metadata`, you can read them from outside InkyCap with the stock CLI (no InkyCap process required):
```
typst query path/to/note.typ "<inkycap-note>" --field value --one
```
Tags use the `<inkycap-tag>` label and links use `<inkycap-link>`. Paths InkyCap writes into your notes (for images, data files, and bibliographies) start with `/`, which Typst resolves against the notebox root, so they stay correct as notes move around. ]

== Three ways to start a notebox

You can begin a notebox in three ways. The first is the most common and is described in depth below; the other two are quick pointers to fuller pages.

You'll find all three in *Settings*, under the *Notebox Management* section (see #wikilink("2 - Settings")):

+ *New notebox* creates an empty notebox on your own computer. Start fresh, or copy your files and preferences from a notebox you already have.
+ *Clone from remote* downloads an existing notebox from a shared Git repository to work on it with others online.
+ *Import package* creates a notebox from a package file that a collaborator sent to you (for example, as an e-mail attachment).

=== Creating a new notebox

This is the path most people use when starting out.

+ Open *Settings* and find *Notebox Management*, or (if no notebox is open yet) use the *Open or create a notebox…* button on the welcome overlay.
+ Choose *New notebox*. A folder picker opens, starting in your home folder.
+ Pick an empty folder (or make a new one) where you'd like your notes to live, and confirm.

Opening a folder that isn't yet a notebox turns it into one. InkyCap adds the hidden `.inkycap/` folder and a couple of starter note templates, and you're ready to write.
\

*Copying from an existing notebox.* If you already have another notebox and you point InkyCap at a fresh, empty folder, it offers to bring your preferences along. You'll see a *Copy from an existing notebox?* prompt:

- Choose *Copy and open* to carry over your settings, your note-creation rules, your scaffolds (InkyCap's own note "templates"), and your typed property definitions from one of your other noteboxes.
- Choose *Use defaults* (or press Esc) to start clean.

This copies your *preferences* not your notes. Your existing notes stay where they are. Absolute file paths inside the copied settings (such as a bibliography file or a custom citation style) are kept only if they still point to something real on this computer.

=== Joining a notebox shared online

If a colleague has put a notebox in a shared git repository, use *Clone from remote* to download a working copy and collaborate. You'll provide the repository address and, if needed, a username and password. See #wikilink("1 - Collaboration") for the full walkthrough.

=== Joining a notebox shared offline

If a collaborator sent you a notebox as a package file (when not using a shared server or for privacy), use *Import package*. If the package was encrypted, you'll be asked for its password. #wikilink("1 - Collaboration") covers this too.

#callout("note")[ Bringing in and converting a stack of existing Markdown files is a different task. That's *importing notes into a notebox you already have*, not creating a notebox. See #wikilink("2 - Importing Existing Notes"). ]

== Organizing your notes

Inside a notebox, you can arrange notes into folders however you like (by topic, by project, by course, or whatever fits how you think). 

You manage your notes from the *File Tree* (the *Files* tab in the left sidebar). From there you can:

- Create a new note with the *New note* button (or press *Ctrl+N*).
- Create a *New folder* to group related notes.
- Use *Copy into notebox* to bring outside files in.
- *Collapse all folders* or *Expand all folders* to tidy your view.
- *Sort files* to change their order: by name, by the date modified or created, or by Zettelkasten ID (see #wikilink("2 - Settings")), each in ascending or descending order.


=== Note names must be unique

Wikilinks find a note by its name alone, ignoring which folder it lives in, so no two notes in a notebox may share a name. If you try to create a note whose name is already taken, InkyCap stops and offers a choice: *Open existing note*, *Append ZID* (which keeps both by adding a unique identifier to the new name; offered when Zettelkasten IDs are turned on), or *Use a different name*.

Notes that arrive from other tools can slip past this check, and some names that are fine on Linux cannot exist on Windows or macOS. To find both kinds of problem, open the command palette (*Ctrl+P*) and run *Check filenames for cross-platform problems or duplication*. The *InkyCap Name Report* that opens lists each name that needs attention, explains why, and lets you open the note in a new tab to fix it. Use *Re-scan* after renaming, or *Save report* to keep a copy. The check only reports; it never renames anything for you.

#callout("tip")[ Prefer cleaner-looking names? The setting *Display filename extensions in file tree* lets you hide the trailing `.typ` so notes read as plain titles. ]

== The Assets folder

Images, PDFs, and other files you add to your notes need somewhere to live. By default that's a folder named *Assets* inside your notebox. When you drag in a picture, paste an image, or insert one through the `/` command, InkyCap files it under *Assets*.

You can change where InkyCap stores these attachments. Go to your *Settings → Files & Links*, in the *Attachment folder* field. If you rename it there (via *Rename folder…*), InkyCap will move every existing file and rewrite every reference across your whole notebox so that nothing breaks.

While you're in *Settings → Files & Links*, you can also decide where new notes are created by default:

- *Notebox root* is the top level of your notebox (the default).
- *Current folder* is wherever you happen to be working when you create the note.
- *Specified folder* is a fixed folder you name.

== Opening and switching noteboxes

Each InkyCap window holds *one notebox at a time*. 

To switch to a different notebox, use the *notebox switcher* in the status bar at the bottom left of the window. Your known noteboxes are listed there; pick one to open it. You can click *Manage noteboxes…* to create another. 

If you'd rather keep your current notebox open and have a second one alongside it, open the new one in its own window:

- Use *Open in a new window* from the status bar, or
- Press *Ctrl+Shift+N*.

#callout("note")[ The same notebox can't be open in two windows at once. In the switcher, a notebox open elsewhere appears greyed out with an *Open in another window* note. ]

When you launch InkyCap, it reopens the notebox you last used. If there's nothing to reopen, you'll see an *Open a notebox to continue* screen listing your noteboxes. Pick one, or create a new one, to get going.

What InkyCap shows once the notebox is open is up to you. The *Startup behaviour* setting (under *Behaviour* in #wikilink("2 - Settings")) can show a clean file tree, your last opened file, a particular page or collection, or *Previously open tabs*, which restores every tab you had open when you last closed that notebox, including the tab you were on and each tab's editing mode and zoom. That record is kept on your own computer, not inside the notebox, so sharing or syncing the notebox does not carry it along.

#callout("important")[ Removing a notebox from this list only makes InkyCap forget about it. Your folder and all your notes stay safely on disk; you can always add it back later. ]

== Related pages

- #wikilink("1 - Getting Started")
- #wikilink("2 - Settings")
- #wikilink("6 - Note Properties")
- #wikilink("3 - Scaffolds, Templates, and Packages")
- #wikilink("2 - Importing Existing Notes")
- #wikilink("1 - Collaboration")
