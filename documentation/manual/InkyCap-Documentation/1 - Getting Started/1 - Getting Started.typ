#import "/.inkycap/notebox.typ": *

#note(
  title: "Getting Started",
  description: "Section overview: getting started in InkyCap.",
  tags: ("documentation",),
  aliases: ("Getting Started",),
)

= Getting Started

Start here if InkyCap is new to you, it will explain everything you need in order to go from a fresh install to a working, connected notebox. 

InkyCap is a personal-knowledge management application based on #link("https://typst.app")[Typst] markup: you write in plain, portable text files, link them together, and turn them into polished PDFs or web pages. 

== In this section

- #wikilink("2 - Installing InkyCap") shows how to download, install, and update InkyCap on Linux, MacOS, and Windows, including the built-in update checker.
- #wikilink("3 - Setting Up Your Notebox") explains how a notebox works (a portable folder of your .typ notes plus a hidden .inkycap configuration), the three ways to start one, and how to organize, open, and switch noteboxes.
- #wikilink("4 - Quick Start") gives you the fastest path from installing InkyCap to creating a notebox, writing your first note, and linking notes together with wikilinks.

#callout("tip", title: "For developers or advanced users")[
  InkyCap is built with Tauri (a Rust backend with a web-technology front end) and bundles the Tinymist language server, so you get Typst code autocomplete out of the box. No separate Typst or Tinymist install is required. Source code and release archives are hosted on Codeberg at `codeberg.org/InkyCap/app`.
]

