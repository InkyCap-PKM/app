#import "/.inkycap/notebox.typ": *

#note(
  title: "Installing InkyCap",
  description: "How to download, install, and update InkyCap on Linux, macOS, and Windows, including the privacy-first built-in update checker.",
  tags: ("documentation",),
)

= Installing InkyCap

InkyCap is a desktop application that you install on your own computer. Everything you write stays on your machine by default (unless you explicitly share it outside).

== Installing on your platform

InkyCap aims to run on Linux, macOS, and Windows. The file you download depends on your system.

=== Where to download

The download page at #link("https://inkycap.org/download")[inkycap.org/download] offers the current release for each platform. Releases are also listed on the project's releases page at #link("https://codefloe.com/InkyCap/app/releases")[codefloe.com/InkyCap/app/releases].

#callout("note")[The project moved from Codeberg to CodeFloe in September 2026. The old Codeberg repository is archived and read-only; it still holds every release up to version 26.9.4, but newer releases appear only on CodeFloe. ]

=== Linux

On Linux you'll have a choice of package formats:

- A *.deb* package, for Debian- and Ubuntu-based systems, installed through your usual package tools.
- An *.rpm* package, for Fedora- and openSUSE-based systems.
- A *Flatpak* bundle, which runs on most distributions. You install the downloaded `.flatpak` file directly (it isn't on Flathub); it then appears in your application menu.

All three work through your system's package tools and follow your desktop's native appearance. InkyCap can tell you when a new version is available but you must download and install it yourself.

#callout("note", title: "For Typst users")[The `.deb` package installs InkyCap's bundled language server under the name `inkycap-tinymist`, so it never collides with a Tinymist you may have installed separately. The Flatpak is built on the GNOME 50 runtime. ]

=== macOS

On macOS you'll download a `.dmg` disk image, open it, and drag InkyCap into your Applications folder, as you would with most Mac software. There are separate builds for Apple silicon Macs and Intel Macs, so pick the one that matches your computer.

#callout("important")[
InkyCap's macOS builds are not signed or notarized by Apple. The first time you open InkyCap, macOS will warn that it comes from an "unidentified developer." This is expected. To open it anyway, right-click (or Control-click) the app in your Applications folder and choose *Open*; you only need to do this once. Only do this for software you trust and downloaded from inkycap.org.
]

=== Windows

On Windows you can choose between a `-setup.exe` installer, which walks you through the on-screen steps, and an `.msi` package, which suits organizations that install software centrally. Either way, once installed, InkyCap behaves like other Windows applications. It does not update itself; see below for how updates work.

== Opening InkyCap for the first time

After installing, launch InkyCap the way you launch any other app (from your applications menu, Launchpad, or Start menu). The first thing you'll want to do is point it at a folder for your notes (your "notebox").

For a guided walk-through of that first session (creating a notebox, writing your first note, and finding your way around), head straight to #wikilink("4 - Quick Start"). If you'd like to understand the notebox concept in more depth first, see #wikilink("3 - Setting Up Your Notebox").

== How updates work

InkyCap can tell you when a new version is available but it does not install anything itself. You must download and install new versions yourself. InkyCap is built to respect your privacy: *InkyCap does not contact the network unless you ask it to*.

You'll find everything related to updates in #wikilink("2 - Settings"), under the *Overview* and *Behaviour* areas.

=== Checking manually

1. Open #wikilink("2 - Settings") and go to the *Overview* area.
2. Find the *Software updates* section and click *Check for updates*.
3. InkyCap reaches out once to see whether a newer version exists, then reports back.

If you're current, you'll see "You're running the latest version."

=== When a new version is available

If something newer exists, InkyCap reports "Version X is available to download." and offers three buttons:

- *Download* opens the download page at inkycap.org in your browser.
- *View releases* opens the releases page on CodeFloe, where you can read what changed.
- *Check again* repeats the check.

#callout("note")[
The check reads a file from inkycap.org that lists the latest version number. It does not send any information about you, your computer, or your notebox.
]

=== Checking automatically at startup

If you'd like InkyCap to look for updates on its own, you can turn that on:

1. Open #wikilink("2 - Settings") and go to the *Behaviour* area.
2. Under *Software updates*, enable *Check for updates on startup*.

This option is *off by default*. With it on, InkyCap checks once shortly after launch and shows a small message if something newer is available. There's also an *Include development (beta) releases* option (also off by default) if you want to hear about pre-release builds.

== Knowing which version you're running

To see your current version, open #wikilink("2 - Settings") and look at the *Overview* area, where the version number is displayed. InkyCap's version numbers have three parts, `year.month.release` (for example 26.9.10 is the tenth release of September 2026). The last number tells you what kind of build you have: even numbers are stable releases and odd numbers are development builds. If you happen to be running a development build, you'll also see a small *Development build* badge beside the version so you always know whether you're on a stable or pre-release copy.

== Getting help

The *Overview* area of #wikilink("2 - Settings") also includes a *Help* section with a link to InkyCap's documentation. That's a good place to return to whenever you want to learn more about a feature.

You can reach the same manual from anywhere in the app: press *F1* (or click the *Help* button on the vertical toolbar) to open the Help panel, which has an *InkyCap Documentation* button and a *Typst Documentation* button at the top. The panel itself lists every keyboard shortcut and a cheat-sheet of Typst markup; see #wikilink("1 - The InkyCap Interface") for a tour of it.

== Related pages

- #wikilink("4 - Quick Start")
- #wikilink("3 - Setting Up Your Notebox")
- #wikilink("2 - Settings")
- #wikilink("1 - Getting Started")
- #wikilink("1 - The InkyCap Interface")
