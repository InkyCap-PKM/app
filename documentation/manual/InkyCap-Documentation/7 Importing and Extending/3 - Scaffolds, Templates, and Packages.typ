#import "/.inkycap/notebox.typ": *

#note(
  title: "Scaffolds, Templates, and Packages",
  description: "How to use scaffolds, creation rules, and Typst templates and packages to give your notes reusable starting points and tap the Typst ecosystem.",
  tags: ("documentation",),
)

= Scaffolds, Templates, and Packages

InkyCap gives you three kinds of reusable starting points (_scaffolds_, _document templates_, and _packages_) plus _creation rules_ that apply them automatically. If you've ever wished a new note could arrive half-filled-in, or wanted the polished look of a published article without fiddling with layout, this is where you set that up.

The three ideas are related but distinct, so it helps to keep them straight:

- *Scaffold*. A snippet of note content (with fill-in-the-blank placeholders) that you drop _into_ a note. Think "daily journal starter". A scaffold can also include a template or packages.
- *Template*. A whole-document wrapper that controls page layout, fonts, and styling, the way a journal's submission style does.
- *Package*. A reusable Typst library that adds capabilities (diagrams, fancy code blocks, and so on).

All three live together in one place: the *Scaffolds, Templates, & Packages* panel.

== Opening the panel

On the vertical toolbar down the side of the window, click the button with the layout-template icon (its tooltip reads *"Scaffolds, Templates, & Packages"*). This opens a pane in the left sidebar (not a pop-up window) with three small tabs across the top: *Scaffolds*, *Document Templates*, and *Packages*. It opens on the Scaffolds tab.

Two header controls exist:

- *Refresh* re-scans your notebox for scaffolds and packages, in case you added some outside the app.
- The *Info* (help) toggle shows a short, tab-specific explanation right in the panel. It's off by default; turn it on whenever you'd like a reminder of what a tab does.

== Scaffolds

A scaffold is just note content that you reuse. InkyCap comes with two, and you can add your own.

The two built-in scaffolds are *new-note* (the standard starter behind every new note) and *daily-note* (a dated starter ideal for journalling; see #wikilink("4 - Journal Scroll")). These are seeded into your notebox the first time you open it and then left alone but you can customize them.

=== Inserting a scaffold into a note

With a note open, press `Ctrl+\` to bring up the *Insert scaffold* picker. Start typing to filter your choices (if you've created many scaffolds), use the up and down arrows to choose, press Enter to insert, and Esc to cancel. (You can also run *Insert Scaffold* from the command palette.) If no note is open yet, InkyCap reminds you to "Open a note first".

When you insert, the scaffold's content is appended to the end of your note, with any placeholders filled in fresh at that moment (e.g. a variable for the title will add whatever title you've given the note). If the current note was blank, the scaffold fills it. 

If the scaffold begins with note properties, those are merged into your note's existing properties; your existing values are kept, and any new keys are simply added. Nothing you'd already written is disturbed.

=== Creating your own scaffold

+ In the Scaffolds tab, click *New*.
+ Give it a filename (for example, `meeting-notes`). You can leave off the `.typ`; InkyCap adds it.
+ The new scaffold opens in a tab, pre-filled with a starter you can edit freely.

To revisit any scaffold later, click its row in the list to open it.

=== Fill-in-the-blank placeholders

Scaffolds (and several creation-rule fields) understand `{{...}}` placeholders that get filled in when the scaffold is used. The most useful ones:

- `{{title}}` is the note's title.
- `{{filename}}` is the note's file name on disk.
- `{{slug}}` is a tidy, URL-safe version of the title.
- `{{date}}` is today's date as `YYYY-MM-DD`.
- `{{date:FORMAT}}` is today's date in a format you choose (see below).
- `{{time}}` and `{{time:FORMAT}}` give the current time.
- `{{zid}}` is a Zettelkasten ID, if you've set up that pattern.
- `{{cursor}}` marks where your cursor should land when opening the note.

The format inside `{{date:...}}` uses familiar tokens: `YYYY` (year), `MM` (month number), `MMMM` (full month name), `DD` (day), `dddd` (weekday name), `HH` and `mm` (hours and minutes), and so on. Anything that isn't a token passes through as-is, so `{{date:D MMMM YYYY}}` gives you something like "5 June 2026". Month and weekday _names_ follow your interface language, so a French interface would render "vendredi".

#callout("note")[ When a note is created by a _creation rule_ (the next section), your cursor is placed on a fresh blank line at the very end of the note, regardless of where `{{cursor}}` sits. ]

== Creation rules

A creation rule is a preset for making a new note. Instead of creating a blank file and setting it up by hand each time, a rule can pick the folder, name the file, fill it from a scaffold, apply a template, and bind a keyboard shortcut (all at once). This is what makes "press a key, get today's dated journal entry in the right folder" possible.

You manage rules in #wikilink("2 - Settings"), on the *Creation Rules* tab. As the panel puts it, creation rules "simplify repetitive note creation processes."

=== The two built-in rules

- *New Note* backs the file tree's "New Note" button and the `Ctrl+N` shortcut. It's foundational, so it can't be deleted or disabled.
- *Daily Note* creates (or, if it already exists, simply opens) today's dated note in a `Daily/{{date:YYYY}}` folder, on `Ctrl+D`. It appears as a toolbar button by default. You can't delete it, but you _can_ disable it if you don't journal.

=== Building your own rule

Click *+ New Rule* and fill in the fields that matter to you:

- *Name* is required; it's what the rule is called.
- *Icon* lets you pick a small icon, or type your own one- or two-character label or emoji.
- *Filename pattern* sets how new files are named. Use placeholders like `{{title}}` or `{{date:YYYY-MM-DD}}`, or leave it blank to be asked each time.
- *Target folder* is where notes land, relative to your notebox root. Leave it empty to fall back to your default "New note location" (set under Files & Links; see #wikilink("3 - Setting Up Your Notebox")). It accepts date and title placeholders too.
- *Scaffold file* is which scaffold (if any) fills the new note.
- *Typst template* is an optional whole-document template (covered below).
- *Creation mode* is "Create and open" (the default) or "Create only".
- *Hotkey*: click to record a key combination; InkyCap refuses combinations already bound to something else.
- *Show button in toolbar* adds a one-click button to the vertical toolbar.
- *Description* is an optional note to your future self.

Save when you're done. The *Restore Defaults* button re-seeds a built-in rule's original settings, or clears a custom rule back to blank.

#callout("tip")[ Every active rule also shows up in the command palette under the *Creation Rules* category, so you can run it without memorizing its shortcut. ]

#callout("warning")[ When choosing a Typst template for a rule, the on-screen description still mentions a "templates folder" and paths like `/templates/ieee.typ`. That wording is out of date. What actually happens: a value starting with `@` or `/` is used exactly as typed (for example `@preview/charged-ieee:0.1.0`), and a plain name like `letter-layout` is treated as `@local/letter-layout:0.1.0`. There is no separate templates folder. ]

== Templates and packages <templates-and-packages>

Beyond your own snippets, InkyCap connects to the wider Typst ecosystem: the *#link("https://typst.app/universe/")[Typst Universe]*, a public library of templates and packages anyone can use.

- *Document Templates* are whole-document wrappers (page size, margins, fonts, heading styles). Applying one is how you make a note look like a specific journal article, report style, presentation, CV, or other type of document.
- *Packages* are libraries that add features. For example, CeTZ draws diagrams; codly prettifies code blocks; Scorify renders sheet music, there are even games and many other types of packages exist.

Both are managed from their respective tabs in the panel, and both are stored together inside your notebox so they travel with it.

=== Installing from the Typst Universe

+ Open the *Packages* tab (or *Document Templates* for a template).
+ Click *Install* and enter a spec, such as `@preview/cetz:0.2.0`. The `@preview/` part means "from the Typst Universe".
+ InkyCap fetches it and reports how many files it installed.

Each installed item appears as a row with its name, version, and an origin badge (Typst Universe items read "Typst Universe"; ones you made yourself read "Your package" or "Your template"). The *Copy* action puts the exact import line on your clipboard so you can paste it into a note, and the trash icon uninstalls it.

You can also install a template or package from a local `.tar.gz` archive with *From file*, or create your own starter with *New*. This is handy if you want to build a house style for your own writing.

=== How packages work

You rarely need to think about where packages are stored. InkyCap looks for them in your notebox first, then in the shared Typst cache on your computer (the same cache the standard Typst tools use), so your documents compile the same way everywhere. And if a note imports a Universe package you haven't installed, InkyCap downloads it on the spot (along with anything it depends on) and carries on compiling---_this is a case in which InkyCap would need to access the Internet_. Applying a Universe document template needs nothing special; it's the same automatic machinery.

#callout("tip", title: "For Typst users")[ Templates and packages live under `.inkycap/packages/<namespace>/<name>/<version>/`, exactly where the Typst compiler expects them, and that folder is _not_ git-ignored. Import a Universe library with the usual line:

```typ
#import "@preview/cetz:0.2.0": *
```

A package is treated as a _document template_ precisely when its `typst.toml` declares a `[template]` section; otherwise it's a library. The `@preview` namespace is the public registry; `@local/<name>:0.1.0` is for packages you author yourself (these are never auto-downloaded; there's no registry to fetch them from). Auto-download only resolves `@preview` specs, pulling them and their transitive dependencies into the shared Typst cache shared with `typst-cli` and Tinymist. ]

=== Bundling packages when you share

Packages live inside your notebox, but a package you only _downloaded_ sits in your machine's shared cache, not in the notebox folder. If you collaborate or share a notebox, turn on *Bundle Typst packages on share* (in the Git Collaboration panel). InkyCap then scans your notes' imports and copies every package they need into the notebox, so your collaborators can compile your documents without hunting anything down. See #wikilink("1 - Collaboration") for more on sharing.

== Related pages

- #wikilink("3 - Setting Up Your Notebox")
- #wikilink("2 - Settings")
- #wikilink("4 - Journal Scroll")
- #wikilink("1 - Collaboration")
