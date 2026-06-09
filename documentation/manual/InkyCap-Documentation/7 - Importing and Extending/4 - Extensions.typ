#import "/.inkycap/notebox.typ": *

#note(
  title: "Extensions",
  description: "How to extend InkyCap today using the experimental Extensions tab and external tools, plus file-based declarative plugins and other extension surfaces.",
  tags: ("documentation",),
)

= Extensions

You can add important functionality using #wikilink("3 - Scaffolds, Templates, and Packages", label: "templates-and-packages", display: "Typst Universe Packages") but #highlight(fill: rgb("#ffd6a8"))[*InkyCap does _not_ currently have its own unique plugin ecosystem*]. 

InkyCap lets you connect your own programs and small add-ons from the outside, to help fit your particular workflow. This page explains what you can extend today and where to find the controls. 

#callout("warning")[
  Extensions are *experimental*. The feature works, but it is early, and the way you set things up may change in future versions. In the app you will see the notice "This feature is experimental and might not function perfectly." Treat what is here as a solid foundation, not a finished, locked-in system.
]

== Where extensions live

Most of the action happens in the *Extensions* tab of the Settings dialogue. Open #wikilink("2 - Settings"), and look in the list of tabs on the left. *Extensions* sits second from the bottom, just above *About*.

#callout("note")[
  The Extensions tab in Settings covers one specific kind of extension: connecting *external programs* to InkyCap. The other ways to extend the app (described further down) are file-based and have no settings screen. They are aimed at more technical users who are comfortable editing a small text file.
]

== Connecting external tools

The headline feature on the Extensions tab is a bridge to *external tools* (any program already on your computer that you trust). The idea is relatively simplistic: InkyCap hands some of your text to the program, the program does its work and prints a result, and InkyCap takes that result back. This is how you might wire up a grammar checker like #link("https://languagetool.org")[LanguageTool], a style linter, an AI rewriting helper, dictation clean-up, or almost anything else.

#callout("important")[
  InkyCap ships with *no* built-in extensions and runs *nothing* on its own. An extension tool only ever runs because you explicitly added it and pointed InkyCap at the program's location. This is the same trust model as InkyCap's connections to Pandoc and Zotero. You decide what runs.
]

=== Adding a tool, step by step

+ In Settings, open the *Extensions* tab.
+ Select *Add a tool*. A new card appears.
+ Give the tool a *Name* (for example, "Grammar check"). This is the name you will see later when you run it.
+ Set the *Command* to the program you want to run. Use *Browse* to pick the program's file, or paste its full location.
+ Optionally fill in *Arguments*, choose what gets sent to the tool, and choose what InkyCap does with the result (see below).
+ Optionally pick an *icon* for the tool's output tab.

A tool becomes runnable once it has both a name and a command. To remove a tool, use the *X* button on its card.

=== Choosing what the tool receives and returns

Each tool card lets you decide exactly how text flows in and out.

- *Send to the tool* is what InkyCap feeds the program:
  - "Selected text" sends just what you have highlighted.
  - "Whole note" sends the entire note.
  - "Nothing" sends no text (useful when the tool takes its input some other way; see the aside below).

- *Use the result* is what InkyCap does with what the program prints:
  - "Replace the selection" swaps your highlighted text for the result. Useful for rewrites and corrections.
  - "Insert at the cursor" drops the result in at your cursor, leaving any selected text in place.
  - "Show a temporary message" flashes a short pop-up message and leaves your note untouched. Best for one-line answers.
  - "Show it in a side panel" opens a lasting panel on the right (next to Properties, Outline, and Links) with the tool's results. Best for longer reports. The panel is tied to the note you ran it on, and running the tool again refreshes the same panel.

- *Show in* is where you will access the tool:
  - "Command palette" (the default) puts it under a *Tools* category in the global command palette. This keeps your selection intact, so it suits tools that act on selected text.
  - "Editor / menu" puts it in the editor's `/` menu. Typing `/` replaces your selection as you go, which suits tools that insert text.
  - "Both".

- *Send plain text only* is on by default. With this on, InkyCap strips out the Typst markup, properties, math, and code before sending, so the program receives just your prose. That is ideal for grammar and style checkers. Turn it off if your tool needs the raw source.

#callout("tip")[
  Pick "Command palette" + "Replace the selection" for editing helpers (grammar, rewriting), and "Show it in a side panel" for tools that produce a report you want to keep reading. If a tool just answers a quick question, "Show a temporary message" keeps things tidy.
]

=== Things to know about safety and limits

- *Privacy stays in your hands.* InkyCap does not send your notes anywhere on its own. If a tool you set up talks to a network service, that is your deliberate choice; your note's text goes wherever you pointed it.
- *Output is bounded.* A tool's result is capped at 8 MB, and any run that takes longer than 60 seconds is stopped automatically, so a misbehaving program can't run away with your session.
- *No surprises.* InkyCap only runs the exact program you registered, identified internally so the path can't be swapped out from elsewhere, and it does not route commands through a shell.

#callout("tip", title: "Details")[
  This is a plain Unix-pipe bridge: InkyCap writes to the program's *stdin* and applies its *stdout*; *stderr* is discarded and a non-zero exit code is reported as a failure. *Arguments* are one per line and passed as a vector (never a shell string), with three literal placeholders substituted verbatim:

  ```
  $INKYCAP_NOTEBOX_ROOT   the open notebox's root folder
  $INKYCAP_FILE           the current note's path
  $INKYCAP_SELECTION      the selected text (always raw, even when
                          "Send plain text only" is on)
  ```

  For a program that reads its input from arguments rather than a stream, set *Send to the tool* to "Nothing" and put `$INKYCAP_SELECTION` (or `$INKYCAP_FILE`) in *Arguments*. Stripping to plain text uses an AST-based extractor that follows the Typst parser, so it tracks the real structure rather than guessing with patterns. Advanced users can also edit `external_tools.tools` directly in `settings.json`.
]

== Other ways to extend InkyCap

The Extensions tab is one of several extension surfaces. The rest are file-based (you create or edit a small file rather than use a settings screen), and none of them require modifying or rebuilding InkyCap.

=== Declarative plugins

A declarative plugin is a single JSON file that adds *data*, not code. It can contribute two things:

- *Commands* are new entries in the editor's `/` menu that insert a snippet of markup at your cursor.
- *Views* are buttons on the left toolbar that open a side panel listing every note matching a search query you specify.

Because a declarative plugin runs no code, it cannot read your notes on its own or reach the network; there is nothing to trust. You add one by dropping a `.json` file into a plugins folder (either a global one for every notebox, or one inside a specific notebox so it travels with that notebox), then reopening the notebox. There is no settings screen for this yet; it is meant for power users comfortable editing a small text file.

#callout("example")[
  A short manifest with a command that inserts a heading and a view, which lists your journal entries adds two `/` commands and one sidebar button the next time you open the notebox, with no rebuild required.
]

=== The open notebox format and Typst packages

Two more surfaces round things out:

- *The open notebox format.* Your notebox is plain Typst plus a documented `.inkycap/` folder, and all your metadata is readable with the standard Typst tools. That means any other program can read and write your notes directly, without going through InkyCap at all.
- *Typst packages.* New document-level behaviour (custom callouts, metadata schemas, layout helpers) comes from extending InkyCap's bundled Typst package or importing one from the #link("https://typst.app/universe/")[Typst package universe]. This is the natural home for anything that affects how your documents look or compile. See #wikilink("3 - Scaffolds, Templates, and Packages").

== What is not here yet

Current boundaries:

- There is *no* installable code-plugin system. There is no marketplace, no sandbox for running arbitrary add-on code, and no plugin API beyond the surfaces above.
- Declarative plugins have *no* in-app interface yet; you edit the JSON file by hand.
- A deeper, in-app plugin runtime (think custom panels and built-in computation) is a *possible future direction*, not something you can use today.

The foundations (documented, stable contracts rather than hidden internals) are deliberate so that future extensions can slot in without breaking what you have built. For now, the external-tool bridge and declarative plugins give you some possibilities, and they should continue working as InkyCap evolves.

== Related pages

- #wikilink("2 - Settings")
- #wikilink("3 - Scaffolds, Templates, and Packages")
- #wikilink("7 - Citations and Bibliography")
- #wikilink("1 - Importing and Extending")
