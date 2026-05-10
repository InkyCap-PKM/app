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
// apply-vault-defaults / apply-collection-style: document-level styling hooks.
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
//   #show: apply-vault-defaults.with(text-font: "Inter", text-size: 12pt)
//   #show: apply-collection-style.with(page: (paper: "us-letter"))
//
// Both rules wrap the rest of the document; later show/set rules in the
// document body still win via Typst's normal cascade.
// ---------------------------------------------------------------------------

// `body` is the positional parameter `show:` invokes the function with —
// it must live directly on the function (not behind a nested `body => ...`
// closure) so that `apply-vault-defaults.with(...)` returns a function that
// still accepts the document body positionally.
#let apply-vault-defaults(
  text-font: none,
  text-size: none,
  page-paper: none,
  monospace-font: none,
  body,
) = {
  if text-font != none { set text(font: text-font) }
  if text-size != none { set text(size: text-size) }
  if page-paper != none { set page(paper: page-paper) }
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
// Rust calls this when the vault has an auto-detected bibliography file and
// the document doesn't declare one of its own. Keeping the call here (rather
// than emitting `#bibliography(...)` from Rust) means Typst-specific concerns
// like style coercion or per-vault default titles can evolve without
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
  let list_fields = ("tags", "status", "collection", "aliases")
  let data = (:)
  for (k, v) in args.named() {
    let coerced = if k in list_fields {
      if type(v) == array { v }
      else if type(v) == str and v != "" { (v,) }
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
  fill: rgb("#fff066"),
  radius: 0pt,
  extent: 0pt,
  ..rest,
) = context {
  if target() == "html" {
    let parts = ("background-color: " + fill.to-hex() + ";",)
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
