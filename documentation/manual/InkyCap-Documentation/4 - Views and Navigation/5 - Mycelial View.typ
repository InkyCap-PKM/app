#import "/.inkycap/notebox.typ": *

#note(
  title: "Mycelial View",
  description: "Mycelial View is an interactive map of your notebox that surfaces latent links and emergent concepts, revealing where your knowledge wants to grow next.",
  tags: ("documentation",),
)

= Mycelial View

The *Mycelial View* is an interactive map of your notebox that helps you discover where your thinking might want to grow next. #highlight[Its statistical suggestions sharpen as your notebox grows], though several of its signals are useful from the first handful of notes. Although it takes advantage of wikilinks, it is _*not*_ a view of how your notes link together (it is not a typical knowledge graph view). Mycelial View reads the writing around a note and quietly surfaces several kinds of opportunity:

- *Latent links* are pages you already have, that are mentioned by name elsewhere in your notes but not presently linked. The view points them out so you can connect them with a click.
- *Emergent concepts* are a word or phrase that tends to recur across your notes but has no page of its own yet. The view offers to create that page for you.
- *Kindred notes* are notes whose writing closely resembles your anchor note, yet with no chain of links between them; two circles of thought that never touch.
- The *Growth* panel adds two more: _under-developed pages_ (notes referenced often but barely written) and _open questions_ (question sentences you left in your writing).

Mycelial View is intended to help you answer _"Where Does Your Knowledge Want to Grow?"_

#callout("note")[
This is not a backlink browser. If you want to follow the links you have deliberately made, see #wikilink("4 - Links and Backlinks"). The Mycelial View is for finding the connections you _haven't_ made yet.
]

== Opening the view

The Mycelial View opens in its own tab, built around the note you start from (the *anchor note*). There are three ways in:

+ *From the editor toolbar* you can click the brain-circuit icon in the right-hand group of the editor header. Its tooltip reads "Mycelial View anchored from this note".
+ *From the command palette* you can run *Open Mycelial View* (under the Tools category), or press `Ctrl+Shift+Y` while a note is open.
+ *From a wikilink* you can right-click any wikilink in your text and choose *Open in Mycelial View tab*. This anchors the new view on the link's _target_ rather than your current note.

The tab is named after the anchor note. You can read more about where these tabs and panels live in #wikilink("1 - The InkyCap Interface").

#callout("important")[
The statistical analysis needs something to work with, so it scales with your notebox. *Latent links work from your very first notes* (they are simple name matching). *Emergent concepts* switch on at *10 notes*, run in a tentative "early growth" mode until about *50 notes* (the view shows a small notice), and reach full strength beyond that. Keep writing, and it will keep sharpening especially as you reach thousands of notes.
]

== Reading the graph

The graph displays nodes (boxes) joined by paths (lines). The *legend* along the bottom names the five kinds of node, each with its own colour:

- *Anchor note* is the note your view is built around. Everything else is found in relation to it.
- *Latent link* (amber, dashed) is an existing page mentioned in your writing without a link. The node shows the page name and a snippet of where it was mentioned, along with a label like "mentioned in 3 notes".
- *Emergent concept* (brown) is a recurring term with no page yet. Its node is labelled "Potential page" and shows where the term keeps appearing, with a label like "emerged from 4 notes".
- *Kindred note* (teal, dashed) is a note very similar to your anchor with no chain of links between them. Its node lists the distinctive vocabulary the two notes share, which is often a writing prompt in itself.
- *Source note* (grey) is an existing note that contributed one of these signals, shown so you can see where a suggestion came from. A small sprout icon on a note marks an under-developed page (see the Growth panel below).

The lines between nodes are *paths*. They mean that two nodes share a connection. Ordinary wikilinks appear as faint grey lines; latent and emergent connections get their own amber and brown styling. *Hover over any box* to spotlight just its paths and dim everything else, which makes a single thread easy to trace.

#callout("tip")[
Don't worry about the colours and weights at first. The simplest way to use the view is to look for the amber and brown boxes (those are the suggestions) and ignore the rest until something catches your eye.
]

=== Where the supporting detail lives

To keep the map readable, the graph deliberately stays sparse. Extra detail (counts, snippets, the notes that surfaced a signal) lives in the *side panel* rather than cluttering the canvas. The graph stays a clean overview, and the panel holds the reading material.

== Acting on what you find

The view isn't just for looking. Every suggestion is a one-click action:

- *Click a source note or a kindred note* to re-centre the whole view around it. A *Back* arrow appears in the toolbar so you can retrace your steps.
- *Click a latent link* to open a small picker listing every place the term was mentioned. Choosing one opens that note at the exact spot, ready for you to wrap the mention in a link.
- *Click an emergent concept* to create a page for it. Short terms become a new note straight away; longer phrases first let you trim the title. The new note arrives pre-filled with a heading and an "Emerged from" list of links back to the notes the idea came from.
- *Right-click any note* in the graph (the anchor, a source note, a kindred note, or a latent link's page) and choose *Open in new tab* to read its content in the editor instead; useful when you want to see for yourself what makes a kindred note kindred before recentring on it.

#callout("note")[
A term only counts as an emergent concept if it shows up in *at least two* notes. A word used just once is only a word, not yet an idea for the Mycelial View.
]

== Moving around

The toolbar and on-screen controls let you explore comfortably:

- *Depth* is a dropdown (1, 2, or 3; default 2) that sets how far out from the anchor the view looks for related material. Higher numbers cast a wider net.
- *Recompute* is the circular-arrow button that rebuilds the view from your current notebox contents.
- *Pan and zoom* lets you drag the canvas, use the arrow keys or the on-screen pad, scroll to zoom, or press the `+` and `−` buttons. *Fit to view* re-centres everything and runs automatically when the view opens.
- *Legend as filter* lets you click any legend item to hide or show that kind of box, so you can focus on, say, only emergent concepts. Clicking *Anchor note* instead spotlights your anchor. It pulses if it's on screen, or glows toward the edge if it has scrolled out of view.
- *Info* is the ⓘ icon that opens a "What am I looking at?" help panel explaining the boxes, paths, and controls. Press Escape or click away to dismiss it.

== The side panel: Linked Context, Growth, and Concept Filtering

When a Mycelial View is focused, the right panel offers three tabs.

=== Linked Context

These are the notes you have already linked to your anchor that did not raise a new signal (kept out of the graph on purpose, but listed here so you don't lose sight of them). You can filter the list, sort it *By connections* or *By name*, and expand any row to see what it links to. Hovering a context note highlights its connections in the graph, and vice versa.

=== Growth

The Growth tab (sprout icon) collects two signals that would clutter the graph but reward a look:

- *Under-developed pages* are notes in this neighbourhood that many other notes reference, yet which contain very little writing; a hub everyone points at with nothing there. Click one to open it, ready to expand. These same notes carry a small sprout icon in the graph.
- *Open questions* are literal question sentences found in your writing around the anchor. They are often the truest record of what you meant to figure out. Click one to jump to the exact spot in the note.

=== Concept Filtering

Concept detection works by ignoring extremely common words (a *stopword* list) so the view surfaces real ideas rather than filler. The Concept Filtering panel makes that filtering visible and reversible:

- *Excluded terms* are words that recur like a concept but were held back as stopwords. Each is tagged "your list" or "built-in". You can *Rescue* a built-in word (so it's treated as meaningful and also trusted by the spellchecker) or *Remove* one you added yourself.
- *Stopwords* lets you add your own word to ignore using the "Word to ignore…" box, or open the full list to edit it directly. You can also add a stopword straight from the graph by right-clicking an emergent concept.

After any change, the view refreshes so you see the effect right away.

#callout("warning")[
If you edit the stopword or dictionary files outside InkyCap, your changes take effect the *next time the Mycelial View loads*. There's no live file-watching. Just recompute, or reopen the view, to pick them up.
]

#callout("tip", title: "Technical details")[
The analysis is corpus-linguistic, not a simple link walk. The backend BFS-walks the wikilink graph to the chosen depth, then widens the neighbourhood with the most semantically similar notes (cosine similarity over per-document TF-IDF vectors). Term scoring blends normalized PMI over word pairs, average TF-IDF, and an _anchor-weighted_ presence ratio (notes closer to your anchor count for more, which is why different anchors give genuinely different suggestions), with boosts for multi-word phrases; a final diversity pass spreads the suggestions across the neighbourhood instead of letting one dense cluster supply them all. Existing page names are resolved from each note's file stem, its `title` property, and its aliases, which is how the engine tells a _latent link_ (page exists) apart from an _emergent concept_ (no page yet). Per-notebox tuning lives in two plain-text files under `.inkycap/`: `mycelial-stopwords.txt` for exclusions and `dictionary.txt` for rescued/force-included terms.
]

== What is the benefit of Mycelial View?

Most note-taking apps only show you connections that you made on purpose. The Mycelial View instead reads what you've already written and points out the threads you might have missed: a half-remembered idea that keeps resurfacing, two notes circling the same topic without ever touching, a concept ready to become a page. It's one of the best ways to turn a pile of notes into a growing web of ideas, alongside #wikilink("5 - Tags") and #wikilink("4 - Links and Backlinks").

== Related pages

- #wikilink("4 - Links and Backlinks")
- #wikilink("5 - Tags")
- #wikilink("1 - The InkyCap Interface")
