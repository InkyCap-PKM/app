import { EditorView } from "@codemirror/view";

// Spans nested inside a heading are forced to the heading colour so a heading
// reads as one colour — but link-family elements are excluded: a wikilink/link/
// footnote keeps its own colour even inside a heading (standard for links, and
// now load-bearing because heading marks are `inclusiveEnd`, so a heading that
// ends in a wikilink encloses its pill / `[[ ]]` brackets in the heading span).
// Without these exclusions those elements would inherit the heading colour and
// look like plain text.
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
  // Shared bullet/number width for list items. The marker widget is this wide,
  // and list lines hang-indent their wrapped continuation by the same amount
  // (see `pushListIndent` in visual-plugin) so the two never drift apart. It
  // also stands in for the marker's now-hidden trailing space, so ~1.5em keeps
  // the bullet-to-text gap roughly where it was before that space was folded in.
  ".cm-content": { "--list-bullet-width": "1.5em" },
  // Let the caret follow the natural height of the line it sits on. A fixed
  // cap (previously 1.5em) left the caret stranded short and top-aligned on
  // heading lines, whose font is up to 1.8em — the caret must grow with the
  // text so it reads as belonging to the heading.
  ".cm-cursor": { maxHeight: "none" },
  ".cm-gutters": {
    display: "none !important",
  },
  ".cm-typst-bold": { fontWeight: "bold" },
  ".cm-typst-italic": { fontStyle: "italic", color: "inherit" },
  ".cm-typst-strike": { textDecoration: "line-through", color: "var(--syntax-strike)" },
  ".cm-typst-highlight": {
    // A bare `#highlight[…]` (no `fill:`) is the "Yellow" default — the
    // palette's default deliberately writes no fill to keep source clean, so
    // the bare mark must paint the same yellow the notebox wrapper compiles
    // to (`--hl-yellow`, themed light/dark).
    backgroundColor: "var(--hl-yellow)",
    borderRadius: "2px",
    padding: "0 2px",
    // The five highlight palette colours are intentionally light pastels,
    // chosen so the marking reads as a felt-pen highlight rather than a
    // background tint. In dark mode the editor's default text colour is
    // near-white, which becomes unreadable on those pastels — pin a near-
    // black text colour on highlighted spans so the contrast is right
    // regardless of theme.
    color: "#1a1a1a",
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
  // Inline #quote[…] smart quotes — atomic widgets standing in for the hidden
  // `#quote[` / `]` markup so the visual editor tracks Typst's inline-quote
  // rendering (effectively HTML `<q>`). Presentation only; the body between
  // them remains live source. See QuoteGlyphWidget for why these are widgets
  // rather than ::before/::after pseudo-elements.
  ".cm-typst-quote-glyph": { color: "inherit" },
  ".cm-typst-raw-inline": {
    fontFamily: "var(--editor-font-mono, monospace)",
    // Monospace renders visually larger than the body font at the same em, so
    // step it down to read at the same size as surrounding prose — matching the
    // 0.9em used by the editor's other code surfaces (code blocks, edit mode).
    fontSize: "0.9em",
    backgroundColor: "var(--syntax-mono-bg)",
    borderRadius: "3px",
    padding: "1px 4px",
  },
  // Fenced code block inside a rendered block body (callout / quote /
  // annotation widget). Same monospace size as inline raw, laid out as a
  // multi-line preformatted block.
  ".cm-typst-raw-block": {
    fontFamily: "var(--editor-font-mono, monospace)",
    fontSize: "0.9em",
    backgroundColor: "var(--syntax-mono-bg)",
    borderRadius: "4px",
    padding: "8px 10px",
    margin: "0.4em 0",
    whiteSpace: "pre",
    overflowX: "auto",
    lineHeight: "1.4",
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
  ".cm-typst-math-inline": {
    fontFamily: "var(--editor-font-mono, monospace)",
    color: "var(--syntax-string)",
  },
  ".cm-typst-math-display": {
    fontFamily: "var(--editor-font-mono, monospace)",
    color: "var(--syntax-string)",
    display: "block",
    padding: "0.5em 0",
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
  },
  ".cm-typst-hr": {
    border: "none",
    borderTop: "2px solid var(--border-primary)",
    margin: "1em 0",
    display: "block",
  },
  ".cm-typst-callout": {
    borderLeft: "3px solid var(--accent)",
    borderRadius: "4px",
    padding: "8px 12px",
    margin: "4px 0",
    display: "block",
  },
  ".cm-typst-callout-heading": {
    fontWeight: "bold",
    fontSize: "0.95em",
    marginBottom: "4px",
  },
  ".cm-typst-callout-body": {
    fontSize: "0.95em",
    lineHeight: "1.5",
  },
  // Lists rendered inside a block body (callout / quote / annotation). The
  // body inherits CM's pre-wrap, so reset list items to normal wrapping and
  // give the markers room; ordered vs unordered pick their own marker glyph.
  ".cm-typst-body-list": {
    margin: "0.15em 0",
    paddingLeft: "1.6em",
    whiteSpace: "normal",
  },
  ".cm-typst-body-list li": {
    margin: "0.1em 0",
  },
  "ol.cm-typst-body-list": {
    listStyleType: "decimal",
  },
  "ul.cm-typst-body-list": {
    listStyleType: "disc",
  },
  ".cm-typst-codeblock": {
    fontFamily: "var(--editor-font-mono, monospace)",
    backgroundColor: "var(--bg-secondary)",
    border: "1px solid var(--border-subtle)",
    borderRadius: "6px",
    padding: "0",
    margin: "4px 0",
    display: "block",
    overflow: "hidden",
  },
  ".cm-typst-codeblock-header": {
    display: "flex",
    alignItems: "center",
    justifyContent: "space-between",
    gap: "6px",
    padding: "2px 6px 2px 10px",
    borderBottom: "1px solid var(--border-subtle)",
    backgroundColor: "var(--bg-hover)",
    minHeight: "22px",
  },
  ".cm-typst-codeblock-lang": {
    fontSize: "0.75em",
    color: "var(--fg-dim)",
    fontFamily: "var(--editor-font-mono, monospace)",
  },
  ".cm-typst-codeblock-copy": {
    display: "inline-flex",
    alignItems: "center",
    justifyContent: "center",
    width: "22px",
    height: "22px",
    padding: "0",
    border: "none",
    borderRadius: "4px",
    background: "transparent",
    color: "var(--fg-dim)",
    cursor: "pointer",
    transition: "background-color 0.12s, color 0.12s",
    fontFamily: "inherit",
  },
  ".cm-typst-codeblock-copy:hover": {
    backgroundColor: "var(--bg-tertiary, var(--bg-secondary))",
    color: "var(--fg-primary)",
  },
  ".cm-typst-codeblock-copy.is-copied": {
    color: "var(--accent-color, #1D7874)",
  },
  ".cm-typst-codeblock pre": {
    margin: "0",
    padding: "8px 10px",
    // Wrap long lines inside the box rather than letting them run past the
    // rounded right edge. A notes editor favours always-visible content over
    // a horizontal scrollbar; `pre-wrap` keeps the source's own line breaks
    // and indentation while folding overlong lines back into the box.
    maxWidth: "100%",
    overflowX: "hidden",
    fontSize: "0.9em",
    lineHeight: "1.5",
    fontFamily: "inherit",
  },
  ".cm-typst-codeblock code": {
    fontFamily: "inherit",
    display: "block",
    whiteSpace: "pre-wrap",
    overflowWrap: "anywhere",
  },
  // Edit-mode lines: when the cursor enters the code block we show the raw
  // source instead of the widget. Just the monospace font + a tighter size;
  // no surrounding frame, since the visible delimiters (` ``` `) already
  // mark the block boundaries while editing.
  ".cm-typst-codeblock-edit": {
    fontFamily: "var(--editor-font-mono, monospace) !important",
    fontSize: "0.9em",
  },
  ".cm-typst-block-pill-row": {
    display: "flex",
    alignItems: "center",
    gap: "6px",
    padding: "1px 0",
    margin: "0",
    lineHeight: "1.4",
  },
  // Collapsed document-style preamble chip: reuses the standard pill chrome
  // (.cm-typst-pill); only the trailing rule-count needs its own muted style.
  ".cm-typst-style-preamble-count": {
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
  ".cm-typst-callout-block": {
    display: "block",
    position: "relative",
    margin: "0",
  },
  ".cm-typst-blockquote-block": {
    display: "block",
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
    borderRadius: "4px",
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
  // Inline-block wrapper around the preview <img> so the resize handle can be
  // anchored to the image's own box (not the full-width block) and the parent's
  // text-align still controls left/centre/right placement.
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
    margin: "4px 0",
  },
  ".cm-typst-media-video": {
    maxWidth: "100%",
    maxHeight: "50vh",
    borderRadius: "4px",
    display: "block",
    margin: "0 auto",
  },
  ".cm-typst-media-audio": {
    width: "100%",
    display: "block",
  },
  ".cm-typst-tag": {
    display: "inline-block",
    backgroundColor: "var(--accent-purple-bg)",
    color: "var(--accent-text)",
    borderRadius: "3px",
    padding: "1px 6px",
    fontSize: "0.85em",
    cursor: "pointer",
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
    borderRadius: "3px",
    padding: "0 5px",
    fontSize: "0.8em",
  },
  ".cm-typst-due": {
    display: "inline-block",
    backgroundColor: "var(--accent-purple-bg)",
    color: "var(--accent-text)",
    borderRadius: "3px",
    padding: "1px 6px",
    fontSize: "0.85em",
  },
  // Inline #suggestion(...) marks. Colours match lib.typ's _suggestion-*-color
  // (green #16a34a / red #dc2626) so the visual editor reads like the compiled
  // CriticMarkup idiom rather than the app's theme green/red.
  ".cm-typst-suggestion": {
    cursor: "pointer",
  },
  ".cm-suggestion-ins": {
    color: "#16a34a",
    textDecoration: "underline",
  },
  ".cm-suggestion-del": {
    color: "#dc2626",
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
  ".cm-typst-wikilink.cm-typst-highlight": {
    backgroundColor: "var(--bg-search-match)",
    borderRadius: "2px",
    padding: "0 2px",
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
  ".cm-typst-blockquote": {
    display: "block",
    borderLeft: "3px solid var(--border-primary)",
    padding: "8px 16px",
    margin: "8px 0",
    fontStyle: "italic",
    color: "var(--fg-muted)",
  },
  ".cm-typst-blockquote-text": {
    lineHeight: "1.6",
  },
  ".cm-typst-blockquote-attr": {
    marginTop: "4px",
    fontSize: "0.9em",
    fontStyle: "normal",
    color: "var(--fg-dim)",
  },
  // Editing state for a block quote. The line decoration carries only the bar
  // + inset (geometry that's safe to apply to a whole line); the italic/muted
  // fill is a separate mark bounded to the body, so text trailing after the
  // closing `]` on the same line keeps its ordinary style. (13px left padding
  // + 3px border ≈ the rendered widget's 16px inset.)
  ".cm-typst-blockquote-line": {
    borderLeft: "3px solid var(--border-primary)",
    paddingLeft: "13px",
  },
  ".cm-typst-blockquote-body": {
    fontStyle: "italic",
    color: "var(--fg-muted)",
  },
  // Editing state for a callout — the kind's accent colour for the bar is set
  // per-line inline; the faint tint is a body-bounded mark (also inline), again
  // so trailing text after `]` isn't swept into the callout's styling.
  ".cm-typst-callout-line": {
    borderLeft: "3px solid var(--accent)",
    paddingLeft: "13px",
  },
  // ── Pills (R1–R3) ──
  // Single visual identity for every pill in the visual editor. Inline,
  // block-row, and embedded sites all use this class. See
  // documentation/developer/visual-editor/pill-system.md.
  // .cm-typst-func-chip is kept as an alias so legacy call sites that
  // still reference it pick up the same styles during the staged rollout.
  ".cm-typst-pill, .cm-typst-func-chip": {
    display: "inline-flex",
    alignItems: "center",
    gap: "3px",
    backgroundColor: "var(--bg-secondary)",
    border: "1px solid var(--border-subtle)",
    borderRadius: "12px",
    padding: "1px 6px 1px 3px",
    color: "var(--fg-muted)",
    cursor: "pointer",
    verticalAlign: "middle",
    userSelect: "none",
    // Reset native button visuals so a <button> matches a <span>.
    font: "inherit",
    fontSize: "0.78em",
    fontFamily: "var(--editor-font-mono, monospace)",
    lineHeight: "1.4",
    margin: "0",
  },
  ".cm-typst-pill:hover, .cm-typst-func-chip:hover, .cm-typst-pill:focus-visible, .cm-typst-func-chip:focus-visible": {
    color: "var(--fg-primary)",
    borderColor: "var(--accent)",
    outline: "none",
  },
  ".cm-typst-pill-hash, .cm-typst-func-chip-hash": {
    display: "inline-flex",
    alignItems: "center",
    justifyContent: "center",
    width: "1.15em",
    height: "1.15em",
    borderRadius: "50%",
    backgroundColor: "var(--accent, #1D7874)",
    color: "var(--pill-fg, #fff)",
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
    backgroundColor: "var(--popup-border-color)",
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
    borderRadius: "3px",
  },
  ".cm-typst-pill-menu-input:focus": {
    outline: "none",
    borderColor: "var(--accent)",
  },
  ".cm-typst-citation": {
    display: "inline-block",
    backgroundColor: "var(--bg-secondary)",
    color: "var(--syntax-type)",
    borderRadius: "3px",
    padding: "1px 5px",
    fontSize: "0.9em",
    fontFamily: "var(--editor-font-mono, monospace)",
  },
  // ── Verse ──
  // First-class verse element: an open canvas, not a code-block. The
  // pill at top-left identifies it and exposes alignment options; the
  // canvas itself is contentEditable with inline formatting rendered.
  ".cm-typst-verse": {
    display: "block",
    position: "relative",
    margin: "10px 0",
    padding: "0",
    // Subtle dotted top/bottom rules demark the verse region without
    // making it feel boxed-in. Pill at top-left identifies it.
    borderTop: "2px dotted var(--border-subtle)",
    borderBottom: "2px dotted var(--border-subtle)",
    // Precedence: explicit verse font → user's editor font (runtime) →
    // static editor-body default. `--md-body-font` must come before the
    // static `--editor-font-body` so verse honors the editor-font
    // setting when no verse-specific font is chosen.
    "--verse-active-font": "var(--verse-font, var(--md-body-font, var(--editor-font-body, serif)))",
  },
  // Verse uses the standard .cm-typst-pill class (R1). The verse-specific
  // rule only sets positioning so the pill anchors to the canvas's
  // top-left corner; sizing/colors come from the unified pill rule above.
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
    backgroundColor: "var(--highlight-bg, #fff3a3)",
    color: "inherit",
    padding: "0 2px",
    borderRadius: "2px",
  },
  // (Verse alignment popover replaced by the universal pill super-menu.
  // Verse alignment options now live as a section in that menu — see
  // VerseWidget.buildOptionSections in widgets.ts.)
  // ── Table widget ──
  ".cm-typst-table-wrap": {
    display: "block",
    position: "relative",
    margin: "8px 0",
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

  // ── Editable cell ──
  ".cm-typst-table-cell": {
    minHeight: "1.6em",
    padding: "4px 8px",
    outline: "none",
    lineHeight: "1.5",
    cursor: "default",
    "-webkit-user-select": "text",
    userSelect: "text",
    whiteSpace: "pre-wrap",
    wordBreak: "break-word",
  },
  ".cm-typst-table-cell:focus, .cm-typst-table-cell.cm-typst-table-cell--editing": {
    boxShadow: "inset 0 0 0 2px var(--accent)",
    cursor: "text",
  },
  // WebKitGTK honours only `background-color` (not the `background`
  // shorthand) inside `::selection`; using the shorthand left cell text with
  // the browser-default blue selection instead of the app's accent tint.
  ".cm-typst-table-cell::selection, .cm-typst-table-cell *::selection": {
    backgroundColor: "var(--bg-selection, Highlight)",
    color: "inherit",
  },
  ".cm-typst-table-cell--selected": {
    backgroundColor: "var(--bg-search-match, rgba(59, 130, 246, 0.15))",
  },

  // ── Column/row selection highlight ──
  ".cm-table-col--selected": {
    backgroundColor: "rgba(59, 130, 246, 0.08)",
    boxShadow: "inset 0 0 0 1.5px var(--accent)",
  },
  ".cm-table-row--selected": {
    backgroundColor: "rgba(59, 130, 246, 0.08)",
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
    borderRadius: "2px",
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
    borderRadius: "2px",
  },
  ".cm-table-col-handle:hover, .cm-table-row-handle:hover": {
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
  // Thin draggable lines pinned over each column's right edge and each row's
  // bottom edge (positioned by setupResize). The hit target is wider than
  // the visible line via content-box background clipping, so the 2px line
  // stays crisp while remaining easy to grab.
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
  ".cm-table-resize-handle--row": {
    height: "7px",
    marginTop: "-3.5px",
    padding: "2.5px 0",
    cursor: "row-resize",
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
  ".cm-table-resize-handle--row.cm-table-resize-handle--active": {
    padding: "2px 0",
    boxShadow: "0 0 3px var(--accent)",
  },
  // The column/row whose edge is being dragged is tinted for the duration.
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
    color: "var(--warn-fg, #d97706)",
    cursor: "pointer",
    verticalAlign: "middle",
    marginRight: "2px",
    userSelect: "none",
    borderRadius: "3px",
    backgroundColor: "var(--warn-bg-alpha, color-mix(in srgb, #d97706 12%, transparent))",
  },

  // Context menu styles are inline — the menu is appended to document.body
  // which is outside the CM6 editor, so theme-scoped CSS doesn't apply.
});
