// Pure parser for the body string of a rendered block element (callout, quote,
// annotation). It splits the text into plain runs and recognized inline notebox
// primitives so the (cursor-away, read-only) block widget can render a task as a
// checkbox, a tag as a pill, etc., instead of dumping raw Typst source.
//
// This is deliberately dependency-free (no DOM, no Tauri) so it is unit-testable
// in isolation; widgets.ts turns these segments into DOM.

// `start` is the offset of the segment within the parsed body string. Callers
// that know where the body begins in the document (the block widgets) add it to
// `start` to recover a call's absolute source position — needed to make an
// inline task's checkbox toggle the right `#task(...)` call.
export type BodySegment =
  | { kind: "text"; start: number; text: string }
  | { kind: "wikilink"; start: number; target: string; display: string }
  | { kind: "tag"; start: number; name: string }
  | { kind: "link"; start: number; url: string; display: string }
  | { kind: "task"; start: number; body: string; done: boolean; due: string | null }
  // Inline formatting wrapper (`*bold*`, `_italic_`, `#highlight[…]`, …). `children`
  // are parsed recursively so nested markup renders; `className` is the CSS mark
  // class the widget applies, matching the live-editor inline decorations.
  | { kind: "format"; start: number; className: string; children: BodySegment[] }
  // Raw/code span — rendered verbatim, never re-parsed. `block` is true for a
  // fenced block (``` ```lang … ``` ```), false for inline (`` `code` ``).
  | { kind: "raw"; start: number; text: string; block: boolean }
  // A block-level list. `ordered` is true for `+ ` markers (numbered), false
  // for `- ` (bulleted). Each item holds its content parsed inline, so markup
  // and inline funcs inside a list item still render.
  | { kind: "list"; start: number; ordered: boolean; items: BodySegment[][] };

// Inline funcs we lift out of the raw body as their own semantic element.
// Anything else stays plain text.
const RENDERABLE_INLINE_FUNCS = new Set(["wikilink", "task", "tag", "link"]);

// Typst content-bracket formatting helpers → the CSS mark class the block
// widget paints their body with. These mirror the live-editor inline marks in
// visual-plugin.ts so a `#highlight[…]` inside a callout looks identical to one
// in flowing text. Their body is recursed into, so `#strong[a _b_]` nests.
const FORMAT_FUNCS: Record<string, string> = {
  strong: "cm-typst-bold",
  emph: "cm-typst-italic",
  highlight: "cm-typst-highlight",
  strike: "cm-typst-strike",
  underline: "cm-typst-underline-mark",
  overline: "cm-typst-overline-mark",
  sub: "cm-typst-sub",
  super: "cm-typst-sup",
};

const isWordChar = (ch: string | undefined): boolean => ch !== undefined && /[\p{L}\p{N}]/u.test(ch);
const isSpace = (ch: string | undefined): boolean => ch !== undefined && /\s/.test(ch);

/** Index of the delimiter that closes the `openCh` at `open`, respecting string
 *  literals; -1 if unbalanced. */
function matchDelim(text: string, open: number, openCh: string, closeCh: string): number {
  let depth = 0;
  let inStr = false;
  for (let i = open; i < text.length; i++) {
    const ch = text[i];
    if (ch === '"' && text[i - 1] !== "\\") inStr = !inStr;
    else if (!inStr && ch === openCh) depth++;
    else if (!inStr && ch === closeCh) { depth--; if (depth === 0) return i; }
  }
  return -1;
}

/** First positional string argument in an arg list like `"x", done: true`. */
function firstStringArg(args: string): string | null {
  const m = args.match(/^\s*"((?:[^"\\]|\\.)*)"/);
  return m ? m[1].replace(/\\"/g, '"') : null;
}

/** Named string argument (`name: "value"`). */
function namedStringArg(args: string, name: string): string | null {
  const re = new RegExp(`\\b${name}\\s*:\\s*"((?:[^"\\\\]|\\\\.)*)"`);
  const m = args.match(re);
  return m ? m[1].replace(/\\"/g, '"') : null;
}

/** Turn one recognized inline func call into a segment, or null if its
 *  arguments don't parse (caller keeps it as raw text). */
function segmentForFunc(name: string, start: number, args: string, content: string | null): BodySegment | null {
  switch (name) {
    case "wikilink": {
      const target = firstStringArg(args);
      if (target === null) return null;
      return { kind: "wikilink", start, target, display: namedStringArg(args, "display") || target };
    }
    case "tag": {
      const tagName = firstStringArg(args);
      if (tagName === null) return null;
      return { kind: "tag", start, name: tagName };
    }
    case "link": {
      const url = firstStringArg(args);
      if (url === null) return null;
      return { kind: "link", start, url, display: content || url };
    }
    case "task": {
      const body = firstStringArg(args);
      if (body === null) return null;
      return {
        kind: "task",
        start,
        body,
        done: /\bdone\s*:\s*true\b/.test(args),
        due: namedStringArg(args, "due"),
      };
    }
    default:
      return null;
  }
}

/** Find the index of the marker `ch` that closes an emphasis run opened just
 *  before `from`, or -1 if there's no valid closer in `[from, to)`. A closer
 *  may not be escaped or follow whitespace (Typst's rule: `* x *` is not a run).
 */
function findEmphasisClose(text: string, from: number, to: number, ch: string): number {
  for (let i = from; i < to; i++) {
    if (text[i] === "\\") { i++; continue; }
    if (text[i] === ch && !isSpace(text[i - 1])) return i;
  }
  return -1;
}

/** Parse a `#name(...)?[...]?` call beginning at `hashAt`. On success pushes the
 *  resulting segment (after flushing pending plain text) and returns the index
 *  just past the call; returns -1 when it is not a call we render, so the caller
 *  leaves it as plain text. */
function tryParseFunc(
  text: string,
  hashAt: number,
  to: number,
  segments: BodySegment[],
  flushPlain: (end: number) => void,
): number {
  const m = /^#([a-zA-Z][\w-]*)/.exec(text.slice(hashAt, to));
  if (!m) return -1;
  const name = m[1];
  let cursor = hashAt + m[0].length;

  let args = "";
  if (text[cursor] === "(") {
    const close = matchDelim(text, cursor, "(", ")");
    if (close < 0 || close >= to) return -1;
    args = text.slice(cursor + 1, close);
    cursor = close + 1;
  }

  let contentFrom = -1;
  let contentTo = -1;
  if (text[cursor] === "[") {
    const close = matchDelim(text, cursor, "[", "]");
    if (close < 0 || close >= to) return -1;
    contentFrom = cursor + 1;
    contentTo = close;
    cursor = close + 1;
  }

  // Interactive notebox primitives render as their own semantic element.
  if (RENDERABLE_INLINE_FUNCS.has(name)) {
    const content = contentFrom >= 0 ? text.slice(contentFrom, contentTo) : null;
    const seg = segmentForFunc(name, hashAt, args, content);
    if (!seg) return -1;
    flushPlain(hashAt);
    segments.push(seg);
    return cursor;
  }

  // Formatting helpers paint their (recursively parsed) body with a mark class.
  const className = FORMAT_FUNCS[name];
  if (className && contentFrom >= 0) {
    flushPlain(hashAt);
    segments.push({
      kind: "format",
      start: hashAt,
      className,
      children: parseSegments(text, contentFrom, contentTo),
    });
    return cursor;
  }

  return -1;
}

/** Parse `[from, to)` of a block body into segments. Plain runs coalesce; inline
 *  funcs, emphasis (`*`/`_`), and raw spans (`` ` ``) become structured segments.
 *  `start` offsets are absolute within the whole body string so an inline task's
 *  checkbox can recover its source position even when nested. */
function parseSegments(text: string, from: number, to: number): BodySegment[] {
  const segments: BodySegment[] = [];
  let plainStart = from;
  let i = from;
  const flushPlain = (end: number) => {
    if (end > plainStart) segments.push({ kind: "text", start: plainStart, text: text.slice(plainStart, end) });
  };

  while (i < to) {
    const ch = text[i];

    // An escape (`\*`, `\#`, …) renders the next char literally — never markup.
    // It stays inside the surrounding text run; the renderer drops the `\`.
    if (ch === "\\") { i += 2; continue; }

    if (ch === "#") {
      const end = tryParseFunc(text, i, to, segments, flushPlain);
      if (end >= 0) { i = end; plainStart = i; continue; }
    }

    // `*bold*` / `_italic_`. Only at a word boundary (so `file_name` and `2 * 3`
    // don't false-trigger), and only with a non-empty, properly-closed run.
    if ((ch === "*" || ch === "_") && !isWordChar(text[i - 1]) && !isSpace(text[i + 1]) && text[i + 1] !== ch) {
      const close = findEmphasisClose(text, i + 1, to, ch);
      if (close > i + 1) {
        flushPlain(i);
        segments.push({
          kind: "format",
          start: i,
          className: ch === "*" ? "cm-typst-bold" : "cm-typst-italic",
          children: parseSegments(text, i + 1, close),
        });
        i = close + 1;
        plainStart = i;
        continue;
      }
    }

    // Raw `` `code` `` / fenced ``` ```lang … ``` ``` — verbatim, not re-parsed.
    // A run of backticks opens a span closed by a run of the same length; 3+
    // backticks is a fenced code block (rendered as a multi-line <pre>).
    if (ch === "`") {
      let n = 1;
      while (i + n < to && text[i + n] === "`") n++;
      const fence = "`".repeat(n);
      const close = text.indexOf(fence, i + n);
      if (close >= 0 && close < to) {
        flushPlain(i);
        let inner = text.slice(i + n, close);
        const block = n >= 3;
        if (block) {
          // Drop the optional leading language token (``` ```typ`) and a single
          // newline framing the block, so only the code shows.
          const nl = inner.indexOf("\n");
          if (nl >= 0 && /^[A-Za-z][\w-]*$/.test(inner.slice(0, nl).trim())) {
            inner = inner.slice(nl + 1);
          }
          inner = inner.replace(/^\n/, "").replace(/\n$/, "");
        }
        segments.push({ kind: "raw", start: i, text: inner, block });
        i = close + n;
        plainStart = i;
        continue;
      }
    }

    i++;
  }
  flushPlain(to);
  return segments;
}

// A list item line: optional indent, a `+` (ordered) or `-` (unordered)
// marker, whitespace, then the item content. Mirrors Typst's own list syntax,
// which only treats `+`/`-` as a list marker at the start of a line.
const LIST_ITEM_RE = /^(\s*)([+-])(\s+)(.*)$/;

/** Split a body into block-level list segments and inline runs. Consecutive
 *  lines beginning with `+ ` (ordered) or `- ` (unordered) coalesce into one
 *  list; everything else is parsed inline by {@link parseSegments}. The
 *  newlines that frame a list block are dropped so the rendered <ol>/<ul>
 *  doesn't leave blank lines in the (pre-wrap) body. */
function parseBlocks(text: string): BodySegment[] {
  const out: BodySegment[] = [];

  // Lines with their absolute start offset; the trailing "\n" is not included.
  const lines: { start: number; text: string }[] = [];
  let pos = 0;
  for (const lineText of text.split("\n")) {
    lines.push({ start: pos, text: lineText });
    pos += lineText.length + 1;
  }

  let runStart = 0; // start of the pending inline run
  const flushInline = (end: number) => {
    if (end > runStart) for (const seg of parseSegments(text, runStart, end)) out.push(seg);
  };

  let i = 0;
  while (i < lines.length) {
    const first = LIST_ITEM_RE.exec(lines[i].text);
    if (!first) { i++; continue; }

    // Close the inline run before the list, dropping the single newline that
    // precedes it so the list isn't rendered after a blank line.
    let inlineEnd = lines[i].start;
    if (inlineEnd > runStart && text[inlineEnd - 1] === "\n") inlineEnd -= 1;
    flushInline(inlineEnd);

    const listStart = lines[i].start;
    const ordered = first[2] === "+";
    const items: BodySegment[][] = [];
    while (i < lines.length) {
      const m = LIST_ITEM_RE.exec(lines[i].text);
      // Stop at a non-list line or a switch between ordered/unordered, so each
      // list stays one type (a `-` after `+` begins a fresh list).
      if (!m || (m[2] === "+") !== ordered) break;
      const contentStart = lines[i].start + m[1].length + m[2].length + m[3].length;
      items.push(parseSegments(text, contentStart, contentStart + m[4].length));
      i++;
    }
    out.push({ kind: "list", start: listStart, ordered, items });

    // Resume after the list, skipping the newline that ended the last item.
    runStart = i < lines.length ? lines[i].start : text.length;
  }
  flushInline(text.length);
  return out;
}

/** Split a block body into segments: block-level lists, plus plain-text and
 *  inline segments (funcs, emphasis, raw). Adjacent text is coalesced. */
export function parseInlineBody(text: string): BodySegment[] {
  return parseBlocks(text);
}
