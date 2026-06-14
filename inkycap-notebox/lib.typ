// inkycap-notebox — Typst package for InkyCap notes.
// Version is tracked solely by `notebox_package::VERSION` in the Rust backend
// (a migration/diagnostics marker); it is deliberately not duplicated here.
//
// Public API:
//   #note(...)            document-level metadata
//   #tag("name")          inline tag
//   #task("body", ...)    inline checkbox task (emits <inkycap-agenda>)
//   #due(date, label: ..., recurrence: ...) inline dated reminder
//                         (emits <inkycap-agenda>; recurrence is an optional
//                         repeat rule, see _fmt-recurrence)
//   #wikilink("Name", display: ...)
//   link-ref("Name")      link reference value (use inside note() fields)
//   #callout("type")[...] styled admonition block
//   #annotation(body, ...)  margin comment on note content (reader/reviewer)
//   #suggestion(body, kind: ..., ...)  inline tracked-change suggestion
//                         (insert/delete/replace) — the suggesting-mode mark
//   #verse(body, ...)     whitespace-preserving free-form text with inline
//                         markup (eval'd per line)
//   #set-notebox(...)       per-document rendering toggles + verse-font
//   #contributors-byline(roster)  title-page byline grouped by role
//   #credit-statement(roster)     CRediT contributions statement (book export)
//
// Six queryable labels:
//   <inkycap-note>   — at most one per file, attached to a metadata dict
//   <inkycap-tag>    — one per #tag(...) call, dict (name:)
//   <inkycap-link>   — one per outgoing link (body wikilinks + link-refs in metadata)
//   <inkycap-agenda> — one per #task(...)/#due(...) call, dict
//                      (kind, body, due, done, tags, recurrence)
//   <inkycap-annotation> — one per #annotation(...) call, dict (by, on)
//   <inkycap-suggestion> — one per #suggestion(...) call, dict
//                      (kind, by, on)

// ---------------------------------------------------------------------------
// apply-notebox-defaults / apply-collection-style: document-level styling hooks.
//
// The Rust side emits one or two `#show:` calls right after the package
// import to apply app-level defaults and per-collection overrides. Using
// `show: fn.with(...)` lets the function's `set` rules apply to the rest of
// the document (a plain function call would scope the rules to the function
// body and have no effect on the caller).
//
// Each parameter is `none` when the host hasn't configured that setting; the
// function emits a `set` rule only for the parameters that are present, so a
// default-free call is a true no-op.
//
// Usage (emitted by Rust):
//
//   #show: apply-notebox-defaults.with(text-font: "Inter", text-size: 12pt)
//   #show: apply-collection-style.with(page: (paper: "us-letter"))
//
// Both rules wrap the rest of the document; later show/set rules in the
// document body still win via Typst's normal cascade.
// ---------------------------------------------------------------------------

// `body` is the positional parameter `show:` invokes the function with —
// it must live directly on the function (not behind a nested `body => ...`
// closure) so that `apply-notebox-defaults.with(...)` returns a function that
// still accepts the document body positionally.
//
// NOTE: `set page(...)` inside a show-rule wrapper is a no-op for
// document-level layout. The Rust side emits `#set page(...)` as a
// separate direct rule; `page-paper` here is kept for direct-call use.
#let apply-notebox-defaults(
  text-font: none,
  text-size: none,
  page-paper: none,
  monospace-font: none,
  body,
) = {
  if text-font != none { set text(font: text-font) }
  if text-size != none { set text(size: text-size) }
  if page-paper != none { set page(paper: page-paper) }
  // Keep the same bullet at every nesting depth. Typst's default
  // `list.marker` is the cycling tuple `([•], [‣], [–])`, so deeper items
  // switch glyph each level; a single-content marker applies `•` uniformly.
  set list(marker: [•])
  if monospace-font != none {
    show raw: set text(font: monospace-font)
    body
  } else {
    body
  }
}

// Collection-level style overrides. Each section is an optional dict whose
// keys mirror the corresponding Typst function arguments — the function
// forwards them via spread (`set page(..page)`) so any field Typst's own
// function accepts is accepted here without enumerating them.
//
// Parameter names are deliberately distinct from the Typst built-in
// element names (`page`, `text`, `heading`, `par`) so spreading the
// captured dict into `set page(..)` etc. doesn't trip over a shadowed
// identifier inside the function body.
//
// `none` for a section skips it entirely; `(:)` (empty dict) is also a no-op.
#let apply-collection-style(
  page-args: none,
  text-args: none,
  par-args: none,
  heading-args: none,
  body,
) = {
  if page-args != none and page-args.len() > 0 {
    set page(..page-args)
  }
  if text-args != none and text-args.len() > 0 {
    set text(..text-args)
  }
  if par-args != none and par-args.len() > 0 {
    set par(..par-args)
  }
  if heading-args != none and heading-args.len() > 0 {
    set heading(..heading-args)
  }
  body
}

// ---------------------------------------------------------------------------
// apply-bibliography: thin wrapper around Typst's `#bibliography(...)`.
//
// Rust calls this when the notebox has an auto-detected bibliography file and
// the document doesn't declare one of its own. Keeping the call here (rather
// than emitting `#bibliography(...)` from Rust) means Typst-specific concerns
// like style coercion or per-notebox default titles can evolve without
// touching the Rust side.
// ---------------------------------------------------------------------------

#let apply-bibliography(path, ..opts) = bibliography(path, ..opts)

// ---------------------------------------------------------------------------
// make-offset-numbering: page-numbering closure that hides numbers on early
// pages and starts arabic counting once the document reaches `start-page`.
//
// Used by the merged-book exporter for the "no numbers until page N, then
// 1, 2, 3…" preset. The closure shape `(..n) => str | none` matches what
// `#set page(numbering: ...)` accepts.
//
// Usage (emitted by Rust):
//
//   #set page(numbering: make-offset-numbering(5))
//
// Page 5 of the PDF prints "1", page 6 prints "2", etc. Pages before
// `start-page` print no number at all.
// ---------------------------------------------------------------------------

#let make-offset-numbering(start-page) = (..n) => {
  let p = here().page()
  if p >= start-page { str(p - start-page + 1) } else { none }
}

// ---------------------------------------------------------------------------
// outline-with-bare-page-numbers: render an outline whose entries always
// show plain integer page numbers regardless of the body's page-numbering
// pattern.
//
// Typst's default `outline.entry` formats each entry's page label using
// the active page-numbering pattern. When the merged book uses a decorated
// body pattern (e.g. "Page 1 of N", "-- 1 --"), that decoration leaks into
// the TOC. This helper scopes a `show outline.entry` rule to a single
// `outline(...)` call so the entries stay readable as a TOC.
//
// Used by the merged-book exporter:
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

// Capture the built-in `label` function before any function in this module
// can shadow it via a parameter of the same name (notably `wikilink(...,
// label: ...)`). Inside such a function body, `label` refers to the
// parameter, not the built-in, so we route built-in calls through this
// alias instead.
#let _make-label = label

// Invisible, labeled anchor at a chapter's start, for in-book wikilink
// resolution in the merged-book export. Built via the `label()` function
// (`_make-label`) rather than `<...>` markup-label syntax so a chapter stem
// containing spaces, parens, or other characters illegal in literal labels
// still yields a valid, resolvable anchor — matching the
// `_make-label("chap-" + name)` the merged-mode `wikilink` links to. The
// Rust book wrapper emits `#chapter-anchor("<stem>")` at each chapter top.
#let chapter-anchor(stem) = [#metadata(none)#_make-label("chap-" + stem)]

#let _show-inline-tags = state("inkycap-show-inline-tags", true)
#let _show-inline-wikilinks = state("inkycap-show-inline-wikilinks", true)
// Verse font override. When set (via `set-notebox(verse-font: "...")`), all
// verse() calls without an explicit `font:` argument render in this font.
// `none` means inherit the document body font.
#let _verse-font-state = state("inkycap-verse-font", none)

// Merged-book compile context. When `active` is true, `wikilink` resolves
// targets internally to per-chapter labels (`<chap-stem>`) instead of
// emitting cross-file links. Set by the synthetic wrapper that the
// "Export as book" action generates; never set by hand.
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
  if verse-font != none {
    assert(type(verse-font) == str, message: "set-notebox: verse-font must be a string")
    _verse-font-state.update(verse-font)
  }
}

// ---------------------------------------------------------------------------
// link-ref: a value (not content) usable inside note(..) fields. The shape
// `(kind: "link-ref", target: name)` is the wire format — the scanner pattern-
// matches on `kind` to recognize a link reference inside metadata.
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
// _fmt-date: normalize a date argument to a stable `[year]-[month]-[day]`
// string. Accepts a `datetime` (the native, recommended form) or a string
// (tolerated when hand-authored). Returns `none` for `none`.
//
// Defined here, above `note()`, because `note()` calls `_fmt-recurrence`
// (below) which calls this — Typst `#let` has no forward references, so a
// helper must precede every function that uses it.
// ---------------------------------------------------------------------------

#let _fmt-date(v) = {
  if v == none { none }
  else if type(v) == datetime { v.display("[year]-[month]-[day]") }
  else if type(v) == str { v }
  else { str(v) }
}

// ---------------------------------------------------------------------------
// _fmt-recurrence: normalize a recurrence rule to a stable, queryable dict for
// the `<inkycap-agenda>` / `<inkycap-note>` metadata. A recurrence says how a
// dated reminder repeats; InkyCap expands occurrences against the current date
// at view time (the note source is never rewritten), so this only stores the
// *rule*, never materialized occurrences.
//
// The rule is a plain Typst dict so any Typst tool can read or build it:
//   (freq: "day"|"week"|"month"|"year",   // required; anything else → no rule
//    interval: 1,                         // optional int ≥ 1, default 1
//    by-day: ("mo","we"),                 // optional; weekly only (WKST = Mon)
//    until: datetime | "YYYY-MM-DD",      // optional inclusive end
//    count: 5)                            // optional occurrence cap
//
// Returns `none` for a missing or unrecognized rule (the item just doesn't
// recur), so a malformed value degrades gracefully instead of breaking the
// `typst query` that reads the dict back out.
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
  // Only explicitly-passed keys are emitted. This is intentional: the
  // properties panel adds rows by writing the field with an empty default
  // (e.g. `tags: ()`), and the panel reflects what's in the source. If we
  // dropped empty-equals-default values here, those rows would vanish from
  // the panel after every reindex.
  //
  // Known list-typed fields are coerced from a bare string to a 1-element
  // array so a user typing `tags: "draft"` still works. Datetime values are
  // stringified for stable downstream consumption.
  // `list_fields`: bare-string → 1-element array coercion (e.g. typing
  //   `tags: "draft"` becomes `("draft",)`).
  // `comma_list_fields`: subset that *also* splits commas — for fields
  //   where users author free-form strings and the comma is the natural
  //   separator (currently just `aliases`). Tag-style fields are kept
  //   off this list so tag values containing commas aren't silently
  //   shredded.
  let list_fields = ("tags", "collection", "aliases")
  let comma_list_fields = ("aliases",)
  let data = (:)
  for (k, v) in args.named() {
    let coerced = if k == "recurrence" {
      // Document-level recurrence on `#note(due: …, recurrence: (…))`.
      // Normalize to the same queryable dict `#due` emits so the host reads
      // both surfaces through one path. `none` (invalid/empty) still emits the
      // key — InkyCap reads it back as "no recurrence" and the panel hides it.
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
// task: an inline checkbox item. Always emits <inkycap-agenda> (kind "task")
// so the Agenda pane can aggregate it; always renders (a task is real
// content, unlike a tag). `due` accepts a datetime or string; `done` toggles
// the checkbox glyph and strikethrough.
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
// due: an inline dated reminder, attachable next to prose. Always emits
// <inkycap-agenda> (kind "date"); renders a small date badge. `label` is the
// text the Agenda pane shows for this item (the surrounding prose is not
// captured); without it the Agenda falls back to the note title.
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
      // In HTML target, emit an explicit `<a>` with `class` and
      // `data-target` so the Journal Scroll view (and any future HTML
      // surface) can intercept clicks and route them — Typst's built-in
      // `link()` produces an `<a href>` but no way to attach our class
      // or carry the raw wikilink name through. The paged/SVG path keeps
      // the standard `link()` so PDF export keeps its native behaviour.
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
// video / audio: embed a media file. Native Typst has no audio/video element,
// so these are inkycap-notebox extensions (CLAUDE.md Typst-first, tier 2). In
// HTML export we emit a real <video>/<audio controls> element via html.elem;
// in paged output (PDF/SVG), which cannot play media, we render an honest
// placeholder naming the file. The visual editor replaces both with a live
// player. Paths are notebox-root-absolute (e.g. "/Assets/clip.mp4"), like
// #image — the surfaces that load the media (visual editor, HTML reading view)
// resolve them to the real file.
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
// html-align: typst-html (0.14) has no show rule for `align()`, so an aligned
// block — most visibly a centred or right-aligned #image — is dropped entirely
// from the HTML output (only its surrounding paragraph survives). Re-emit it as
// a <div> carrying the matching CSS `text-align` so it renders in the reading
// view and HTML export. Installed as `#show align: html-align` only on the HTML
// compile path (see `inject_html_align_shim` in style_injection.rs); paged
// output (PDF/SVG) keeps native `align()` and is untouched.
// ---------------------------------------------------------------------------

#let html-align(it) = {
  // Reduce the (possibly 2-D) alignment to its horizontal component — the only
  // part with a CSS `text-align` analogue. `align()` from the editor is
  // horizontal-only; a hand-authored `center + horizon` keeps just `center`.
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

#let _callout-colors = (
  note: rgb("#448aff"),
  tip: rgb("#00bfa5"),
  warning: rgb("#ff9100"),
  important: rgb("#ff5252"),
  caution: rgb("#ff6d00"),
  example: rgb("#7c4dff"),
  quote: rgb("#9e9e9e"),
  abstract: rgb("#00b0ff"),
  info: rgb("#448aff"),
  todo: rgb("#448aff"),
  success: rgb("#00c853"),
  question: rgb("#ff9100"),
  failure: rgb("#ff5252"),
  danger: rgb("#ff1744"),
  bug: rgb("#ff5252"),
)

// Localized heading labels per callout kind. The `kind` argument stays the
// stable English key (it selects the colour, the HTML class, and is the public
// `#callout("warning")` API); only the *rendered* heading is localized, chosen
// from the document language (`text.lang`) at render time. Add a language entry
// to extend coverage; any language not listed falls back to English, and any
// kind not listed falls back to a capitalized form of its key.
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

#let callout(kind, title: none, body) = {
  assert(type(kind) == str, message: "callout: kind must be a string")
  let color = _callout-colors.at(kind, default: rgb("#448aff"))

  // Typst's `typst-html` emitter drops `block(fill:/stroke:/inset:/radius:)`
  // box styling — it would emit only the title + body text with no admonition
  // box. So on the HTML target we emit a semantic `<div>` carrying the kind and
  // the resolved colour (as a CSS custom property) for a stylesheet to paint,
  // mirroring the `<mark>` treatment in `highlight`. The paged/SVG path keeps
  // the native `block` so PDF/reading-view output is unchanged.
  context {
    // Localize the heading from the document language now that we're in a
    // context where `text.lang` is known. An explicit `title:` always wins.
    let heading-text = if title != none { title } else { _callout-label(kind, text.lang) }
    if target() == "html" {
      html.elem(
        "div",
        attrs: (
          class: "inkycap-callout inkycap-callout--" + kind,
          style: "--inkycap-callout-color: " + color.to-hex() + ";",
        ),
        (
          html.elem("div", attrs: (class: "inkycap-callout__title"), heading-text),
          html.elem("div", attrs: (class: "inkycap-callout__body"), body),
        ).join(),
      )
    } else {
      block(
        width: 100%,
        inset: (left: 12pt, rest: 8pt),
        stroke: (left: 3pt + color),
        fill: color.lighten(92%),
        radius: (right: 3pt),
        [
          #text(fill: color, weight: "bold", size: 0.95em, heading-text) \
          #body
        ],
      )
    }
  }
}

// ---------------------------------------------------------------------------
// annotation.
//
// `#annotation[comment]` marks a reader's or collaborator's remark on note
// content — a tinted block that stays visible in the reading view but reads as
// a distinct margin note, not body text. (Distinct from the *collaboration
// change-review* workflow: that reviews a collaborator's incoming edits as a
// whole-file diff; an annotation is a comment that lives in the note.)
//
// Emits queryable metadata (`<inkycap-annotation>`). `by` is a collaborator
// handle or display name; `on` accepts a datetime or a date string (normalized
// via `_fmt-date`). `none` for either omits it from the rendered attribution.
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
    if target() == "html" {
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
// suggestion: an inline tracked-change mark — the InkyCap "suggesting mode"
// primitive. A collaborator proposes a change *inline* (rather than as a
// whole-file diff): `kind` is "insert" (proposed new text), "delete" (existing
// text proposed for removal), or "replace" (old → new).
//
// IN COMPILED OUTPUT (reading view, PDF, HTML) this renders the *resulting*
// text — the change as if accepted — with no tracked-change styling: insert and
// replace show the new `body`; delete shows nothing. The CriticMarkup /
// Track-Changes face (green-underlined insertions, red-struck deletions, the
// inline reviewer `note`) is an editorial convenience that belongs only in the
// visual editor, where it is drawn by a CodeMirror decoration, not by this
// function. A rendered document therefore reads as the proposed result, never
// as marked-up intent. (Accept semantics mirror `typst_pipeline::suggestion`:
// insert/replace → new `body`, delete → nothing.)
//
// Storage is Typst-native: the source-of-truth stays a `.typ` that compiles
// anywhere. Accepting/rejecting a suggestion is a source transform (host-side
// `suggestion_rewriter`) that *unwraps* the call to clean Typst, so a published
// document never carries suggestion marks even in source. The invisible
// `#metadata` mark (`<inkycap-suggestion>`, dict kind/by/on/note) is still
// emitted so `typst query` and the Suggestions/Annotations panel can find every
// open suggestion; `by`/`on` attribute the author and `note` is a reviewer
// comment, surfaced in the editor but kept out of rendered output.
//
// `body` (positional) is the inserted/new text; `old` (named content) is the
// replaced text for kind == "replace" — it carries in the source for the
// host-side reject transform but is not rendered (an accepted replace keeps the
// new text, not the old).
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
// highlight: thin wrapper around Typst's built-in `highlight` that fixes
// the HTML output path. Typst's `typst-html` emitter renders `#highlight[…]`
// as a bare `<mark>` element with no inline style, so the user's chosen
// `fill` / `radius` is dropped and the browser default mark-yellow shows
// regardless. We branch on `target() == "html"` and emit `<mark>` with
// `background-color` / `border-radius` derived from the same arguments
// the built-in accepts. The paged path forwards untouched.
//
// `stroke` is intentionally not translated — the pill UI only sets fill,
// and `stroke` accepts compound forms (length, color, dict) that don't
// have a clean single-property CSS analogue. Authors who set a stroke in
// source still get correct paged output; the HTML view shows fill only.
// ---------------------------------------------------------------------------

// Capture the built-in before the let binding below shadows it for the
// rest of the package.
#let _std-highlight = highlight

// `..rest` forwards any extra named args (e.g. parameters added in
// future Typst versions) to the built-in on the paged path without
// requiring this wrapper to track Typst's full signature.
#let highlight(
  body,
  fill: rgb("#f2ed61"),
  radius: 0pt,
  extent: 0pt,
  ..rest,
) = context {
  if target() == "html" {
    // Pin near-black text on the mark. The highlighter palette is
    // fixed-light in both themes, so without an explicit colour the
    // reading view's dark-mode light foreground inherits onto the light
    // fill and the highlighted text becomes unreadable. This mirrors the
    // `color: #1a1a1a` the visual editor pins on highlighted spans
    // (visual-colors.ts / visual-theme.ts).
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
// verse: whitespace-preserving free-form text (poetry, lyrics, structured
// blocks where layout matters). First-class element — not a code-block
// derivative.
//
// Body is a string. Each line is whitespace-preserved (every ASCII space
// becomes a non-breaking space) and then evaluated as Typst markup, so
// inline formatting works naturally:
//
//   *bold*        _italic_         #strike[x]
//   #highlight[x] #underline[x]    #link("…")[…]
//
// Backslash escapes any markup metacharacter for literal display:
//   \*, \_, \#, \[, \\, etc.
//
// Arguments:
//   font:       explicit font family (string). Overrides set-notebox's
//               verse-font. When `none`, falls back to the verse-font
//               state, then to document body font.
//   weight:     text weight (integer 100–900 or named string like "bold").
//               When `none`, inherits the document/verse-font default.
//   align-to:   left | center | right (alignment values, not strings).
//   numbered:   show line numbers.
//   numbering-pattern: pattern for numbered lines (default "1").
//   leading:    line spacing within the verse.
//   tracking:   letter-spacing (length, e.g. 0.05em).
//   lang:       language code for shaping/hyphenation (e.g. "fr", "ar").
//   dir:        text direction (auto | ltr | rtl).
// ---------------------------------------------------------------------------

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
    // Resolve font: explicit arg > set-notebox state > inherit (none →
    // omit the font argument entirely so the document default applies).
    // `text(font: auto)` is a type error in Typst — font must be string,
    // dict, or array, never `auto` — so the argument has to be omitted
    // rather than defaulted.
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

    // HTML target uses a different rendering path. Typst's HTML
    // backend doesn't reliably translate the paged-target constructs
    // we use for paged output (`align()` blocks, `linebreak()` joining
    // a content sequence, `grid()` for numbered rows) — they either
    // get dropped or cause surrounding output to be cut off. Emit a
    // flat `<div>` with `white-space: pre-wrap` and explicit `<br>`
    // separators instead; that maps cleanly to HTML.
    if target() == "html" {
      let css-align = if align-to == center { "center" }
        else if align-to == right { "right" }
        else { "left" }

      let pieces = ()
      let lines = body.split("\n")
      let n = 0
      for line in lines {
        n = n + 1
        let preserved = line.replace(" ", "\u{00A0}")
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
      // ── Paged target (PDF, SVG, PNG) ──
      // Build the rendered body as a single piece of content, then
      // wrap it with an explicit `text(..text-args, body)` call so
      // the verse font wins against any outer `#set text(font: ...)`
      // rule (e.g., the document text font). `set text` inside
      // `context { ... }` doesn't reliably override an outer set;
      // explicit wrapping does.
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
          let preserved = line.replace(" ", "\u{00A0}")
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
          // NBSP every ASCII space — Typst preserves these verbatim,
          // so idiosyncratic indentation and run-spacing survive
          // layout.
          let preserved = line.replace(" ", "\u{00A0}")
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

      // Wrap the rendered body in an explicit `text(..text-args, body)`
      // call so the verse font wins against any outer document-level
      // `#set text(font: ...)` rule (e.g., the style cascade injected
      // by `inject_style_cascade`). A `set text` rule placed inside a
      // `context { ... }` scope does not reliably override an outer
      // set rule for content already constructed via `eval(..., mode:
      // "markup")` — the eval'd content carries set-rule snapshots
      // that bypass the inner scope. Explicit `text(...)` wrapping
      // does override.
      _align(align-to, text(..text-args, rendered))
    }
  }
}

// ---------------------------------------------------------------------------
// contributors-byline / credit-statement: title-page byline + CRediT
// contributions statement for the merged book export.
//
// The Rust book wrapper emits the roster as an array of dicts:
//   (name: "Joshua Chalifour", role: "author", credit: ("Conceptualization", …))
// `role` is a CSL/Hayagriva bibliographic-role token; `credit` holds CRediT
// labels already resolved host-side. Formatting lives here (Typst-first) so
// the host only emits data + a single call.
// ---------------------------------------------------------------------------

// Byline phrasing per bibliographic role. Authors form the leading "by …";
// every other role gets its own prefixed line. Unknown roles fall back to a
// title-cased "<Role> by".
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
