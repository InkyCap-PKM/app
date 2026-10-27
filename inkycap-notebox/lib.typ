// inkycap-notebox — Typst package for InkyCap notes.
// Its version is tracked by `notebox_package::VERSION` in the Rust backend.
//
// Public API:
//   #note(...)            document-level metadata
//   #tag("name")          inline tag
//   #task("body", ...)    inline checkbox task (emits <inkycap-agenda>)
//   #due(date, label: ..., recurrence: ...) inline dated reminder
//                         (emits <inkycap-agenda>; see _fmt-recurrence)
//   #wikilink("Name", display: ...)
//   link-ref("Name")      link reference value (for note() fields)
//   #callout("type", title: "…", color: …)[...] styled admonition block
//   #annotation(body, ...)  margin comment on note content
//   #suggestion(body, kind: ..., ...)  inline tracked change
//                         (insert/delete/replace)
//   #verse(body, ...)     whitespace-preserving free-form text with inline
//                         markup
//   #set-notebox(...)     per-document rendering toggles and verse font
//   #contributors-byline(roster)  title-page byline grouped by role
//   #credit-statement(roster)     CRediT contributions statement
//
// Queryable labels:
//   <inkycap-note>       — at most one per file, the metadata dict
//   <inkycap-tag>        — one per #tag(...), dict (name:)
//   <inkycap-link>       — one per outgoing link (wikilinks and link-refs)
//   <inkycap-agenda>     — one per #task(...)/#due(...), dict
//                          (kind, body, due, done, tags, recurrence)
//   <inkycap-annotation> — one per #annotation(...), dict (by, on)
//   <inkycap-suggestion> — one per #suggestion(...), dict (kind, by, on)

// ---------------------------------------------------------------------------
// apply-notebox-defaults / apply-collection-style: document-level styling.
//
// Rust emits these as `#show:` rules right after the package import, so their
// `set` rules apply to the rest of the document:
//
//   #show: apply-notebox-defaults.with(text-font: "Inter", text-size: 12pt)
//   #show: apply-collection-style.with(page: (paper: "us-letter"))
//
// A `none` parameter emits no `set` rule. Later rules in the document still
// win through the normal cascade.
// ---------------------------------------------------------------------------

// `body` must be a direct parameter so that `.with(...)` still returns a
// function taking the document body.
//
// A `set` rule lasts only until the end of its block, so none may sit inside an
// `if` here. The helpers below turn `none` settings into empty argument lists
// instead, and each `set` rule sits directly in the function body.

// Named arguments whose value is not `none`, as a dictionary ready to spread.
#let _present(..args) = {
  let out = (:)
  for (key, value) in args.named() {
    if value != none { out.insert(key, value) }
  }
  out
}

// A section dictionary, or an empty one when the section is absent.
#let _or-empty(section) = if section == none { (:) } else { section }

#let apply-notebox-defaults(
  text-font: none,
  text-size: none,
  page-paper: none,
  monospace-font: none,
  body,
) = {
  set text(.._present(font: text-font, size: text-size))
  set page(.._present(paper: page-paper))
  // Use the same bullet at every depth; Typst's default cycles through `•`,
  // `‣`, `–`.
  set list(marker: [•])
  show raw: set text(.._present(font: monospace-font))
  body
}

// Collection style overrides. Each section is an optional dict of the matching
// Typst function's arguments, spread into it (`set page(..page)`). `none` or
// `(:)` skips a section.
//
// The parameter names differ from the built-in element names (`page`, `text`,
// …) so they don't shadow them.
#let apply-collection-style(
  page-args: none,
  text-args: none,
  par-args: none,
  heading-args: none,
  body,
) = {
  set page(.._or-empty(page-args))
  set text(.._or-empty(text-args))
  set par(.._or-empty(par-args))
  set heading(.._or-empty(heading-args))
  body
}

// ---------------------------------------------------------------------------
// apply-bibliography: wrapper around `#bibliography(...)`. Rust calls it when
// the notebox has a detected bibliography file and the document declares
// none.
// ---------------------------------------------------------------------------

#let apply-bibliography(path, ..opts) = bibliography(path, ..opts)

// ---------------------------------------------------------------------------
// make-offset-numbering: page numbering that shows no numbers before
// `start-page` and counts from 1 there. Used by the book export:
//
//   #set page(numbering: make-offset-numbering(5))
//
// Page 5 prints "1", page 6 "2", and so on.
// ---------------------------------------------------------------------------

#let make-offset-numbering(start-page) = (..n) => {
  let p = here().page()
  if p >= start-page { str(p - start-page + 1) } else { none }
}

// ---------------------------------------------------------------------------
// outline-with-bare-page-numbers: an outline whose entries show plain page
// numbers, so a decorated body pattern ("Page 1 of N") doesn't appear in the
// table of contents. Used by the book export:
//
//   #outline-with-bare-page-numbers(depth: 3)
// ---------------------------------------------------------------------------

#let outline-with-bare-page-numbers(depth: 3) = {
  show outline.entry: it => link(
    it.element.location(),
    it.indented(
      it.prefix(),
      it.body()
        + box(width: 1fr, repeat[.])
        + h(0.5em)
        + str(counter(page).at(it.element.location()).first()),
    ),
  )
  outline(depth: depth)
}

// ---------------------------------------------------------------------------
// State for per-document rendering toggles.
// ---------------------------------------------------------------------------

// The built-in `label`, saved before parameters named `label` (e.g. in
// `wikilink`) shadow it.
#let _make-label = label

// Invisible anchor at a chapter's start, for resolving wikilinks in the book
// export. Built with `label()` so any file stem gives a valid label. The book
// wrapper emits `#chapter-anchor("<stem>")` at each chapter.
#let chapter-anchor(stem) = [#metadata(none)#_make-label("chap-" + stem)]

// chapter-bibliography: a reference list for one chapter in the book export's
// per-chapter mode. It lists the citations between this chapter's anchor and
// the next one (`next-stem`, `none` for the last chapter), numbered separately
// per chapter.
#let chapter-bibliography(path, stem, next-stem: none, ..opts) = {
  let scope = selector(cite).after(_make-label("chap-" + stem))
  if next-stem != none {
    scope = scope.before(_make-label("chap-" + next-stem))
  }
  bibliography(path, target: scope, group: none, ..opts)
}

#let _show-inline-tags = state("inkycap-show-inline-tags", true)
#let _show-inline-wikilinks = state("inkycap-show-inline-wikilinks", true)
// Whether `annotation` draws its comment. On by default so exports and other
// Typst tools show annotations; InkyCap's reading view turns it off.
#let _show-annotations = state("inkycap-show-annotations", true)
// Verse font from `set-notebox(verse-font: "...")`, used by verses without a
// `font:` argument. `none` inherits the body font.
#let _verse-font-state = state("inkycap-verse-font", none)

// Book export context. When `active`, `wikilink` links to chapter labels
// (`<chap-stem>`) instead of other files. Set only by the generated book
// wrapper.
#let _merged-context = state("inkycap-merged-context", (
  active: false,
  mode: "external",
  chapters: (),
))

#let set-merged-context(active: false, mode: "external", chapters: ()) = {
  assert(type(active) == bool, message: "set-merged-context: active must be bool")
  assert(type(mode) == str, message: "set-merged-context: mode must be a string")
  assert(type(chapters) == array, message: "set-merged-context: chapters must be an array")
  _merged-context.update((active: active, mode: mode, chapters: chapters))
}

#let set-notebox(
  show-inline-tags: none,
  show-inline-wikilinks: none,
  show-annotations: none,
  verse-font: none,
) = {
  if show-inline-tags != none {
    assert(type(show-inline-tags) == bool, message: "set-notebox: show-inline-tags must be bool")
    _show-inline-tags.update(show-inline-tags)
  }
  if show-inline-wikilinks != none {
    assert(type(show-inline-wikilinks) == bool, message: "set-notebox: show-inline-wikilinks must be bool")
    _show-inline-wikilinks.update(show-inline-wikilinks)
  }
  if show-annotations != none {
    assert(type(show-annotations) == bool, message: "set-notebox: show-annotations must be bool")
    _show-annotations.update(show-annotations)
  }
  if verse-font != none {
    assert(type(verse-font) == str, message: "set-notebox: verse-font must be a string")
    _verse-font-state.update(verse-font)
  }
}

// ---------------------------------------------------------------------------
// link-ref: a value (not content) for use in note() fields. The scanner
// recognizes the shape `(kind: "link-ref", target: name)`.
// ---------------------------------------------------------------------------

#let link-ref(name) = {
  assert(type(name) == str, message: "link-ref: name must be a string")
  (
    kind: "link-ref",
    target: name,
  )
}

#let _is-link-ref(v) = {
  type(v) == dictionary and v.at("kind", default: none) == "link-ref"
}

// Walk a value, emit <inkycap-link> metadata for every link-ref found.
// Returns content (possibly empty).
#let _emit-links-from(v) = {
  if _is-link-ref(v) {
    [#metadata((target: v.target, from: "metadata")) <inkycap-link>]
  } else if type(v) == array {
    for item in v {
      _emit-links-from(item)
    }
  } else if type(v) == dictionary {
    for (_, item) in v {
      _emit-links-from(item)
    }
  }
}

// ---------------------------------------------------------------------------
// _fmt-date: normalize a date to a `[year]-[month]-[day]` string. Accepts a
// `datetime` (preferred) or a string; `none` stays `none`. Defined before
// note() because Typst has no forward references.
// ---------------------------------------------------------------------------

#let _fmt-date(v) = {
  if v == none { none }
  else if type(v) == datetime { v.display("[year]-[month]-[day]") }
  else if type(v) == str { v }
  else { str(v) }
}

// ---------------------------------------------------------------------------
// _fmt-recurrence: normalize a recurrence rule to a stable dict for the
// `<inkycap-agenda>` / `<inkycap-note>` metadata. Only the rule is stored;
// InkyCap works out occurrences when displaying.
//
//   (freq: "day"|"week"|"month"|"year",   // required; anything else → no rule
//    interval: 1,                         // optional int ≥ 1, default 1
//    by-day: ("mo","we"),                 // optional; weekly only (WKST = Mon)
//    until: datetime | "YYYY-MM-DD",      // optional inclusive end
//    count: 5)                            // optional occurrence cap
//
// Returns `none` for a missing or unrecognized rule, so a bad value doesn't
// break the query that reads it.
#let _recur-weekdays = ("mo", "tu", "we", "th", "fr", "sa", "su")

#let _fmt-recurrence(v) = {
  if v == none or type(v) != dictionary {
    none
  } else {
    let freq = lower(str(v.at("freq", default: "")))
    if freq not in ("day", "week", "month", "year") {
      none
    } else {
      let out = (freq: freq)
      let interval = v.at("interval", default: 1)
      out.insert(
        "interval",
        if type(interval) == int and interval >= 1 { interval } else { 1 },
      )
      let raw-days = v.at("by-day", default: ())
      let day-list = if type(raw-days) == str {
        (raw-days,)
      } else if type(raw-days) == array {
        raw-days
      } else {
        ()
      }
      let days = day-list
        .map(d => lower(str(d)))
        .filter(d => d in _recur-weekdays)
      if days.len() > 0 { out.insert("by-day", days) }
      let until-str = _fmt-date(v.at("until", default: none))
      if until-str != none { out.insert("until", until-str) }
      let count = v.at("count", default: none)
      if type(count) == int and count >= 1 { out.insert("count", count) }
      out
    }
  }
}

// ---------------------------------------------------------------------------
// note: document-level metadata. Strict typing on known fields; user-defined
// fields pass through unchanged.
// ---------------------------------------------------------------------------

#let note(..args) = {
  // Only keys passed explicitly are emitted, even empty ones: the properties
  // panel adds a row by writing an empty field (e.g. `tags: ()`) and shows what
  // is in the source.
  //
  // `list_fields`: a bare string becomes a 1-element array (`tags: "draft"` →
  // `("draft",)`). `comma_list_fields`: these also split on commas. Tag-style
  // fields aren't included, so tags containing commas stay whole.
  let list_fields = ("tags", "collection", "aliases")
  let comma_list_fields = ("aliases",)
  let data = (:)
  for (k, v) in args.named() {
    let coerced = if k == "recurrence" {
      // Normalize to the same dict `#due` emits. An invalid value still emits
      // the key, which InkyCap reads as no recurrence.
      _fmt-recurrence(v)
    } else if k in list_fields {
      if type(v) == array { v }
      else if type(v) == str and v != "" {
        if k in comma_list_fields {
          let parts = v.split(",").map(s => s.trim()).filter(s => s != "")
          if parts.len() > 0 { parts }
          else { (v,) }
        } else {
          (v,)
        }
      }
      else if type(v) == str { () }
      else { v }
    } else if type(v) == datetime {
      v.display("[year]-[month]-[day]")
    } else {
      v
    }
    data.insert(k, coerced)
  }

  // Emit the document-level metadata.
  [#metadata(data) <inkycap-note>]

  // Walk all values to surface link-refs as <inkycap-link>.
  _emit-links-from(data)
}

// ---------------------------------------------------------------------------
// tag: inline tag. Always emits <inkycap-tag>; renders only if state allows.
// ---------------------------------------------------------------------------

#let tag(name) = {
  assert(type(name) == str, message: "tag: name must be a string")
  [#metadata((name: name)) <inkycap-tag>]
  context {
    if _show-inline-tags.get() {
      box(
        fill: rgb("#eef2ff"),
        inset: (x: 4pt, y: 1pt),
        radius: 2pt,
        text(size: 0.85em, "#" + name),
      )
    }
  }
}

// ---------------------------------------------------------------------------
// task: an inline checkbox. Always emits <inkycap-agenda> (kind "task") and
// always renders. `due` takes a datetime or string; `done` checks the box and
// strikes through the text.
// ---------------------------------------------------------------------------

#let task(body, due: none, done: false, tags: ()) = {
  assert(type(body) == str, message: "task: body must be a string")
  assert(type(done) == bool, message: "task: done must be a boolean")
  let tag-list = if type(tags) == array { tags } else if type(tags) == str and tags != "" { (tags,) } else { () }
  [#metadata((
    kind: "task",
    body: body,
    due: _fmt-date(due),
    done: done,
    tags: tag-list,
  )) <inkycap-agenda>]
  let mark = if done { "\u{2611}" } else { "\u{2610}" }
  box[#mark #(if done { strike(body) } else { body })]
}

// ---------------------------------------------------------------------------
// due: an inline dated reminder. Always emits <inkycap-agenda> (kind "date")
// and renders a date badge. `label` is the text the Agenda shows; without it,
// the note title.
// ---------------------------------------------------------------------------

#let due(date, label: none, recurrence: none) = {
  let rec = _fmt-recurrence(recurrence)
  [#metadata((
    kind: "date",
    body: label,
    due: _fmt-date(date),
    done: false,
    tags: (),
    recurrence: rec,
  )) <inkycap-agenda>]
  box(
    fill: rgb("#eef2ff"),
    inset: (x: 4pt, y: 1pt),
    radius: 2pt,
    // A trailing ↻ marks a recurring reminder so the badge reads as repeating
    // even in compiled output, not just in the Agenda.
    text(size: 0.85em, _fmt-date(date) + (if rec != none { " \u{21BB}" } else { "" })),
  )
}

// ---------------------------------------------------------------------------
// wikilink: outgoing link to another note. Always emits <inkycap-link>;
// renders only if state allows. `display` overrides the visible text.
// ---------------------------------------------------------------------------

#let wikilink(name, display: none, label: none) = {
  assert(type(name) == str, message: "wikilink: name must be a string")
  if display != none {
    assert(type(display) == str, message: "wikilink: display must be a string")
  }
  if label != none {
    assert(type(label) == str, message: "wikilink: label must be a string")
  }
  let meta = (target: name, from: "body")
  if label != none { meta.insert("label", label) }
  [#metadata(meta) <inkycap-link>]
  context {
    let shown = if display == none { name } else { display }
    let merged = _merged-context.get()
    if merged.active {
      // Merged-book compile. The wrapper sets the active mode plus the list
      // of chapter stems present in the book; resolve accordingly.
      if merged.mode == "plain" {
        // Strip linking entirely.
        [#shown]
      } else if merged.mode == "internal" and name in merged.chapters {
        // In-book target: jump to the chapter's anchor label.
        if _show-inline-wikilinks.get() {
          link(_make-label("chap-" + name))[#text(fill: rgb("#3b82f6"), shown)]
        } else if display != none {
          [#display]
        }
      } else {
        // Out-of-book target (or external mode): fall back to the file link
        // exactly as a standalone compile would emit it.
        if _show-inline-wikilinks.get() {
          let dest = name + ".typ"
          if label != none { dest = dest + "#" + label }
          link(dest)[#text(fill: rgb("#3b82f6"), shown)]
        } else if display != none {
          [#display]
        }
      }
    } else if _show-inline-wikilinks.get() {
      let dest = name + ".typ"
      if label != none { dest = dest + "#" + label }
      // For HTML, emit an `<a>` with a class and `data-target` so the Journal
      // Scroll can intercept the click. Paged output keeps `link()`.
      if target() == "html" {
        html.elem(
          "a",
          attrs: (
            class: "inkycap-wikilink",
            href: dest,
            "data-target": name,
          ),
          text(fill: rgb("#3b82f6"), shown),
        )
      } else {
        link(dest)[#text(fill: rgb("#3b82f6"), shown)]
      }
    } else if display != none {
      [#display]
    }
  }
}

// ---------------------------------------------------------------------------
// video / audio: embed a media file. Typst has no media element, so HTML
// export emits <video>/<audio controls> and paged output shows a placeholder
// naming the file. Paths are notebox-root-absolute (e.g. "/Assets/clip.mp4"),
// like #image.
// ---------------------------------------------------------------------------

#let _media-placeholder(kind, path) = block(
  width: 100%,
  inset: 8pt,
  stroke: 0.5pt + luma(80%),
  radius: 3pt,
  text(fill: luma(40%), size: 0.9em, "\u{25B6} " + kind + ": " + path),
)

#let video(path, width: auto) = {
  assert(type(path) == str, message: "video: path must be a string")
  context {
    if target() == "html" {
      let attrs = (controls: "", src: path)
      if width != auto { attrs.insert("style", "width: " + repr(width)) }
      html.elem("video", attrs: attrs)
    } else {
      _media-placeholder("video", path)
    }
  }
}

#let audio(path) = {
  assert(type(path) == str, message: "audio: path must be a string")
  context {
    if target() == "html" {
      html.elem("audio", attrs: (controls: "", src: path))
    } else {
      _media-placeholder("audio", path)
    }
  }
}

// ---------------------------------------------------------------------------
// html-align: typst-html (as of 0.15) has no output for `align()`, so an
// aligned block such as a centred #image is dropped from HTML. This re-emits
// it as a <div> with CSS `text-align`. Installed as `#show align: html-align`
// on the HTML compile path only (see `inject_html_align_shim` in
// style_injection.rs). Re-test when Typst is upgraded: if `#align(center)[x]`
// compiled to HTML contains the text, this can go.
// ---------------------------------------------------------------------------

#let html-align(it) = {
  // Keep only the horizontal part, which is all CSS `text-align` can express.
  let a = it.alignment
  let h = if type(a) == alignment and a.x != auto { a.x } else { a }
  let css = if h == right { "right" } else if h == center { "center" } else if h == start { "start" } else if h == end { "end" } else { "left" }
  html.elem("div", attrs: (style: "text-align: " + css), it.body)
}

// ---------------------------------------------------------------------------
// callout: styled admonition block. Type determines icon/color in visual mode.
// Supported types: note, tip, warning, important, caution, example, quote,
// abstract, info, todo, success, question, failure, danger, bug.
// ---------------------------------------------------------------------------

// Default colour per kind. The editor keeps a copy in
// src/editor/typst-decorations/callout-kinds.ts, and a test checks the two
// match.
#let _callout-colors = (
  note: rgb("#448aff"),
  tip: rgb("#00bfa5"),
  warning: rgb("#ff9100"),
  important: rgb("#ff5252"),
  caution: rgb("#ff6d00"),
  example: rgb("#7c4dff"),
  quote: rgb("#9e9e9e"),
  abstract: rgb("#00b0ff"),
  info: rgb("#2196f3"),
  todo: rgb("#ff6d00"),
  success: rgb("#00c853"),
  question: rgb("#64dd17"),
  failure: rgb("#ff1744"),
  danger: rgb("#d50000"),
  bug: rgb("#f50057"),
)

// Heading labels per kind and language. `kind` stays the English key (it picks
// the colour and HTML class); only the shown heading follows `text.lang`.
// Unlisted languages fall back to English, unlisted kinds to the capitalized
// key.
#let _callout-labels = (
  note: (en: "Note", fr: "Note"),
  tip: (en: "Tip", fr: "Astuce"),
  warning: (en: "Warning", fr: "Avertissement"),
  important: (en: "Important", fr: "Important"),
  caution: (en: "Caution", fr: "Mise en garde"),
  example: (en: "Example", fr: "Exemple"),
  quote: (en: "Quote", fr: "Citation"),
  abstract: (en: "Abstract", fr: "Résumé"),
  info: (en: "Info", fr: "Information"),
  todo: (en: "Todo", fr: "À faire"),
  success: (en: "Success", fr: "Succès"),
  question: (en: "Question", fr: "Question"),
  failure: (en: "Failure", fr: "Échec"),
  danger: (en: "Danger", fr: "Danger"),
  bug: (en: "Bug", fr: "Bogue"),
)

// Resolve the heading label for `kind` in language `lang` (a 2-letter code such
// as "en" or "fr", as returned by `text.lang`).
#let _callout-label(kind, lang) = {
  let entry = _callout-labels.at(kind, default: none)
  if entry == none {
    upper(kind.first()) + kind.slice(1)
  } else {
    entry.at(lang, default: entry.en)
  }
}

// `kind` sets the default colour and heading. `title:` and `color:` override
// them while the kind stays in the source.
#let callout(kind, title: none, color: none, body) = {
  assert(type(kind) == str, message: "callout: kind must be a string")
  let accent = if color != none { color } else {
    _callout-colors.at(kind, default: rgb("#448aff"))
  }

  // typst-html drops a block's fill, stroke and inset, so for HTML emit a
  // `<div>` with the kind and the colour as a CSS custom property, as
  // `highlight` does with `<mark>`. Paged output keeps `block`.
  context {
    // Localize the heading from the document language now that we're in a
    // context where `text.lang` is known. An explicit `title:` always wins.
    let heading-text = if title != none { title } else { _callout-label(kind, text.lang) }
    if target() == "html" {
      html.elem(
        "div",
        attrs: (
          class: "inkycap-callout inkycap-callout--" + kind,
          style: "--inkycap-callout-color: " + accent.to-hex() + ";",
        ),
        (
          html.elem("div", attrs: (class: "inkycap-callout__title"), heading-text),
          html.elem("div", attrs: (class: "inkycap-callout__body"), body),
        ).join(),
      )
    } else {
      // The frame is a corner bracket at the top-left and bottom-right: a
      // rectangle stroked on two sides, moved out to the box's edge by the
      // inset and back in by half the stroke weight. The bracket is 70%
      // transparent. Keep in step with `--callout-corner-strength` in
      // themes.css.
      let inset-x = 12pt
      let inset-y = 8pt
      let across = 5em
      let down = 2em
      let weight = 1.5pt
      let radius = 3pt
      let edge = weight + accent.transparentize(70%)
      block(
        width: 100%,
        inset: (x: inset-x, y: inset-y),
        fill: accent.lighten(92%),
        radius: radius,
        {
          place(top + left, dx: -inset-x + weight / 2, dy: -inset-y + weight / 2, rect(
            width: across, height: down,
            stroke: (top: edge, left: edge), radius: (top-left: radius),
          ))
          place(bottom + right, dx: inset-x - weight / 2, dy: inset-y - weight / 2, rect(
            width: across, height: down,
            stroke: (bottom: edge, right: edge), radius: (bottom-right: radius),
          ))
          text(fill: accent, weight: "bold", size: 0.95em, heading-text)
          linebreak()
          body
        },
      )
    }
  }
}

// ---------------------------------------------------------------------------
// annotation: a reader's or collaborator's remark on note content, shown as a
// tinted block. `set-notebox(show-annotations: false)` hides it and leaves
// only the metadata.
//
// Emits `<inkycap-annotation>`. `by` is a name or handle; `on` a datetime or
// date string. `none` leaves either out of the attribution.
// ---------------------------------------------------------------------------

#let _annotation-color = rgb("#8b5cf6")

// Join the present attribution parts ("by — on") with a separator, or "" when
// neither is given.
#let _attribution(by, on) = {
  let parts = ()
  if by != none { parts.push(by) }
  let d = _fmt-date(on)
  if d != none { parts.push(d) }
  parts.join(" · ")
}

#let annotation(body, by: none, on: none) = {
  [#metadata((by: by, on: _fmt-date(on))) <inkycap-annotation>]
  let attribution = _attribution(by, on)
  let heading = "Annotation" + (if attribution != "" { " — " + attribution } else { "" })
  // Same HTML-target treatment as `callout`: a styled `block` collapses to bare
  // text under `typst-html`, so emit a semantic `<div>` for the stylesheet.
  context {
    if not _show-annotations.get() {
      // Hidden: the metadata above still records the annotation.
    } else if target() == "html" {
      html.elem(
        "div",
        attrs: (
          class: "inkycap-annotation",
          style: "--inkycap-annotation-color: " + _annotation-color.to-hex() + ";",
        ),
        (
          html.elem("div", attrs: (class: "inkycap-annotation__title"), heading),
          html.elem("div", attrs: (class: "inkycap-annotation__body"), body),
        ).join(),
      )
    } else {
      block(
        width: 100%,
        inset: (left: 10pt, rest: 6pt),
        stroke: (left: 2pt + _annotation-color),
        fill: _annotation-color.lighten(94%),
        radius: (right: 3pt),
        [
          #text(fill: _annotation-color, weight: "bold", size: 0.8em, heading) \
          #body
        ],
      )
    }
  }
}

// ---------------------------------------------------------------------------
// suggestion: an inline tracked change. `kind` is "insert" (new text),
// "delete" (text proposed for removal) or "replace" (old → new).
//
// Compiled output shows the result as if accepted, without change styling:
// insert and replace show `body`, delete shows nothing. The tracked-change
// styling exists only in the visual editor.
//
// Accepting or rejecting unwraps the call to plain Typst (in the host's
// `suggestion_rewriter`). The `<inkycap-suggestion>` metadata (kind, by, on,
// note) lets `typst query` find open suggestions; `note` is a reviewer
// comment that isn't rendered.
//
// `body` is the new text; `old` is the replaced text for "replace", kept for
// rejecting but not rendered.
// ---------------------------------------------------------------------------

#let suggestion(body, kind: "insert", old: none, note: none, by: none, on: none) = {
  assert(
    kind in ("insert", "delete", "replace"),
    message: "suggestion: kind must be \"insert\", \"delete\", or \"replace\"",
  )
  // Queryable, invisible mark — keeps the suggestion discoverable without
  // putting any tracked-change styling in the rendered document.
  [#metadata((kind: kind, by: by, on: _fmt-date(on), note: note)) <inkycap-suggestion>]
  // Render the accepted result. A "delete" resolves to nothing, so it emits
  // only the (invisible) mark above; "insert"/"replace" emit the new text.
  if kind != "delete" {
    body
  }
}

// ---------------------------------------------------------------------------
// highlight: wrapper around the built-in `highlight`. typst-html emits a bare
// `<mark>`, losing `fill` and `radius`, so for HTML this emits `<mark>` with
// matching CSS. Paged output uses the built-in unchanged. `stroke` isn't
// translated to CSS.
// ---------------------------------------------------------------------------

// Capture the built-in before the let binding below shadows it for the
// rest of the package.
#let _std-highlight = highlight

// `..rest` passes any other named arguments to the built-in.
#let highlight(
  body,
  fill: rgb("#f2ed61"),
  radius: 0pt,
  extent: 0pt,
  ..rest,
) = context {
  if target() == "html" {
    // Fix the text colour to near-black: the highlight colours are light in
    // both themes, so dark mode's light text would be unreadable. Matches the
    // visual editor (visual-colors.ts / visual-theme.ts).
    let parts = (
      "background-color: " + fill.to-hex() + ";",
      "color: #1a1a1a;",
    )
    if radius != 0pt and radius != none {
      parts.push("border-radius: " + repr(radius) + ";")
    }
    if extent != 0pt {
      parts.push("padding: 0 " + repr(extent) + ";")
    }
    html.elem(
      "mark",
      attrs: (style: parts.join(" ")),
      body,
    )
  } else {
    _std-highlight(
      body,
      fill: fill,
      radius: radius,
      extent: extent,
      ..rest,
    )
  }
}

// ---------------------------------------------------------------------------
// verse: whitespace-preserving free-form text (poetry, lyrics, layouts where
// spacing matters).
//
// The body is a string. Each line keeps its spacing and is evaluated as Typst
// markup, so inline formatting works:
//
//   *bold*        _italic_         #strike[x]
//   #highlight[x] #underline[x]    #link("…")[…]
//
// A backslash shows a markup character literally: \*, \_, \#, \[, \\, etc.
//
// Arguments:
//   font:       font family. Defaults to set-notebox's verse-font, then the
//               body font.
//   weight:     text weight (100–900 or a name like "bold"). `none` inherits.
//   align-to:   left | center | right (alignment values, not strings).
//   numbered:   show line numbers.
//   numbering-pattern: pattern for numbered lines (default "1").
//   leading:    line spacing within the verse.
//   tracking:   letter spacing (length, e.g. 0.05em).
//   lang:       language for shaping and hyphenation (e.g. "fr", "ar").
//   dir:        text direction (auto | ltr | rtl).
// ---------------------------------------------------------------------------

// Keep a verse line's spacing while leaving it breakable:
//   * a leading run of spaces stays non-breaking, so indentation is never split;
//   * a trailing run stays non-breaking so it survives layout;
//   * an interior run of N spaces becomes N-1 non-breaking spaces and one
//     ordinary space: the same width, with one break opportunity per gap.
//
// Each tab first becomes four spaces (the editor's tab width), since markup
// would collapse it.
#let _verse-preserve-spaces(line) = {
  let nbsp = "\u{00A0}"
  let out = line.replace("\t", "    ")
  out = out.replace(regex("^ +"), m => nbsp * m.text.len())
  out = out.replace(regex(" +$"), m => nbsp * m.text.len())
  out.replace(regex(" +"), m => nbsp * (m.text.len() - 1) + " ")
}

#let verse(
  body,
  font: none,
  weight: none,
  align-to: left,
  numbered: false,
  numbering-pattern: "1",
  leading: 0.65em,
  tracking: none,
  lang: none,
  dir: auto,
) = {
  assert(type(body) == str, message: "verse: body must be a string")

  // Capture the built-in `align` function before any local shadowing.
  let _align = align

  context {
    // Font: explicit argument, then the set-notebox state, else omit the
    // argument so the document default applies (`font: auto` is a type error).
    let resolved-font = if font != none {
      font
    } else {
      _verse-font-state.get()
    }

    // Build text() arg dict so we only pass overrides the caller
    // actually specified. Omitted args inherit document defaults.
    let text-args = (:)
    if resolved-font != none { text-args.insert("font", resolved-font) }
    if weight != none { text-args.insert("weight", weight) }
    if tracking != none { text-args.insert("tracking", tracking) }
    if lang != none { text-args.insert("lang", lang) }
    if dir != auto { text-args.insert("dir", dir) }

    // HTML: typst-html drops or truncates the paged constructs used below
    // (`align()`, `linebreak()` sequences, `grid()`), so emit a `<div>` with
    // `white-space: pre-wrap` and `<br>` separators.
    if target() == "html" {
      let css-align = if align-to == center { "center" }
        else if align-to == right { "right" }
        else { "left" }

      let pieces = ()
      let lines = body.split("\n")
      let n = 0
      for line in lines {
        n = n + 1
        let preserved = _verse-preserve-spaces(line)
        let body-content = if preserved.len() == 0 {
          text("\u{00A0}")
        } else {
          eval(preserved, mode: "markup")
        }
        if numbered {
          pieces.push(html.elem(
            "span",
            attrs: (style: "display: inline-block; width: 2.5em; text-align: right; color: #999; margin-right: 0.5em;"),
            numbering(numbering-pattern, n),
          ))
        }
        pieces.push(body-content)
        if n < lines.len() {
          pieces.push(html.elem("br"))
        }
      }

      let style-parts = (
        "white-space: pre-wrap;",
        "text-align: " + css-align + ";",
        "line-height: 1.4;",
      )
      if resolved-font != none {
        style-parts.push("font-family: \"" + resolved-font + "\";")
      }
      html.elem(
        "div",
        attrs: (
          class: "inkycap-verse",
          style: style-parts.join(" "),
        ),
        pieces.join(),
      )
    } else {
      // ── Paged output (PDF, SVG, PNG) ──
      set par(leading: leading)
      let lines = body.split("\n")
      let total = lines.len()

      let rendered = if numbered {
        // Grid-per-line layout — each row is its own block; the grid
        // controls row spacing, not `par.leading`.
        let pieces = ()
        let n = 0
        for line in lines {
          n = n + 1
          let preserved = _verse-preserve-spaces(line)
          let body-content = if preserved.len() == 0 {
            text("\u{00A0}")
          } else {
            eval(preserved, mode: "markup")
          }
          pieces.push(grid(
            columns: (2.5em, 1fr),
            align: (right + top, left + top),
            text(fill: luma(60%), size: 0.85em, numbering(numbering-pattern, n)),
            body-content,
          ))
        }
        pieces.join()
      } else {
        // Single-block layout: lines joined by `linebreak()` so
        // vertical spacing follows `par.leading`, not `block.spacing`.
        let n = 0
        let acc = []
        for line in lines {
          n = n + 1
          // See _verse-preserve-spaces.
          let preserved = _verse-preserve-spaces(line)
          // Empty line → single NBSP keeps the linebreak meaningful
          // (otherwise the layout collapses adjacent breaks).
          let body-content = if preserved.len() == 0 {
            text("\u{00A0}")
          } else {
            eval(preserved, mode: "markup")
          }
          acc = acc + body-content
          if n < total { acc = acc + linebreak() }
        }
        acc
      }

      // Wrap in an explicit `text(...)` so the verse font overrides an outer
      // `#set text(font: ...)`; a `set text` inside `context` doesn't override
      // it for content built with `eval`.
      _align(align-to, text(..text-args, rendered))
    }
  }
}

// ---------------------------------------------------------------------------
// contributors-byline / credit-statement: title-page byline and CRediT
// contributions statement for the book export.
//
// The book wrapper passes the roster as an array of dicts:
//   (name: "Athena Otlet", role: "author", credit: ("Conceptualization", …))
// `role` is a CSL bibliographic-role token; `credit` holds resolved CRediT
// labels.
// ---------------------------------------------------------------------------

// Byline phrasing per role. Authors form the opening "by …"; other roles get
// their own line. Unknown roles become "<Role> by".
#let _byline-prefix = (
  editor: "Edited by",
  translator: "Translated by",
  "editor-translator": "Edited and translated by",
  compiler: "Compiled by",
  "series-editor": "Series editor",
  illustrator: "Illustrated by",
  narrator: "Narrated by",
  annotator: "Annotated by",
  foreword: "Foreword by",
  afterword: "Afterword by",
  holder: "©",
)

// Join names as "A", "A and B", or "A, B, and C".
#let _join-names(names) = {
  let n = names.len()
  if n == 0 { "" } else if n == 1 {
    names.at(0)
  } else if n == 2 {
    names.at(0) + " and " + names.at(1)
  } else {
    names.slice(0, n - 1).join(", ") + ", and " + names.at(n - 1)
  }
}

#let contributors-byline(contributors) = {
  // Group names by role, remembering the order roles first appear.
  let groups = (:)
  let order = ()
  for c in contributors {
    let role = c.at("role", default: "author")
    if role == "" { role = "author" }
    if role not in groups { order.push(role) }
    groups.insert(role, groups.at(role, default: ()) + (c.at("name"),))
  }

  let lines = ()
  if "author" in groups {
    lines.push("by " + _join-names(groups.at("author")))
  }
  for role in order {
    if role == "author" { continue }
    let prefix = _byline-prefix.at(
      role,
      default: upper(role.slice(0, 1)) + role.slice(1) + " by",
    )
    lines.push(prefix + " " + _join-names(groups.at(role)))
  }

  if lines.len() == 0 { return }
  align(center, {
    for (i, line) in lines.enumerate() {
      text(size: if i == 0 { 1.1em } else { 1em }, line)
      if i < lines.len() - 1 { linebreak() }
    }
  })
}

#let credit-statement(contributors, title: "Author contributions") = {
  let rows = contributors.filter(c => c.at("credit", default: ()).len() > 0)
  if rows.len() == 0 { return }
  block(width: 100%, {
    text(weight: "bold", title)
    v(0.4em)
    for c in rows {
      [*#c.at("name"):* #c.at("credit").join(", ").]
      linebreak()
    }
  })
}
