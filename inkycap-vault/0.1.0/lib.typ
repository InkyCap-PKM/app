// inkycap-vault 0.1.0 — Typst package for InkyCap notes.
//
// Public API:
//   #note(...)            document-level metadata
//   #tag("name")          inline tag
//   #wikilink("Name", display: ...)
//   link-ref("Name")      link reference value (use inside note() fields)
//   #embed("Name")        transclude another note (emits link)
//   #callout("type")[...] styled admonition block
//   #verse(body, ...)     whitespace-preserving free-form text
//   #set-vault(...)       per-document rendering toggles
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
) = {
  if show-inline-tags != none {
    assert(type(show-inline-tags) == bool, message: "set-vault: show-inline-tags must be bool")
    _show-inline-tags.update(show-inline-tags)
  }
  if show-inline-wikilinks != none {
    assert(type(show-inline-wikilinks) == bool, message: "set-vault: show-inline-wikilinks must be bool")
    _show-inline-wikilinks.update(show-inline-wikilinks)
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
// verse: whitespace-preserving free-form text (poetry, lyrics).
// Takes a string body; preserves leading/internal spaces and line breaks.
// ---------------------------------------------------------------------------

#let verse(
  body,
  font: none,
  numbered: false,
  center: false,
  leading: 0.65em,
) = {
  assert(type(body) == str, message: "verse: body must be a string")

  let lines = body.split("\n")
  let rendered = {
    set par(leading: leading)
    let n = 0
    for line in lines {
      n = n + 1
      // Convert leading/internal spaces to non-collapsing horizontal space.
      // Each ASCII space → \u{00A0} (non-breaking) so Typst keeps them.
      let preserved = line.replace(" ", "\u{00A0}")
      let row = if numbered {
        grid(
          columns: (2em, 1fr),
          align: (right + top, left + top),
          text(fill: luma(60%), size: 0.8em, str(n)),
          preserved,
        )
      } else {
        preserved
      }
      if center { align(center, row) } else { row }
      linebreak()
    }
  }

  if font != none {
    text(font: font, rendered)
  } else {
    rendered
  }
}
