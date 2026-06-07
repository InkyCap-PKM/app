#import "/.inkycap/notebox.typ": *

#note(
  title: "Installing InkyCap",
  description: "How to download, install, and update InkyCap on Linux, macOS, and Windows, including the privacy-first built-in update checker.",
  tags: ("documentation",),
)

= Installing InkyCap

InkyCap is a desktop application, installed on your own computer, not a website you log into. Everything you write stays on your machine by default (unless you explicitly share it outside).

== Installing on your platform

InkyCap aims to run on Linux, MacOS, and Windows. The file you download depends on your system. 

=== Linux

On Linux you'll have a choice of package formats:

- An *AppImage* (a single self-contained file you can run directly, and the format that supports automatic updates).
- A *.deb* package, for Debian- and Ubuntu-based systems, installed through your usual package tools.
- A *.rpm* package, for Fedora- and openSUSE-based systems.

The AppImage is the simplest if you want updates handled inside the app. The `.deb` and `.rpm` packages work through your system's package manager and follow your desktop's native appearance but for the time-being you will need to download and install those updates manually.


=== MacOS

On MacOS you'll download the app bundle and drag it into your Applications folder, as you would with most Mac software.

#callout("important")[
  Early macOS builds are not yet signed or notarized by Apple. The first time you open InkyCap, macOS may warn that it comes from an "unidentified developer." This is expected for now. You can still open the app by following your system's prompts to allow it (typically through the Privacy & Security settings), but only do this for software you trust and downloaded from inkycap.org.
]

=== Windows

On Windows you'll run a standard setup installer and follow the on-screen steps. Once installed, InkyCap behaves like other Windows applications and can update itself upon request.

== Opening InkyCap for the first time

After installing, launch InkyCap the way you launch any other app (from your applications menu, Launchpad, or Start menu). The first thing you'll want to do is point it at a folder for your notes (your "notebox").

For a guided walk-through of that first session (creating a notebox, writing your first note, and finding your way around), head straight to #wikilink("4 - Quick Start"). If you'd like to understand the notebox concept in more depth first, see #wikilink("3 - Setting Up Your Notebox").

== How updates work

InkyCap can tell you when a newer version is available, and on supported platforms it can install the update for you. It is built to respect your privacy: *InkyCap never contacts the network unless you ask it to*.

You'll find everything related to updates in #wikilink("2 - Settings"), under the *Overview* and *Behaviour* areas.

=== Checking manually

1. Open #wikilink("2 - Settings") and go to the *Overview* area.
2. Find the *Software updates* section and click *Check for updates*.
3. InkyCap reaches out once to see whether a newer version exists, then reports back.

If you're current, you'll see "You're running the latest version." If a new version is available, the next step depends on how you installed InkyCap.

=== Automatic versus manual installs

- On *Windows*, *macOS*, and the *Linux AppImage*, InkyCap can download and install a stable update in place. You'll see a *Download & install* button, a progress indicator while it downloads, and then "Update installed. Restart to finish." with a *Restart now* button.
- On *Linux .deb / .rpm* (and similar package-managed installs), InkyCap only *tells* you that a newer version exists and offers a *View releases* button to open the downloads page. Updating itself is left to your system's package manager. The app never replaces itself behind your back.

#callout("note")[
  Development (beta) releases are always installed by hand, even on platforms that otherwise update automatically. If you opt into betas, InkyCap will point you to the releases page rather than installing one for you.
]

=== Checking automatically at startup

If you'd like InkyCap to look for updates on its own, you can turn that on:

1. Open #wikilink("2 - Settings") and go to the *Behaviour* area.
2. Under *Software updates*, enable *Check for updates on startup*.

This option is *off by default*. With it on, InkyCap checks once shortly after launch and shows a small message if something newer is available. There's also an *Include development (beta) releases* option (also off by default) if you want to hear about pre-release builds.

#callout("important")[
  No update check ever happens silently. A check runs only when you click the button or when you've explicitly opted in to checking at startup. There is no telemetry and no background phoning-home.
]

== Knowing which version you're running

To see your current version, open #wikilink("2 - Settings") and look at the *Overview* area, where the version number is displayed. InkyCap's version numbers follow a `year-month.release.patch` pattern. If you happen to be running a development build, you'll see a small *Development build* badge beside the version so you always know whether you're on a stable or pre-release copy.

== Getting help

The *Overview* area of #wikilink("2 - Settings") also includes a *Help* section with a link to InkyCap's documentation. That's a good place to return to whenever you want to learn more about a feature.

== Related pages

- #wikilink("4 - Quick Start")
- #wikilink("3 - Setting Up Your Notebox")
- #wikilink("2 - Settings")
- #wikilink("1 - Getting Started")
- #wikilink("1 - The InkyCap Interface")
