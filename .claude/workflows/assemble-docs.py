#!/usr/bin/env python3
"""Assemble the InkyCap user-manual notebox from the workflow output.

- Writes each generated content page into its section folder.
- Authors the six section hub landing pages + the root home page.
Run once; idempotent (overwrites).
"""
import json, os, re, shutil

TASK = "/tmp/claude-1000/-home-jchalif-Code-Projects-InkyCap/26e8271f-68ba-4554-9854-10beb8b88a53/tasks/wo7g0bk3q.output"
ROOT = "/home/jchalif/.config/inkycap/InkyCap-Documentation"

d = json.load(open(TASK))
pages = {p["file"]: p for p in d["result"]}

# section folder -> ordered list of child content-page names
SECTIONS = [
    ("Getting Started", "Getting Started", [
        "Quick Start", "Installing InkyCap", "Setting Up Your Notebox"]),
    ("The InkyCap Interface", "The InkyCap Interface", [
        "The InkyCap Interface", "Settings", "Keyboard Shortcuts"]),
    ("Writing and Editing", "Writing and Editing", [
        "Editing Notes", "Formatting Your Writing", "Links and Backlinks",
        "Tags", "Note Properties", "Citations and Bibliography"]),
    ("Views and Navigation", "Views and Navigation", [
        "Journal Scroll", "Mycelial View", "Agenda, Tasks, and Dates"]),
    ("Collections and Publishing", "Collections and Publishing", [
        "Collections", "Exporting and Publishing"]),
    ("Collaboration", "Collaboration", ["Collaboration"]),
    ("Importing and Extending", "Importing and Extending", [
        "Importing Existing Notes", "Scaffolds, Templates, and Packages",
        "Extensions"]),
]

# pages that the workflow generated AND that double as their section's hub
GENERATED_HUBS = {"The InkyCap Interface", "Collaboration"}
# hubs we author here
AUTHORED_HUBS = {"Getting Started", "Writing and Editing", "Views and Navigation",
                 "Collections and Publishing", "Importing and Extending"}

def tstr(s: str) -> str:
    """Escape a Python string for a Typst double-quoted string literal."""
    return s.replace("\\", "\\\\").replace('"', '\\"')

def note_file(title: str, description: str, body: str) -> str:
    return (
        '#import "/.inkycap/notebox.typ": *\n\n'
        '#note(\n'
        f'  title: "{tstr(title)}",\n'
        f'  description: "{tstr(description)}",\n'
        '  tags: ("documentation",),\n'
        ')\n\n'
        f'= {title}\n\n'
        f'{body.strip()}\n'
    )

def summary_of(name: str) -> str:
    return pages[name]["summary"].strip()

# ---- write content pages into their folders --------------------------------
def folder_for(name: str):
    for folder, hub, children in SECTIONS:
        if name in children:
            return folder
    raise KeyError(name)

written = []
for folder, hub, children in SECTIONS:
    fdir = os.path.join(ROOT, folder)
    os.makedirs(fdir, exist_ok=True)

for name, p in pages.items():
    folder = folder_for(name)
    path = os.path.join(ROOT, folder, f"{name}.typ")
    with open(path, "w") as fh:
        fh.write(note_file(name, summary_of(name), p["body"]))
    written.append(path)

# ---- author the five hub landing pages -------------------------------------
def child_list(children):
    lines = []
    for c in children:
        lines.append(f'- #wikilink("{c}") — {summary_of(c)}')
    return "\n".join(lines)

HUB_INTRO = {
 "Getting Started":
  ("Everything you need to go from a fresh install to a working, connected "
   "notebox. Start here if InkyCap is new to you.\n\n"
   "InkyCap is a personal-knowledge editor built on #link(\"https://typst.app\")[Typst]: "
   "you write in plain, portable text files, link them together, and turn them into "
   "polished PDFs or web pages. These pages get you set up and writing.\n\n"
   "== In this section\n\n{children}\n\n"
   "#callout(\"tip\")[ Read them in order the first time. Once you've made a notebox and "
   "your first link, the rest of the manual can be browsed in any order by following "
   "the #wikilink(\"Links and Backlinks\") between pages. ]"),
 "Writing and Editing":
  ("The heart of InkyCap: writing notes, formatting them, linking them, and "
   "describing them with properties. This is where you'll spend most of your time.\n\n"
   "InkyCap keeps your text as plain Typst the whole time — the visual editor is a "
   "friendly layer over that source, never a separate format. These pages cover how "
   "to write comfortably and how to build the web of links that makes a notebox more "
   "than a folder of files.\n\n"
   "== In this section\n\n{children}\n\n"
   "#callout(\"note\")[ New to the editor? Begin with #wikilink(\"Editing Notes\"), then "
   "#wikilink(\"Formatting Your Writing\"). #wikilink(\"Links and Backlinks\") is the one "
   "concept that most changes how you work. ]"),
 "Views and Navigation":
  ("Beyond the single-note editor, InkyCap offers special views for seeing your "
   "knowledge from different angles — by time, by connection, and by task.\n\n"
   "Each of these is a different lens on the same notes. Use them to write a daily "
   "log, to discover unexpected relationships, or to keep track of what needs doing.\n\n"
   "== In this section\n\n{children}"),
 "Collections and Publishing":
  ("Turn your notes into structured databases and into finished, professional "
   "outputs — spreadsheets, PDFs, books, and interactive web pages.\n\n"
   "Collections let you query and tabulate your notes like a database; the publishing "
   "tools take one note or a whole collection and produce something you can hand in, "
   "submit, or put on the web.\n\n"
   "== In this section\n\n{children}\n\n"
   "#callout(\"tip\", title: \"For Typst users\")[ Because every note is Typst, your exports "
   "inherit Typst's typesetting quality — real PDF/A and PDF/UA, genuine HTML, and full "
   "control through set and show rules and #wikilink(\"Scaffolds, Templates, and Packages\"). ]"),
 "Importing and Extending":
  ("Bring existing notes into InkyCap, customize how new notes are made, and reach "
   "out to the wider Typst ecosystem.\n\n"
   "Whether you're arriving from Markdown or Obsidian, setting up reusable starting "
   "points, or adding experimental extensions, these pages help you shape InkyCap "
   "around the way you work.\n\n"
   "== In this section\n\n{children}"),
}

for hub, intro in HUB_INTRO.items():
    folder, _, children = next(s for s in SECTIONS if s[1] == hub)
    body = intro.replace("{children}", child_list([c for c in children if c != hub]))
    desc = f"Section overview: {hub.lower()} in InkyCap."
    path = os.path.join(ROOT, folder, f"{hub}.typ")
    with open(path, "w") as fh:
        fh.write(note_file(hub, desc, body))
    written.append(path)

# ---- author the root home page ---------------------------------------------
HOME_BLURB = {
 "Getting Started": "Install InkyCap, create your first notebox, write a note, and make your first link.",
 "The InkyCap Interface": "A guided tour of the window — toolbar, sidebars, tabs, command palette, and settings.",
 "Writing and Editing": "Writing, formatting, linking, tagging, properties, and citations — the everyday core.",
 "Views and Navigation": "See your notes by time (Journal Scroll), by connection (Mycelial View), and by task (Agenda).",
 "Collections and Publishing": "Treat notes as a database, and export them as spreadsheets, PDFs, books, and web pages.",
 "Collaboration": "Share a notebox with others through git sync or an offline package exchange.",
 "Importing and Extending": "Import from Markdown and Obsidian, set up scaffolds and templates, and add extensions.",
}

home_body_parts = [
 ("Welcome to InkyCap — a personal knowledge-management editor for writers, "
  "researchers, and academics. You write in #link(\"https://typst.app\")[Typst]'s "
  "light, readable markup; InkyCap links your notes together, keeps your metadata "
  "queryable, and turns your work into beautifully typeset PDFs, books, and web pages.\n\n"
  "This manual is itself an InkyCap notebox, so every page you read is also a working "
  "example of the markup, wikilinks, and callouts it describes.\n"),
 "== Where to begin\n\n"
 "If you're new, head straight to #wikilink(\"Quick Start\") — it takes you from a fresh "
 "install to a linked note in a few minutes. Otherwise, pick a section below.\n",
 "== The manual\n",
]
for _, hub, _ in SECTIONS:
    home_body_parts.append(f'=== #wikilink("{hub}")\n\n{HOME_BLURB[hub]}')
home_body_parts.append(
 "#callout(\"tip\")[ Every blue word is a #wikilink(\"Links and Backlinks\", display: \"wikilink\"). "
 "Click one to jump to that page; each page also lists what links to it, so you can "
 "wander the manual the same way you'll wander your own notebox. ]")

home_body = "\n\n".join(home_body_parts)
with open(os.path.join(ROOT, "index.typ"), "w") as fh:
    fh.write(note_file("InkyCap Documentation",
                       "The InkyCap user manual — home page and table of contents.",
                       home_body))
written.append(os.path.join(ROOT, "index.typ"))

print(f"Wrote {len(written)} files:")
for w in sorted(written):
    print("  ", w.replace(ROOT + "/", ""))
