#import "/.inkycap/notebox.typ": *

#note(
  title: "Setting Up Your Notebox",
  description: "How a notebox works (a portable folder of .typ notes plus a hidden .inkycap config), the three ways to start one, and how to organize, open, and switch noteboxes.",
  tags: ("documentation",),
)

= Setting Up Your Notebox

== What a notebox is

A *notebox* is simply a folder on your computer. Inside it live your notes (one file per note) alongside a small hidden settings folder that InkyCap maintains for you. There is no database and no proprietary file format to lock you in: it's plain files on disk, the same kind you can copy, back up, sync, or peek at with any tool you already use.

InkyCap always works inside a notebox. When you open the app, you're opening one notebox; everything you write, link, and organize belongs to it.

Each note is a plain Typst file (ending in `.typ`). That's what makes a notebox so portable. You can open the very same folder in any other Typst tool and your notes will compile, because InkyCap never hides your content inside something only it can read. The structured information InkyCap adds (titles, tags, links, and so on, covered in #wikilink("6 - Note Properties")) is stored in a way other Typst programs can read too.

#callout("note")[ A folder becomes a notebox when InkyCap adds a hidden `.inkycap/` folder to it. That folder is how InkyCap (and any cooperating tool) recognizes the folder as a notebox. ]

#callout("tip", title: "For Typst users")[ Every note begins with a single auto-added import line:
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
+ *Import package* creates a notebox from a package file a collaborator sent you offline.

=== Creating a brand-new notebox

This is the path most people use when starting out.

+ Open *Settings* and find *Notebox Management*, or (if no notebox is open yet) use the *Open or create a notebox…* button on the welcome overlay.
+ Choose *New notebox*. A folder picker opens, starting in your home folder.
+ Pick an empty folder (or make a new one) where you'd like your notes to live, and confirm.

That's it. There's no separate "create" step: opening a folder that isn't yet a notebox turns it into one. InkyCap quietly adds the hidden `.inkycap/` folder and a couple of starter note templates, and you're ready to write.

#callout("important")[ A brand-new notebox does *not* come with a welcome or index note. It starts empty, so the first note you create is genuinely your first note. ]

*Copying from an existing notebox.* If you already have another notebox and you point InkyCap at a fresh, empty folder, it offers to bring your preferences along. You'll see a *Copy from an existing notebox?* prompt:

- Choose *Copy and open* to carry over your settings, your note-creation rules, your scaffolds (InkyCap's own note "templates"), and your typed property definitions from one of your other noteboxes.
- Choose *Use defaults* (or press Esc) to start clean.

This copies your *preferences*, not your notes. Your existing notes stay where they are. Absolute file paths inside the copied settings (such as a bibliography file or a custom citation style) are kept only if they still point to something real on this computer.

=== Joining a notebox shared online

If a colleague has put a notebox in a shared repository, use *Clone from remote* to download a working copy and collaborate. You'll provide the repository address and, if needed, a username and password. See #wikilink("1 - Collaboration") for the full walkthrough.

=== Joining a notebox shared offline

If a collaborator sent you a notebox as a package file (when not using a shared server or for privacy), use *Import package*. If the package was encrypted, you'll be asked for its password. #wikilink("1 - Collaboration") covers this too.

#callout("note")[ Bringing in and converting a stack of existing Markdown files is a different task. That's *importing notes into a notebox you already have*, not creating a notebox. See #wikilink("2 - Importing Existing Notes"). ]

== Organizing your notes

Inside a notebox you're free to arrange notes into folders however you like (by topic, by project, by course, or whatever fits how you think). InkyCap doesn't impose a structure.

You manage your notes from the *File Tree* (the *Files* tab in the left sidebar). From there you can:

- Create a new note with the *New note* button (or press *Ctrl+N*).
- Create a *New folder* to group related notes.
- Use *Copy into notebox* to bring outside files in.
- *Collapse all folders* or *Expand all folders* to tidy your view.
- *Sort files* to change their order.

The hidden `.inkycap/` folder, along with your templates and collections, is deliberately kept out of the file tree and out of search, so your everyday view stays focused on your actual notes.

#callout("tip")[ Prefer cleaner-looking names? The setting *Display filename extensions in file tree* lets you hide the trailing `.typ` so notes read as plain titles. ]

== The Assets folder

Images, PDFs, and other files you add to your notes need somewhere to live. By default that's a folder named *Assets* inside your notebox. When you drag in a picture, paste an image, or insert one through the `/` command, InkyCap files it under *Assets* and wires up the reference for you automatically.

You can change where InkyCap stores thse attachments. Go to your *Settings → Files*, in the *Attachment folder* field. If you rename it there (via *Rename folder…*), InkyCap doesn't just change the label. It moves every existing file and rewrites every reference across your whole notebox so nothing breaks.

While you're in *Settings → Files*, you can also decide where new notes are created by default:

- *Notebox root* is the top level of your notebox (the default).
- *Current folder* is wherever you happen to be working when you create the note.
- *Specified folder* is a fixed folder you name.

== Opening and switching noteboxes

Each InkyCap window holds *one notebox at a time*. The window you're looking at is unambiguously about a single notebox.

To switch to a different notebox, use the *notebox switcher* in the status bar at the bottom of the window. Your known noteboxes are listed there; pick one to open it. You can click *Manage noteboxes…* to create another. 

If you'd rather keep your current notebox open and have a second one alongside it, open the new one in its own window:

- Use *Open in a new window* from the status bar, or
- Press *Ctrl+Shift+N*.

Because each window owns its own notebox, opening a second notebox in a new window never disturbs the first.

#callout("note")[ The same notebox can't be open in two windows at once. In the switcher, a notebox open elsewhere appears greyed out with an *Open in another window* note. ]

When you launch InkyCap, it reopens the notebox you last used. If there's nothing to reopen, you'll see an *Open a notebox to continue* screen listing your noteboxes. Pick one, or create a new one, to get going.

#callout("important")[ Removing a notebox from this list only makes InkyCap forget about it. Your folder and all your notes stay safely on disk; you can always add it back later. ]

== Related pages

- #wikilink("1 - Getting Started")
- #wikilink("2 - Settings")
- #wikilink("6 - Note Properties")
- #wikilink("3 - Scaffolds, Templates, and Packages")
- #wikilink("2 - Importing Existing Notes")
- #wikilink("1 - Collaboration")
