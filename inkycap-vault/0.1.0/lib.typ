// inkycap-vault 0.1.0 — Typst package for InkyCap notes.
//
// Public API:
//   #note(...)            document-level metadata
//   #tag("name")          inline tag
//   #wikilink("Name", display: ...)
//   link-ref("Name")      link reference value (use inside note() fields)
//   #embed("Name")        transclude another note (emits link)
//   #callout("type")[...] styled admonition block
//   #verse(body, ...)     whitespace-preserving free-form text with inline
//                         markup (eval'd per line)
//   #set-vault(...)       per-document rendering toggles + verse-font
//
// Three queryable labels:
//   <inkycap-note>  — at most one per file, attached to a metadata dict
//   <inkycap-tag>   — one per #tag(...) call, dict (name:)
//   <inkycap-link>  — one per outgoing link (body wikilinks + link-refs in metadata)

// ---------------------------------------------------------------------------
// State for per-document rendering toggles.
// ---------------------------------------------------------------------------

// Capture the built-in `label` function before any function in this module
// can shadow it via a parameter of the same name (notably `wikilink(...,
// label: ...)`). Inside such a function body, `label` refers to the
// parameter, not the built-in, so we route built-in calls through this
// alias instead.
#let _make-label = label

#let _show-inline-tags = state("inkycap-show-inline-tags", true)
#let _show-inline-wikilinks = state("inkycap-show-inline-wikilinks", true)
// Verse font override. When set (via `set-vault(verse-font: "...")`), all
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

#let set-vault(
  show-inline-tags: none,
  show-inline-wikilinks: none,
  verse-font: none,
) = {
  if show-inline-tags != none {
    assert(type(show-inline-tags) == bool, message: "set-vault: show-inline-tags must be bool")
    _show-inline-tags.update(show-inline-tags)
  }
  if show-inline-wikilinks != none {
    assert(type(show-inline-wikilinks) == bool, message: "set-vault: show-inline-wikilinks must be bool")
    _show-inline-wikilinks.update(show-inline-wikilinks)
  }
  if verse-font != none {
    assert(type(verse-font) == str, message: "set-vault: verse-font must be a string")
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
// note: document-level metadata. Strict typing on known fields; user-defined
// fields pass through unchanged.
// ---------------------------------------------------------------------------

#let note(
  title: none,
  aliases: (),
  description: none,
  tags: (),
  date: none,
  task: none,
  status: (),
  source: none,
  zid: none,
  collection: (),
  ..rest,
) = {
  // Coerce known fields to expected types. A string passed for list-typed
  // fields is wrapped in an array; mistyped date is stored as-is (the
  // property editor and query pipeline handle both gracefully). This avoids
  // compile failures that would blank the entire property panel.
  let _title = title
  let _date = date
  let _tags = if type(tags) == array { tags } else if type(tags) == str and tags != "" { (tags,) } else if type(tags) == str { () } else { () }
  let _status = if type(status) == array { status } else if type(status) == str and status != "" { (status,) } else if type(status) == str { () } else { () }
  let _source = source
  let _collection = if type(collection) == array { collection } else if type(collection) == str and collection != "" { (collection,) } else if type(collection) == str { () } else { () }
  let _description = description
  let _task = task
  let _aliases = if type(aliases) == array { aliases } else if type(aliases) == str and aliases != "" { (aliases,) } else if type(aliases) == str { () } else { () }
  let _zid = zid

  let data = (:)
  if _title != none { data.insert("title", _title) }
  if _date != none {
    if type(_date) == datetime {
      data.insert("date", _date.display("[year]-[month]-[day]"))
    } else {
      data.insert("date", _date)
    }
  }
  if _tags != () { data.insert("tags", _tags) }
  if _status != () { data.insert("status", _status) }
  if _source != none { data.insert("source", _source) }
  if _collection != () { data.insert("collection", _collection) }
  if _description != none { data.insert("description", _description) }
  if _task != none { data.insert("task", _task) }
  if _aliases != () { data.insert("aliases", _aliases) }
  if _zid != none { data.insert("zid", _zid) }
  for (k, v) in rest.named() {
    if type(v) == datetime {
      data.insert(k, v.display("[year]-[month]-[day]"))
    } else {
      data.insert(k, v)
    }
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
      link(dest)[#text(fill: rgb("#3b82f6"), shown)]
    } else if display != none {
      [#display]
    }
  }
}

// ---------------------------------------------------------------------------
// embed: transclude another note. Emits <inkycap-link> so the link graph
// captures the relationship. Renders a boxed placeholder in compiled output;
// the visual editor (Phase 3+) replaces this with a live transcluded card.
// ---------------------------------------------------------------------------

#let embed(name) = {
  assert(type(name) == str, message: "embed: name must be a string")
  [#metadata((target: name, from: "body")) <inkycap-link>]
  block(
    width: 100%,
    inset: 8pt,
    stroke: 0.5pt + luma(80%),
    radius: 3pt,
    text(fill: luma(40%), size: 0.9em, sym.arrow.r.hook + " " + name),
  )
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

#let callout(kind, title: none, body) = {
  assert(type(kind) == str, message: "callout: kind must be a string")
  let color = _callout-colors.at(kind, default: rgb("#448aff"))
  let heading-text = if title != none { title } else { upper(kind.first()) + kind.slice(1) }

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
//   font:       explicit font family (string). Overrides set-vault's
//               verse-font. When `none`, falls back to the verse-font
//               state, then to document body font.
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
    // Resolve font: explicit arg > set-vault state > inherit (none →
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
