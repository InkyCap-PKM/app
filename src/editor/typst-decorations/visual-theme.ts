import { EditorView } from "@codemirror/view";

// Text inside a heading takes the heading colour, except link-type elements
// (wikilink, link, footnote), which keep their own. Heading marks are
// `inclusiveEnd`, so a heading ending in a wikilink contains its pill and
// brackets.
const HEADING_LINK_EXEMPT = [
  ".cm-typst-wikilink",
  ".cm-typst-link",
  ".cm-typst-footnote",
  ".cm-typst-wikilink-edit",
  ".cm-typst-wikilink-bracket",
  ".cm-typst-wikilink-sep",
];
const headingInnerNonLinkSelector = [1, 2, 3, 4, 5, 6]
  .map(
    (n) =>
      `.cm-typst-h${n} span${HEADING_LINK_EXEMPT.map((c) => `:not(${c})`).join("")}`,
  )
  .join(", ");

export const visualTheme = EditorView.theme({
  ".cm-scroller": { overflowAnchor: "none" },
  // ── Shared block geometry ──
  // Code blocks, block quotes and callouts have two states: a rendered widget
  // while the caret is elsewhere, and editable lines while it is inside. Both
  // must have exactly the same height, or entering and leaving the block moves
  // everything below it. Every vertical measurement they share is declared once
  // here and used by both sets of rules. Never restate one inline.
  ".cm-content": {
    // Height of one text row as a multiple of the font size (CodeMirror sets it
    // on `.cm-scroller`), as a variable so inline decorations can size
    // themselves to one row.
    "--editor-line-height": "1.4",
    // Pill text size relative to the surrounding text, used for the pill's font
    // size and to compute its height.
    "--pill-font-scale": "0.78",
    lineHeight: "var(--editor-line-height)",
    // Width of a list bullet or number. Wrapped lines hang-indent by the same
    // amount (see `pushListIndent` in visual-plugin); it also replaces the
    // marker's hidden trailing space.
    "--list-bullet-width": "1.5em",
    // CodeMirror's horizontal padding on each `.cm-line`. Edit-state lines use
    // their block's inset instead and carry this as a margin, so the block's
    // edges match the widget's.
    "--line-inset": "6px",
    "--line-inset-end": "2px",
    // Block quote: outer gap, inner padding, left text inset past the quotation
    // mark, right inset, mark size and line height. The mark is out of flow, so
    // only the inset adds width.
    "--quote-margin": "10px",
    "--quote-pad": "8px",
    "--quote-inset": "1.9em",
    "--quote-inset-end": "16px",
    "--quote-mark-size": "3.5em",
    "--quote-line-height": "1.6",
    // Callout.
    "--callout-margin": "10px",
    "--callout-pad": "8px",
    "--callout-inset": "12px",
    "--callout-body-size": "0.95em",
    "--callout-line-height": "1.5",
    // Code block: font size for the whole block; header and footer strips are
    // one `--codeblock-row` plus padding; the code area adds
    // `--codeblock-body-pad` above and below.
    "--codeblock-font-size": "0.9em",
    "--codeblock-margin": "10px",
    "--codeblock-row": "1.5em",
    "--codeblock-strip-pad": "2px",
    "--codeblock-inset": "10px",
    "--codeblock-body-pad": "8px",
  },
  // (No `.cm-cursor` rule: the editor uses the native caret, which already
  // follows each line's font height — including tall heading lines.)
  ".cm-gutters": {
    display: "none !important",
  },
  ".cm-typst-bold": { fontWeight: "bold" },
  ".cm-typst-italic": { fontStyle: "italic", color: "inherit" },
  ".cm-typst-strike": { textDecoration: "line-through", color: "var(--syntax-strike)" },
  ".cm-typst-highlight": {
    // A bare `#highlight[…]` is the default yellow (the palette writes no fill
    // for it), matching the package's `--hl-yellow`.
    backgroundColor: "var(--hl-yellow)",
    borderRadius: "var(--radius-xs)",
    padding: "0 2px",
    // Highlight colours are light in every theme, so pin near-black text for
    // contrast in dark mode.
    color: "#1a1a1a", // token-exempt: highlight pastels are light in every theme
  },
  // R12 marks for sub/super/underline/overline: visual representation
  // applied directly to the live Typst source so the body stays editable.
  ".cm-typst-underline-mark": {
    textDecoration: "underline",
    textUnderlineOffset: "2px",
  },
  ".cm-typst-overline-mark": {
    textDecoration: "overline",
  },
  ".cm-typst-sub": {
    fontSize: "0.75em",
    verticalAlign: "sub",
    lineHeight: "0",
  },
  ".cm-typst-sup": {
    fontSize: "0.75em",
    verticalAlign: "super",
    lineHeight: "0",
  },
  // Smart-quote widgets standing in for the hidden `#quote[` / `]` of an inline
  // quote. See QuoteGlyphWidget for why they are widgets rather than
  // pseudo-elements.
  ".cm-typst-quote-glyph": { color: "inherit" },
  ".cm-typst-raw-inline": {
    fontFamily: "var(--editor-font-mono, monospace)",
    // Monospace looks larger at the same size; 0.9em matches the other code
    // surfaces.
    fontSize: "0.9em",
    backgroundColor: "var(--syntax-mono-bg)",
    borderRadius: "var(--radius-sm)",
    padding: "1px 4px",
  },
  // A fenced code block inside a rendered callout or quote body.
  ".cm-typst-raw-block": {
    fontFamily: "var(--editor-font-mono, monospace)",
    fontSize: "0.9em",
    backgroundColor: "var(--syntax-mono-bg)",
    borderRadius: "var(--radius-sm)",
    padding: "8px 10px",
    margin: "0.4em 0",
    whiteSpace: "pre",
    overflowX: "auto",
    lineHeight: "1.4",
  },
  // Selection over inline content with its own background (highlights, code
  // spans, chips, pills). The editor uses native `::selection` (see
  // inkycapTheme); these rules apply the same tint while keeping the text
  // colour, and `*::selection` reaches chips' inner spans. WebKitGTK only
  // honours `background-color` inside `::selection`.
  [[
    ".cm-typst-highlight",
    ".cm-typst-raw-inline",
    ".cm-typst-raw-block",
    ".cm-typst-tag",
    ".cm-typst-due",
    ".cm-typst-task__due",
    ".cm-typst-wikilink",
    ".cm-typst-pill",
    ".cm-typst-func-chip",
  ]
    // Match both the element itself and any nested spans (chips wrap their
    // label/value in inner spans), so the selection paints across all of it.
    .flatMap((s) => [`${s}::selection`, `${s} *::selection`])
    .join(", ")]: {
    backgroundColor: "var(--bg-selection, Highlight)",
    color: "inherit",
  },
  ".cm-typst-link": {
    color: "var(--syntax-link)",
    textDecoration: "underline",
  },
  ".cm-typst-link-external-icon": {
    display: "inline-block",
    verticalAlign: "baseline",
    marginLeft: "2px",
    opacity: "0.5",
    position: "relative",
    top: "1px",
  },
  ".cm-link-hover": {
    cursor: "pointer",
  },
  // Math marks must never change layout (no display, padding, margin or
  // min-height). A freshly typed `$` pairs with the next `$` below, so the mark
  // can briefly cover several lines of prose; a layout change would move the
  // text on each keystroke (issue #1). A display equation is shown with a
  // tinted background instead.
  ".cm-typst-math-inline": {
    fontFamily: "var(--editor-font-mono, monospace)",
    color: "var(--syntax-string)",
  },
  ".cm-typst-math-display": {
    fontFamily: "var(--editor-font-mono, monospace)",
    color: "var(--syntax-string)",
    backgroundColor: "var(--syntax-mono-bg)",
    borderRadius: "var(--radius-sm)",
  },
  ".cm-typst-label": {
    color: "var(--syntax-type)",
    opacity: "0.6",
  },
  ".cm-typst-ref": {
    color: "var(--syntax-type)",
    cursor: "pointer",
  },
  ".cm-typst-ref-plain, .cm-typst-ref-plain span": {
    color: "inherit !important",
    cursor: "text",
    fontFamily: "inherit !important",
    fontSize: "inherit !important",
    backgroundColor: "transparent !important",
  },
  ".cm-typst-h1, .cm-typst-h2, .cm-typst-h3, .cm-typst-h4, .cm-typst-h5, .cm-typst-h6": {
    color: "var(--fg-primary)",
  },
  [headingInnerNonLinkSelector]: {
    color: "inherit !important",
  },
  ".cm-typst-h1": { fontSize: "1.8em", fontWeight: "bold", lineHeight: "1.3" },
  ".cm-typst-h2": { fontSize: "1.5em", fontWeight: "bold", lineHeight: "1.3" },
  ".cm-typst-h3": { fontSize: "1.3em", fontWeight: "bold", lineHeight: "1.3" },
  ".cm-typst-h4": { fontSize: "1.15em", fontWeight: "bold", lineHeight: "1.3" },
  ".cm-typst-h5": { fontSize: "1.05em", fontWeight: "bold", lineHeight: "1.3" },
  ".cm-typst-h6": { fontSize: "1em", fontWeight: "bold", fontStyle: "italic", lineHeight: "1.3" },
  ".cm-typst-escaped, .cm-typst-escaped span": {
    color: "inherit !important",
    fontWeight: "inherit !important",
    fontStyle: "inherit !important",
  },
  ".cm-typst-term-key": {
    fontWeight: "bold",
  },
  ".cm-typst-term-sep": {
    color: "var(--fg-dim)",
    marginRight: "0.3em",
  },
  ".cm-typst-shorthand": {
    color: "inherit",
  },
  // Non-printing shorthand (soft hyphen): faint placeholder marking the
  // optional break point, since the produced character is invisible in output.
  ".cm-typst-shorthand--ghost": {
    opacity: "0.4",
  },
  ".cm-typst-list-bullet": {
    color: "inherit",
    display: "inline-block",
    width: "var(--list-bullet-width)",
    textAlign: "center",
    // Hanging indent: the line has `padding-left` of one bullet width plus
    // nesting, and this pulls the bullet back to the edge. A negative
    // `text-indent` isn't reliable on WebKitGTK.
    marginLeft: "calc(-1 * var(--list-bullet-width))",
  },
  ".cm-typst-hr-block": {
    display: "block",
    position: "relative",
  },
  ".cm-typst-hr": {
    border: "none",
    borderTop: "2px solid var(--border-primary)",
    margin: "1em 0",
    display: "block",
  },
  // The rule's pill sits centred on the rule itself, inside its own margins.
  ".cm-typst-hr-block .cm-typst-block-pill-overlay": {
    top: "50%",
    transform: "translateY(-50%)",
  },
  ".cm-typst-callout": {
    position: "relative",
    borderRadius: "var(--radius-sm)",
    padding: "var(--callout-pad) var(--callout-inset)",
    margin: "var(--callout-margin) 0",
    display: "block",
  },
  // A flex row with a fixed minimum height, so the heading measures the same
  // whether or not the edit state's pill is sitting in it.
  ".cm-typst-callout-heading": {
    display: "flex",
    alignItems: "center",
    minHeight: "1.6em",
    fontWeight: "bold",
    fontSize: "0.95em",
    marginBottom: "4px",
  },
  // The kind's icon, sized to the heading text and drawn in its colour.
  ".cm-typst-callout-icon": {
    flex: "none",
    width: "1.1em",
    height: "1.1em",
    marginRight: "0.4em",
  },
  ".cm-typst-callout-body": {
    fontSize: "var(--callout-body-size)",
    lineHeight: "var(--callout-line-height)",
  },
  // Lists inside a rendered callout, quote or annotation body. Items get normal
  // wrapping and the editor's marker space, with no vertical margins, so each
  // is one editor line and the block keeps its height in edit mode.
  ".cm-typst-body-list": {
    margin: "0",
    paddingLeft: "var(--list-bullet-width)",
    whiteSpace: "normal",
  },
  ".cm-typst-body-list li": {
    margin: "0",
  },
  // Block widgets replacing a range inside a `.cm-line`. CodeMirror puts a
  // zero-width caret placeholder on each side; with `display: block` each would
  // add an empty row. As an inline-block filling the line, they share its row
  // and the widget measures only its own height.
  ".cm-typst-block-row": {
    display: "inline-block",
    width: "100%",
    verticalAlign: "top",
  },
  "ol.cm-typst-body-list": {
    listStyleType: "decimal",
  },
  "ul.cm-typst-body-list": {
    listStyleType: "disc",
  },
  // ── Code block ──
  // Rendered widget: header strip (language, copy button), code area, footer
  // strip. The edit state below rebuilds this frame line by line from the same
  // variables.
  ".cm-typst-codeblock": {
    fontFamily: "var(--editor-font-mono, monospace)",
    fontSize: "var(--codeblock-font-size)",
    backgroundColor: "var(--bg-secondary)",
    border: "1px solid var(--border-subtle)",
    borderRadius: "var(--radius-md)",
    padding: "0",
    margin: "var(--codeblock-margin) 0",
    overflow: "hidden",
  },
  // Each strip is exactly one code row tall plus its padding, so the edit
  // state's fence lines can stand in for them at the same height.
  ".cm-typst-codeblock-header, .cm-typst-codeblock-footer": {
    boxSizing: "content-box",
    height: "var(--codeblock-row)",
    padding: "var(--codeblock-strip-pad) 6px var(--codeblock-strip-pad) var(--codeblock-inset)",
    backgroundColor: "var(--bg-hover)",
  },
  ".cm-typst-codeblock-header": {
    display: "flex",
    alignItems: "center",
    justifyContent: "space-between",
    gap: "6px",
    borderBottom: "1px solid var(--border-subtle)",
  },
  ".cm-typst-codeblock-footer": {
    borderTop: "1px solid var(--border-subtle)",
  },
  ".cm-typst-codeblock-lang": {
    fontSize: "0.83em",
    color: "var(--fg-dim)",
    fontFamily: "var(--editor-font-mono, monospace)",
  },
  ".cm-typst-codeblock-copy": {
    display: "inline-flex",
    alignItems: "center",
    justifyContent: "center",
    width: "var(--codeblock-row)",
    height: "var(--codeblock-row)",
    padding: "0",
    border: "none",
    borderRadius: "var(--radius-sm)",
    background: "transparent",
    color: "var(--fg-dim)",
    cursor: "pointer",
    transition: "background-color 0.12s, color 0.12s",
    // Buttons don't inherit font size by default; the row-height variable
    // above is in em, so the button must share the block's font size.
    font: "inherit",
  },
  ".cm-typst-codeblock-copy:hover": {
    backgroundColor: "var(--bg-tertiary, var(--bg-secondary))",
    color: "var(--fg-primary)",
  },
  ".cm-typst-codeblock-copy.is-copied": {
    color: "var(--accent)",
  },
  ".cm-typst-codeblock pre": {
    margin: "0",
    padding: "var(--codeblock-body-pad) var(--codeblock-inset)",
    // Wrap long lines inside the box rather than scrolling; `pre-wrap` keeps
    // line breaks and indentation.
    maxWidth: "100%",
    overflowX: "hidden",
    lineHeight: "var(--codeblock-row)",
    fontFamily: "inherit",
  },
  ".cm-typst-codeblock code": {
    fontFamily: "inherit",
    display: "block",
    // A body that is one empty line still measures one row, like its edit line.
    minHeight: "var(--codeblock-row)",
    whiteSpace: "pre-wrap",
    overflowWrap: "anywhere",
  },
  // Edit state: the caret is inside, so lines show as source. The opening fence
  // line is the header strip, the lines between the code area, the closing
  // fence line the footer, so the height is unchanged.
  ".cm-typst-codeblock-edit": {
    fontFamily: "var(--editor-font-mono, monospace) !important",
    fontSize: "var(--codeblock-font-size)",
    lineHeight: "var(--codeblock-row)",
    marginLeft: "var(--line-inset)",
    marginRight: "var(--line-inset-end)",
    padding: "0 var(--codeblock-inset)",
    borderLeft: "1px solid var(--border-subtle)",
    borderRight: "1px solid var(--border-subtle)",
    backgroundColor: "var(--bg-secondary)",
  },
  ".cm-typst-codeblock-edit--open, .cm-typst-codeblock-edit--close": {
    padding: "var(--codeblock-strip-pad) var(--codeblock-inset)",
    borderTop: "1px solid var(--border-subtle)",
    borderBottom: "1px solid var(--border-subtle)",
    backgroundColor: "var(--bg-hover)",
    color: "var(--fg-dim)",
  },
  ".cm-typst-codeblock-edit--open": {
    marginTop: "var(--codeblock-margin)",
    borderRadius: "var(--radius-md) var(--radius-md) 0 0",
  },
  ".cm-typst-codeblock-edit--close": {
    marginBottom: "var(--codeblock-margin)",
    borderRadius: "0 0 var(--radius-md) var(--radius-md)",
  },
  ".cm-typst-codeblock-edit--first": {
    paddingTop: "var(--codeblock-body-pad)",
  },
  ".cm-typst-codeblock-edit--last": {
    paddingBottom: "var(--codeblock-body-pad)",
  },
  // On the caret's line, parser error tokens (an unclosed `$` or `(`) lose
  // their red underline while the writer is typing. Registered at the lowest
  // precedence so it wraps the highlighter's span.
  ".cm-typst-caret-line-error, .cm-typst-caret-line-error *": {
    color: "inherit !important",
    textDecoration: "none !important",
  },
  ".cm-typst-block-pill-row": {
    display: "flex",
    alignItems: "center",
    gap: "6px",
    padding: "1px 0",
    margin: "0",
    lineHeight: "1.4",
  },
  // Pill row floated over a block widget's top-left corner (images, media,
  // rules), so showing it doesn't make the block taller.
  ".cm-typst-block-pill-overlay": {
    position: "absolute",
    top: "var(--space-1)",
    left: "var(--space-1)",
    padding: "0",
    zIndex: "1",
  },
  // Muted count trailing a pill's label (the document-style preamble's rule
  // count, a comment pill's line count). The pill itself is standard chrome.
  ".cm-typst-pill-count": {
    color: "var(--fg-dim)",
    fontSize: "0.92em",
    marginLeft: "1px",
  },
  ".cm-typst-image-block": {
    display: "block",
    position: "relative",
    margin: "0",
    textAlign: "center" as any,
  },
  ".cm-typst-image-block-path": {
    fontFamily: "var(--editor-font-mono, monospace)",
    fontSize: "0.85em",
    color: "var(--fg-dim)",
    marginLeft: "4px",
  },
  // Both wrappers also carry .cm-typst-block-row; `overflow: hidden` keeps the
  // inner element's margins inside the wrapper's box.
  ".cm-typst-callout-block": {
    position: "relative",
    margin: "0",
  },
  ".cm-typst-blockquote-block": {
    position: "relative",
    margin: "0",
  },
  ".cm-typst-bibliography-block": {
    display: "block",
    position: "relative",
    margin: "0",
  },
  ".cm-typst-bibliography-block-path": {
    fontFamily: "var(--editor-font-mono, monospace)",
    fontSize: "0.85em",
    color: "var(--fg-dim)",
    marginLeft: "6px",
    opacity: "0.8",
  },
  ".cm-typst-block-collapsed-body": {
    fontSize: "0.9em",
    color: "var(--fg-dim)",
    marginLeft: "4px",
  },
  ".cm-typst-image": {
    display: "block",
    position: "relative",
    margin: "4px 0",
    textAlign: "center" as any,
  },
  ".cm-typst-image-img": {
    maxWidth: "100%",
    maxHeight: "400px",
    borderRadius: "var(--radius-sm)",
    display: "block",
    margin: "0 auto",
  },
  ".cm-typst-image-label": {
    fontFamily: "var(--editor-font-mono, monospace)",
    fontSize: "0.75em",
    color: "var(--fg-dim)",
    padding: "2px 6px",
    textAlign: "center" as any,
  },
  // An embed shown as its path with an open button (a PDF `#image`, or media
  // that couldn't be shown). Tall enough for the floating block pill, which
  // overflow would otherwise cut off. Centred, so a short path doesn't run
  // under the pill.
  ".cm-typst-file-row": {
    display: "flex",
    alignItems: "center",
    justifyContent: "center",
    gap: "var(--space-2)",
    minHeight: "calc(1em * var(--editor-line-height, 1.4) + 2 * var(--space-1))",
  },
  // Square and exactly one text row tall, the same as the block pill, which
  // is sized in the same `em` (see `.cm-typst-pill`).
  ".cm-typst-file-open": {
    display: "inline-flex",
    alignItems: "center",
    justifyContent: "center",
    flexShrink: "0",
    boxSizing: "border-box",
    height: "calc(1em * var(--editor-line-height, 1.4))",
    aspectRatio: "1",
    padding: "0",
    background: "none",
    border: "1px solid var(--border-subtle)",
    borderRadius: "var(--radius-sm)",
    color: "var(--accent-text)",
    cursor: "pointer",
    transition: "background var(--dur-fast) var(--ease-out)",
  },
  ".cm-typst-file-open svg": {
    width: "0.9em",
    height: "0.9em",
  },
  ".cm-typst-file-open:hover": {
    background: "var(--bg-hover)",
  },
  ".cm-typst-file-open:focus-visible": {
    outline: "none",
    boxShadow: "var(--focus-ring)",
  },
  // Inline-block wrapper around the preview image, so the resize handle anchors
  // to the image and text-align still places it.
  ".cm-typst-image-holder": {
    position: "relative",
    display: "inline-block",
    maxWidth: "100%",
    lineHeight: "0",
  },
  // Corner drag handle — hidden until the image is hovered or being resized.
  // nwse cursor signals a proportional (aspect-locked) corner drag.
  ".cm-typst-image-resize-handle": {
    position: "absolute",
    right: "0",
    bottom: "0",
    width: "14px",
    height: "14px",
    boxSizing: "border-box",
    cursor: "nwse-resize",
    background: "var(--accent)",
    border: "2px solid var(--surface-0)",
    borderRadius: "var(--radius-sm)",
    opacity: "0",
    transition: "opacity var(--dur-fast) var(--ease-out)",
    touchAction: "none",
    zIndex: "1",
  },
  ".cm-typst-image-holder:hover .cm-typst-image-resize-handle, .cm-typst-image-holder.is-resizing .cm-typst-image-resize-handle": {
    opacity: "1",
  },
  // Live width readout shown only while dragging.
  ".cm-typst-image-size-badge": {
    position: "absolute",
    top: "var(--space-1)",
    right: "var(--space-1)",
    padding: "1px 6px",
    fontFamily: "var(--editor-font-mono, monospace)",
    fontSize: "0.72em",
    lineHeight: "1.4",
    color: "var(--fg-primary)",
    background: "var(--popup-bg)",
    border: "1px solid var(--popup-border-color)",
    borderRadius: "var(--radius-sm)",
    opacity: "0",
    pointerEvents: "none",
  },
  ".cm-typst-image-holder.is-resizing .cm-typst-image-size-badge": {
    opacity: "1",
  },
  ".cm-typst-media-block": {
    display: "block",
    position: "relative",
    margin: "4px 0",
  },
  ".cm-typst-media-video": {
    maxWidth: "100%",
    maxHeight: "50vh",
    borderRadius: "var(--radius-sm)",
    display: "block",
    margin: "0 auto",
  },
  ".cm-typst-media-audio": {
    width: "100%",
    display: "block",
  },
  ".cm-typst-tag": {
    display: "inline-flex",
    alignItems: "center",
    gap: "3px",
    backgroundColor: "var(--accent-purple-bg)",
    color: "var(--accent-text)",
    borderRadius: "var(--radius-sm)",
    padding: "1px 6px",
    fontSize: "0.85em",
    cursor: "pointer",
  },
  ".cm-typst-tag-icon": {
    flex: "0 0 auto",
    opacity: "0.8",
  },
  ".cm-typst-task": {
    display: "inline-flex",
    alignItems: "baseline",
    gap: "4px",
  },
  ".cm-typst-task__box": {
    cursor: "pointer",
    userSelect: "none",
    fontSize: "1.05em",
    lineHeight: "1",
  },
  ".cm-typst-task--done .cm-typst-task__body": {
    textDecoration: "line-through",
    color: "var(--fg-dim)",
  },
  ".cm-typst-task__due": {
    backgroundColor: "var(--accent-purple-bg)",
    color: "var(--accent-text)",
    borderRadius: "var(--radius-sm)",
    padding: "0 5px",
    fontSize: "0.8em",
  },
  ".cm-typst-due": {
    display: "inline-block",
    backgroundColor: "var(--accent-purple-bg)",
    color: "var(--accent-text)",
    borderRadius: "var(--radius-sm)",
    padding: "1px 6px",
    fontSize: "0.85em",
  },
  // Inline `#suggestion(...)` colours match lib.typ's `_suggestion-*-color`
  // (green #16a34a, red #dc2626) rather than the theme's.
  ".cm-typst-suggestion": {
    cursor: "pointer",
  },
  ".cm-suggestion-ins": {
    color: "#16a34a", // token-exempt: CriticMarkup insertion green
    textDecoration: "underline",
  },
  ".cm-suggestion-del": {
    color: "#dc2626", // token-exempt: CriticMarkup deletion red
    textDecoration: "line-through",
  },
  ".cm-typst-wikilink": {
    display: "inline",
    color: "var(--syntax-link)",
    textDecoration: "underline",
    textDecorationStyle: "solid",
    cursor: "pointer",
  },
  ".cm-typst-wikilink.cm-typst-wikilink--unresolved": {
    textDecorationStyle: "dotted",
    opacity: "0.85",
  },
  ".cm-typst-wikilink.cm-typst-strike": {
    textDecoration: "underline line-through",
  },
  ".cm-typst-wikilink-sep": {
    color: "var(--fg-dim)",
    opacity: "0.6",
  },
  ".cm-typst-wikilink-label": {
    fontSize: "0.85em",
    fontWeight: "300",
    opacity: "0.7",
  },
  // Editable `[[Name::label]]` affordance shown when the cursor is on a
  // wikilink: muted brackets/`::` framing live, link-coloured note/heading text.
  ".cm-typst-wikilink-bracket": {
    color: "var(--fg-dim)",
    opacity: "0.7",
  },
  ".cm-typst-wikilink-edit": {
    color: "var(--syntax-link)",
  },
  ".cm-typst-footnote": {
    color: "var(--syntax-link)",
    cursor: "help",
    fontSize: "0.8em",
    verticalAlign: "super",
    fontWeight: "bold",
  },
  // ── Block quote ──
  // Rendered widget. A large opening quotation mark sits in the left inset (see
  // `::before` below).
  ".cm-typst-blockquote": {
    display: "block",
    position: "relative",
    padding: "var(--quote-pad) var(--quote-inset-end) var(--quote-pad) var(--quote-inset)",
    margin: "var(--quote-margin) 0",
    lineHeight: "var(--quote-line-height)",
    fontStyle: "italic",
    color: "var(--fg-muted)",
  },
  // The opening quotation mark, shared by the widget and the first edit line so
  // it sits in the same place. Absolutely positioned, so it adds no height. A
  // pseudo-element is fine here because it never sits where the caret can go
  // (unlike the inline quotes; see QuoteGlyphWidget).
  ".cm-typst-blockquote::before, .cm-typst-blockquote-line.cm-typst-block-edit-first::before": {
    content: '"\u201C"',
    position: "absolute",
    left: "0",
    // Nudge up so the visible part of the glyph lines up with the first row.
    top: "calc(var(--quote-pad) - 0.2em)",
    fontFamily: "serif",
    fontSize: "var(--quote-mark-size)",
    lineHeight: "1",
    fontStyle: "normal",
    color: "var(--fg-dim)",
    opacity: "0.5",
    pointerEvents: "none",
    userSelect: "none",
  },
  ".cm-typst-blockquote-attr": {
    marginTop: "4px",
    fontSize: "0.9em",
    fontStyle: "normal",
    color: "var(--fg-dim)",
  },
  // Edit state: each body line has the inset, the first draws the quotation
  // mark, and the first and last add the widget's gap and padding, so the
  // height matches. The italic fill is a separate mark limited to the body.
  ".cm-typst-blockquote-line": {
    marginLeft: "var(--line-inset)",
    marginRight: "var(--line-inset-end)",
    position: "relative",
    padding: "0 var(--quote-inset-end) 0 var(--quote-inset)",
    lineHeight: "var(--quote-line-height)",
    // Rows here are taller than body rows, so a pill on one sizes to this.
    "--editor-line-height": "var(--quote-line-height)",
    // Lists inside the body keep their hanging indent past this inset.
    "--line-block-inset": "var(--quote-inset)",
  },
  ".cm-typst-blockquote-line.cm-typst-block-edit-first": {
    marginTop: "var(--quote-margin)",
    paddingTop: "var(--quote-pad)",
  },
  ".cm-typst-blockquote-line.cm-typst-block-edit-last": {
    marginBottom: "var(--quote-margin)",
    paddingBottom: "var(--quote-pad)",
  },
  ".cm-typst-blockquote-body": {
    fontStyle: "italic",
    color: "var(--fg-muted)",
  },
  // ── Callout edit state ──
  // A heading row (pill and label) replaces the hidden opener on the first body
  // line; every body line gets the frame's inset and tint (colour set per
  // kind), with the corner brackets on the first and last. Together they match
  // the widget's height.
  ".cm-typst-callout-line": {
    marginLeft: "var(--line-inset)",
    marginRight: "var(--line-inset-end)",
    position: "relative",
    padding: "0 var(--callout-inset)",
    fontSize: "var(--callout-body-size)",
    lineHeight: "var(--callout-line-height)",
    // Rows here are taller than body rows, so a pill on one sizes to this.
    "--editor-line-height": "var(--callout-line-height)",
    "--line-block-inset": "var(--callout-inset)",
  },
  ".cm-typst-callout-line.cm-typst-block-edit-first": {
    marginTop: "var(--callout-margin)",
    borderRadius: "var(--radius-sm) var(--radius-sm) 0 0",
  },
  ".cm-typst-callout-line.cm-typst-block-edit-last": {
    marginBottom: "var(--callout-margin)",
    paddingBottom: "var(--callout-pad)",
    borderRadius: "0 0 var(--radius-sm) var(--radius-sm)",
  },
  ".cm-typst-callout-line.cm-typst-block-edit-first.cm-typst-block-edit-last": {
    borderRadius: "var(--radius-sm)",
  },
  // The callout frame: a corner bracket at the top-left and bottom-right in
  // `--callout-color`, faded by `--callout-corner-strength`. Shared by the
  // widget and the edit state's first and last lines. Out of flow, so no
  // height; `max-height` keeps the vertical arm inside a short line.
  ".cm-typst-callout::before, .cm-typst-callout-line.cm-typst-block-edit-first::before, .cm-typst-callout::after, .cm-typst-callout-line.cm-typst-block-edit-last::after": {
    content: '""',
    position: "absolute",
    width: "var(--callout-corner-across)",
    height: "var(--callout-corner-down)",
    maxHeight: "100%",
    borderColor: "color-mix(in srgb, var(--callout-color) var(--callout-corner-strength), transparent)",
    borderStyle: "solid",
    borderWidth: "0",
    pointerEvents: "none",
  },
  ".cm-typst-callout::before, .cm-typst-callout-line.cm-typst-block-edit-first::before": {
    top: "0",
    left: "0",
    borderTopWidth: "var(--callout-corner-width)",
    borderLeftWidth: "var(--callout-corner-width)",
    borderTopLeftRadius: "var(--radius-sm)",
  },
  ".cm-typst-callout::after, .cm-typst-callout-line.cm-typst-block-edit-last::after": {
    bottom: "0",
    right: "0",
    borderBottomWidth: "var(--callout-corner-width)",
    borderRightWidth: "var(--callout-corner-width)",
    borderBottomRightRadius: "var(--radius-sm)",
  },
  // Also carries .cm-typst-block-row, whose inline-block box keeps the
  // heading's bottom margin inside the row.
  ".cm-typst-callout-head": {
    paddingTop: "var(--callout-pad)",
  },
  // The line already applies the body font size; don't scale the heading twice.
  ".cm-typst-callout-head .cm-typst-callout-heading": {
    fontSize: "inherit",
  },
  // ── Pills ──
  // One style for every pill in the visual editor. See
  // documentation/developer/visual-editor/pill-system.md. `.cm-typst-func-chip`
  // is an alias for older call sites.
  ".cm-typst-pill, .cm-typst-func-chip": {
    display: "inline-flex",
    alignItems: "center",
    gap: "3px",
    backgroundColor: "var(--bg-secondary)",
    border: "1px solid var(--border-subtle)",
    borderRadius: "var(--radius-full)",
    padding: "0 6px 0 3px",
    color: "var(--fg-muted)",
    cursor: "pointer",
    // An inline pill comes and goes as the caret enters and leaves its line, so
    // it must be exactly one text row tall, or lines below shift. `1em` here is
    // the pill's own smaller size, so divide by the scale and multiply by the
    // row height. Top alignment seats it in the row.
    boxSizing: "border-box",
    height: "calc(1em / var(--pill-font-scale, 0.78) * var(--editor-line-height, 1.4))",
    verticalAlign: "top",
    userSelect: "none",
    // Reset native button visuals so a <button> matches a <span>.
    font: "inherit",
    fontSize: "calc(1em * var(--pill-font-scale, 0.78))",
    fontFamily: "var(--editor-font-mono, monospace)",
    lineHeight: "1",
    // A small gap so the pill doesn't touch the text after it.
    margin: "0 var(--space-1) 0 0",
  },
  ".cm-typst-pill:hover, .cm-typst-func-chip:hover, .cm-typst-pill:focus-visible, .cm-typst-func-chip:focus-visible": {
    color: "var(--fg-primary)",
    borderColor: "var(--accent)",
    outline: "none",
  },
  // A pill hiding a search match (hidden-match-pills.ts) takes the match
  // colour, and the current match a ring. Neither changes its size.
  ".cm-typst-pill.cm-typst-pill--search-match": {
    backgroundColor: "var(--bg-search-match)",
    borderColor: "var(--bg-search-match)",
    color: "var(--fg-primary)",
  },
  ".cm-typst-pill.cm-typst-pill--search-current": {
    boxShadow: "0 0 0 2px var(--bg-search-match), 0 0 6px 2px var(--bg-search-match)",
  },
  ".cm-typst-pill-hash, .cm-typst-func-chip-hash": {
    display: "inline-flex",
    alignItems: "center",
    justifyContent: "center",
    width: "1.15em",
    height: "1.15em",
    borderRadius: "50%",
    backgroundColor: "var(--accent)",
    color: "var(--pill-fg)",
    fontSize: "inherit",
    lineHeight: "0",
    transition: "background-color 0.12s ease",
  },
  ".cm-typst-pill-hash::after, .cm-typst-func-chip-hash::after": {
    content: "'#'",
    fontSize: "0.76em",
    fontWeight: "bold",
    lineHeight: "1",
  },
  // ── Pill super-context-menu (R6) ──
  ".cm-typst-pill-menu": {
    // Shared popup surface — see --popup-* tokens in themes.css.
    backgroundColor: "var(--popup-bg)",
    border: "1px solid var(--popup-border-color)",
    borderRadius: "var(--popup-radius)",
    padding: "var(--popup-padding-block) 0",
    boxShadow: "var(--popup-shadow)",
    zIndex: "var(--z-menu)",
    minWidth: "320px",
    // Cap the width so an expanded inline help block (or a long value) wraps
    // instead of stretching the whole menu wide.
    maxWidth: "360px",
    fontSize: "0.9em",
    // UI chrome (a menu popup), so it follows the interface font.
    fontFamily: "var(--interface-font, inherit)",
  },
  ".cm-typst-pill-menu-heading": {
    padding: "4px 12px 2px",
    fontSize: "0.78em",
    fontWeight: "600",
    letterSpacing: "0.3px",
    color: "var(--fg-muted)",
  },
  ".cm-typst-pill-menu-sep": {
    height: "1px",
    margin: "4px 0",
    backgroundColor: "var(--popup-separator-color)",
  },
  ".cm-typst-pill-menu-item": {
    display: "flex",
    alignItems: "center",
    width: "100%",
    padding: "var(--popup-item-padding)",
    fontSize: "inherit",
    fontFamily: "inherit",
    color: "var(--fg-primary)",
    backgroundColor: "transparent",
    border: "none",
    textAlign: "left",
    cursor: "pointer",
    gap: "8px",
  },
  ".cm-typst-pill-menu-item:hover, .cm-typst-pill-menu-item:focus-visible": {
    backgroundColor: "var(--bg-hover)",
    outline: "none",
  },
  // Keyboard highlight from lib/menu-nav.ts. A class rather than
  // :focus-visible, since script-moved focus after a click doesn't count as
  // visible (see context-menu.css).
  ".cm-typst-pill-menu-item.is-kbd-active": {
    backgroundColor: "var(--bg-hover)",
    boxShadow: "inset 0 0 0 2px var(--accent)",
    outline: "none",
  },
  ".cm-typst-pill-menu-item.is-disabled": {
    color: "var(--fg-dim)",
    cursor: "not-allowed",
  },
  ".cm-typst-pill-menu-item.is-active": {
    color: "var(--accent)",
  },
  ".cm-typst-pill-menu-label": {
    flex: "1",
  },
  // Sits to the right of the label (the label's flex:1 pushes it there).
  // Keep a small left margin so it doesn't crowd long labels.
  ".cm-typst-pill-menu-check": {
    marginLeft: "8px",
    color: "var(--accent)",
    fontSize: "0.95em",
    lineHeight: "1",
  },
  ".cm-typst-pill-menu-input-row": {
    display: "flex",
    alignItems: "center",
    flexWrap: "wrap",
    gap: "8px",
    padding: "5px 12px",
    cursor: "default",
  },
  // Inline help revealed by the row's "?" trigger. flex-basis 100% drops it
  // onto its own line below the label + input so the full width is available.
  ".cm-typst-pill-menu-help": {
    flexBasis: "100%",
    minWidth: "0",
    margin: "2px 0 0 0",
    fontSize: "0.85em",
    lineHeight: "1.45",
    color: "var(--fg-muted)",
    whiteSpace: "normal",
    overflowWrap: "anywhere",
  },
  ".cm-typst-pill-menu-input-label": {
    fontSize: "0.92em",
    color: "var(--fg-muted)",
    minWidth: "70px",
    cursor: "text",
  },
  ".cm-typst-pill-menu-input": {
    flex: "1",
    minWidth: "0",
    padding: "3px 6px",
    fontSize: "inherit",
    fontFamily: "inherit",
    color: "var(--fg-primary)",
    backgroundColor: "var(--bg-input, var(--bg-secondary))",
    border: "1px solid var(--border-subtle)",
    borderRadius: "var(--radius-sm)",
  },
  ".cm-typst-pill-menu-input:focus": {
    outline: "none",
    borderColor: "var(--accent)",
  },
  // A colour field is a swatch that opens the browser's picker, at the height
  // of the row's text.
  ".cm-typst-pill-menu-input--color": {
    flex: "0 0 auto",
    width: "44px",
    height: "22px",
    padding: "1px",
    cursor: "pointer",
  },
  ".cm-typst-citation": {
    display: "inline-block",
    backgroundColor: "var(--bg-secondary)",
    color: "var(--syntax-type)",
    borderRadius: "var(--radius-sm)",
    padding: "1px 5px",
    fontSize: "0.9em",
    fontFamily: "var(--editor-font-mono, monospace)",
  },
  // Cross-reference pill (`@heading`, `@fig-…`): like the citation chip but
  // accent-tinted and in the body font, since it shows the target's text.
  ".cm-typst-ref-pill": {
    display: "inline-block",
    backgroundColor: "color-mix(in srgb, var(--accent) 12%, transparent)",
    color: "var(--accent)",
    borderRadius: "var(--radius-sm)",
    padding: "1px 6px",
    cursor: "pointer",
  },
  ".cm-typst-ref-pill::before": {
    content: '"→ "',
    opacity: "0.6",
  },
  // Standalone reference that resolves to nothing — a dangling/typo `@target`.
  // Dotted warning underline; non-intrusive but visible.
  ".cm-typst-ref-broken": {
    color: "var(--syntax-type)",
    textDecoration: "underline dotted var(--accent-danger)",
    textUnderlineOffset: "2px",
    cursor: "text",
  },
  // ── Verse ──
  // A contentEditable canvas with inline formatting, with the pill at its
  // top-left.
  ".cm-typst-verse": {
    display: "block",
    position: "relative",
    margin: "4px 0",
    padding: "0",
    // Subtle dotted top/bottom rules demark the verse region without
    // making it feel boxed-in. Pill at top-left identifies it.
    borderTop: "2px dotted var(--border-subtle)",
    borderBottom: "2px dotted var(--border-subtle)",
    // Font: the verse font, else the user's editor font, else the static
    // default.
    "--verse-active-font": "var(--verse-font, var(--md-body-font, var(--editor-font-body, serif)))",
  },
  // The verse pill uses `.cm-typst-pill`; this only positions it at the
  // canvas's corner.
  ".cm-typst-verse-pill": {
    position: "absolute",
    top: "0",
    left: "0",
    zIndex: "2",
  },
  ".cm-typst-verse-canvas": {
    display: "block",
    minHeight: "1.6em",
    padding: "32px 12px 12px 12px",
    fontFamily: "var(--verse-active-font)",
    fontSize: "inherit",
    lineHeight: "1.7",
    whiteSpace: "pre-wrap",
    wordBreak: "break-word",
    color: "var(--fg-primary)",
    outline: "none",
    caretColor: "var(--accent)",
    "-webkit-user-select": "text",
    userSelect: "text",
  },
  ".cm-typst-verse-canvas:focus": {
    backgroundColor: "var(--bg-hover-subtle, transparent)",
  },
  ".cm-typst-verse-canvas mark": {
    backgroundColor: "var(--highlight-bg)",
    color: "inherit",
    padding: "0 2px",
    borderRadius: "var(--radius-xs)",
  },
  // ── Table widget ──
  ".cm-typst-table-wrap": {
    display: "block",
    position: "relative",
    margin: "4px 0",
    outline: "none",
  },
  ".cm-typst-table": {
    borderCollapse: "collapse",
    fontSize: "0.9em",
  },
  ".cm-typst-table th, .cm-typst-table td": {
    border: "1px solid var(--border-subtle)",
    padding: "0",
    position: "relative",
  },
  ".cm-typst-table th": {
    backgroundColor: "var(--bg-hover)",
    fontWeight: "bold",
    textAlign: "left",
  },

  // ── Cell: painted idle, or hosting the cell editor while being edited ──
  ".cm-typst-table-cell": {
    minHeight: "1.6em",
    padding: "4px 8px",
    outline: "none",
    lineHeight: "1.5",
    cursor: "default",
    "-webkit-user-select": "none",
    userSelect: "none",
    whiteSpace: "pre-wrap",
    wordBreak: "break-word",
  },
  // One box per source line of a painted cell, with the line styling the note
  // gives that line (notably the list indent the bullet hangs from). Empty
  // lines keep their row.
  ".cm-typst-cell-line": {
    display: "block",
  },
  ".cm-typst-cell-line:empty::after": {
    content: "'\\200b'",
  },
  ".cm-typst-table-cell.cm-typst-table-cell--editing": {
    boxShadow: "inset 0 0 0 2px var(--accent)",
    cursor: "text",
    "-webkit-user-select": "text",
    userSelect: "text",
  },
  // WebKitGTK only honours `background-color` inside `::selection`.
  ".cm-typst-table-cell::selection, .cm-typst-table-cell *::selection": {
    backgroundColor: "var(--bg-selection, Highlight)",
    color: "inherit",
  },
  // Selected cells get the same edge as selected rows and columns, so they
  // don't read as search matches, which share the fill colour.
  ".cm-typst-table-cell--selected": {
    backgroundColor: "var(--bg-search-match)",
    boxShadow: "inset 0 0 0 1.5px var(--accent)",
  },

  // ── Column/row selection highlight ──
  ".cm-table-col--selected": {
    backgroundColor: "color-mix(in srgb, var(--accent) 8%, transparent)",
    boxShadow: "inset 0 0 0 1.5px var(--accent)",
  },
  ".cm-table-row--selected": {
    backgroundColor: "color-mix(in srgb, var(--accent) 8%, transparent)",
  },
  ".cm-table-row--selected td, .cm-table-row--selected th": {
    boxShadow: "inset 0 0 0 1.5px var(--accent)",
  },

  // ── Drop indicators during drag reorder ──
  ".cm-table-drop-before": {
    borderLeft: "2.5px solid var(--accent) !important",
  },
  ".cm-table-drop-after": {
    borderRight: "2.5px solid var(--accent) !important",
  },
  "tr.cm-table-drop-before": {
    borderLeft: "none !important",
    borderTop: "2.5px solid var(--accent) !important",
  },
  "tr.cm-table-drop-after": {
    borderRight: "none !important",
    borderBottom: "2.5px solid var(--accent) !important",
  },

  // ── Control row (column handles above data) ──
  ".cm-table-control-row": {
    opacity: "0",
    transition: "opacity 0.15s",
  },
  ".cm-typst-table-wrap:hover .cm-table-control-row, .cm-typst-table-wrap:focus-within .cm-table-control-row": {
    opacity: "1",
  },
  ".cm-table-control-row td": {
    border: "none !important",
    padding: "0 !important",
    height: "16px",
    position: "relative",
  },
  ".cm-table-corner-cell": {
    width: "18px",
    minWidth: "18px",
    maxWidth: "18px",
    border: "none !important",
  },
  ".cm-table-col-header-cell": {
    textAlign: "center",
    position: "relative",
  },
  ".cm-table-col-handle": {
    display: "flex",
    alignItems: "center",
    justifyContent: "center",
    width: "100%",
    height: "100%",
    fontSize: "var(--text-xs)",
    color: "var(--fg-dim)",
    cursor: "grab",
    userSelect: "none",
    borderRadius: "var(--radius-xs)",
  },
  ".cm-table-row-handle": {
    display: "flex",
    alignItems: "center",
    justifyContent: "center",
    width: "100%",
    height: "100%",
    fontSize: "var(--text-xs)",
    color: "var(--fg-dim)",
    cursor: "grab",
    userSelect: "none",
    borderRadius: "var(--radius-xs)",
  },
  ".cm-table-corner-handle": {
    display: "flex",
    alignItems: "center",
    justifyContent: "center",
    width: "100%",
    height: "100%",
    color: "var(--fg-dim)",
    cursor: "pointer",
    userSelect: "none",
    borderRadius: "var(--radius-xs)",
  },
  ".cm-table-corner-handle .cm-table-handle-grip svg": {
    width: "10px",
    height: "10px",
  },
  ".cm-table-col-handle:hover, .cm-table-row-handle:hover, .cm-table-corner-handle:hover": {
    backgroundColor: "var(--bg-hover)",
    color: "var(--fg-primary)",
  },
  ".cm-table-col-handle.cm-table-handle--dragging, .cm-table-row-handle.cm-table-handle--dragging": {
    opacity: "0.4",
    cursor: "grabbing",
  },

  ".cm-table-handle-grip": {
    pointerEvents: "none",
    display: "flex",
    alignItems: "center",
    justifyContent: "center",
  },
  ".cm-table-handle-grip svg": {
    display: "block",
    width: "14px",
    height: "14px",
  },

  // ── Row handle cells (left column) ──
  ".cm-table-row-handle-cell": {
    width: "18px",
    minWidth: "18px",
    maxWidth: "18px",
    border: "none !important",
    padding: "0 !important",
    position: "relative",
    opacity: "0",
    transition: "opacity 0.15s",
  },
  ".cm-table-row-handle-cell .cm-table-row-handle": {
    position: "absolute",
    inset: "0",
  },
  ".cm-typst-table-wrap:hover .cm-table-row-handle-cell, .cm-typst-table-wrap:focus-within .cm-table-row-handle-cell": {
    opacity: "1",
  },

  // ── Edge-drag resize handles ──
  // Thin lines over each column's right edge and row's bottom edge (placed by
  // setupResize). The hit area is wider than the 2px line through background
  // clipping.
  ".cm-table-resize-overlay": {
    position: "absolute",
    inset: "0",
    pointerEvents: "none",
    zIndex: "4",
  },
  ".cm-table-resize-handle": {
    position: "absolute",
    // Inert until the table is hovered/focused, so the invisible hit strips
    // don't swallow clicks meant for cell text near a boundary.
    pointerEvents: "none",
    boxSizing: "border-box",
    backgroundColor: "var(--accent)",
    backgroundClip: "content-box",
    opacity: "0",
    transition: "opacity 0.12s",
  },
  ".cm-table-resize-handle--col": {
    width: "7px",
    marginLeft: "-3.5px",
    padding: "0 2.5px",
    cursor: "col-resize",
  },
  ".cm-typst-table-wrap:hover .cm-table-resize-handle, .cm-typst-table-wrap:focus-within .cm-table-resize-handle": {
    opacity: "0.25",
    pointerEvents: "auto",
  },
  ".cm-table-resize-handle:hover, .cm-table-resize-handle.cm-table-resize-handle--active": {
    opacity: "1 !important",
  },
  // While actively dragging, fatten the line and add a soft glow so the
  // gesture clearly reads as a resize in progress.
  ".cm-table-resize-handle--col.cm-table-resize-handle--active": {
    padding: "0 2px",
    boxShadow: "0 0 3px var(--accent)",
  },
  // The column whose edge is being dragged is tinted for the duration.
  ".cm-table-cell--resizing": {
    backgroundColor: "color-mix(in srgb, var(--accent) 12%, transparent)",
  },

  // ── Angle bracket warning ──
  ".cm-typst-angle-bracket-warning": {
    display: "inline-flex",
    alignItems: "center",
    justifyContent: "center",
    width: "1.1em",
    height: "1.1em",
    fontSize: "0.8em",
    color: "var(--warn-fg)",
    cursor: "pointer",
    verticalAlign: "middle",
    marginRight: "2px",
    userSelect: "none",
    borderRadius: "var(--radius-sm)",
    backgroundColor: "var(--warn-bg-alpha)",
  },

  // Context menu styles are inline — the menu is appended to document.body
  // which is outside the CM6 editor, so theme-scoped CSS doesn't apply.
});
