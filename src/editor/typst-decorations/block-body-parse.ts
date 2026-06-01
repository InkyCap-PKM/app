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
  | { kind: "task"; start: number; body: string; done: boolean; due: string | null };

// Inline funcs we lift out of the raw body. Anything else stays plain text.
const RENDERABLE_INLINE_FUNCS = new Set(["wikilink", "task", "tag", "link"]);

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

/** Split a block body into plain-text and inline-primitive segments. Adjacent
 *  text is coalesced into single `text` segments. */
export function parseInlineBody(text: string): BodySegment[] {
  const segments: BodySegment[] = [];
  let i = 0;
  let plainStart = 0;
  const flushPlain = (end: number) => {
    if (end > plainStart) segments.push({ kind: "text", start: plainStart, text: text.slice(plainStart, end) });
  };
  while (i < text.length) {
    if (text[i] === "#") {
      const m = /^#([a-zA-Z][\w-]*)\(/.exec(text.slice(i));
      if (m && RENDERABLE_INLINE_FUNCS.has(m[1])) {
        const parenOpen = i + m[0].length - 1; // index of `(`
        const parenClose = matchDelim(text, parenOpen, "(", ")");
        if (parenClose >= 0) {
          const args = text.slice(parenOpen + 1, parenClose);
          // Optional trailing `[content]` (e.g. `#link("url")[label]`).
          let content: string | null = null;
          let end = parenClose + 1;
          if (text[end] === "[") {
            const bracketClose = matchDelim(text, end, "[", "]");
            if (bracketClose >= 0) { content = text.slice(end + 1, bracketClose); end = bracketClose + 1; }
          }
          const seg = segmentForFunc(m[1], i, args, content);
          if (seg) {
            flushPlain(i);
            segments.push(seg);
            i = end;
            plainStart = i;
            continue;
          }
        }
      }
    }
    i++;
  }
  flushPlain(text.length);
  return segments;
}
