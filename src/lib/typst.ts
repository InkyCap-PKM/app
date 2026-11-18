// Helpers for writing and reading Typst source from TypeScript.
//
// Typst strings (`"..."`) use Rust-style escapes: backslash and double quote
// are escaped, and control characters use `\n` / `\r` / `\t`. Any user-derived
// value put into a `"..."` literal must go through `typstStringEscape`, or a
// quote in an alias, heading or file name breaks the Typst.

export function typstStringEscape(s: string): string {
  return s
    .replace(/\\/g, "\\\\")
    .replace(/"/g, '\\"')
    .replace(/\n/g, "\\n")
    .replace(/\r/g, "\\r")
    .replace(/\t/g, "\\t");
}

/** The text a Typst string literal's body stands for (what sits between its
 *  quotes): the reverse of `typstStringEscape`, plus `\u{…}` escapes. An
 *  escape Typst doesn't know is kept as written. */
export function typstStringUnescape(s: string): string {
  return s.replace(/\\(?:u\{([0-9a-fA-F]{1,6})\}|([\s\S]))/g, (whole, hex?: string, ch?: string) => {
    if (hex !== undefined) {
      const code = parseInt(hex, 16);
      return code <= 0x10ffff ? String.fromCodePoint(code) : whole;
    }
    switch (ch) {
      case "n": return "\n";
      case "r": return "\r";
      case "t": return "\t";
      case "\\":
      case '"': return ch;
      default: return whole;
    }
  });
}

/** The first argument of a call's source (`#wikilink("A \"B\"")`) when it is
 *  a string literal, unescaped (`A "B"`), or null. */
export function extractFirstStringArg(callText: string): string | null {
  const m = callText.match(/\(\s*"((?:[^"\\]|\\.)*)"/);
  return m ? typstStringUnescape(m[1]) : null;
}

/** Characters Typst markup always reads as syntax. */
const MARKUP_SPECIAL = new Set(["\\", "#", "[", "]", "$", "~", "'", '"', "<", "@", "*"]);
/** Characters that open a list, heading or term item when followed by a space. */
const MARKUP_MARKERS = new Set(["=", "+", "-", "/"]);
const WORD_CHAR = /[\p{L}\p{N}]/u;

/**
 * Escape a single word (no whitespace) so Typst markup shows it exactly as
 * written, such as a pasted address. Each character that markup would read as
 * syntax gets a backslash: code, maths, labels, references, brackets, smart
 * quotes, emphasis, comment marks (`//`, `/*` and the closing star-slash),
 * and the `--`, `-?`, `-1`, `...` and `~` shorthands. A marker character at
 * the end is escaped too, since a space may follow it in the note.
 */
export function typstMarkupEscape(word: string): string {
  const chars = [...word];
  let out = "";
  chars.forEach((c, i) => {
    const prev = chars[i - 1];
    const next = chars[i + 1];
    const escape =
      MARKUP_SPECIAL.has(c) ||
      (c === "_" && !(WORD_CHAR.test(prev ?? "") && WORD_CHAR.test(next ?? ""))) ||
      (c === "/" && (next === "/" || next === "*")) ||
      (c === "-" && (next === "-" || next === "?" || /\p{N}/u.test(next ?? ""))) ||
      (c === "." && next === "." && chars[i + 2] === ".") ||
      (next === undefined && MARKUP_MARKERS.has(c));
    out += escape ? `\\${c}` : c;
  });
  return out;
}

/// Characters not allowed in an alias: the comma separates aliases in the
/// property editor, and quotes, backslashes and newlines would break the Typst
/// written.
const ALIAS_FORBIDDEN = /[",\\\n\r\t]/g;

/// Strip characters that aren't allowed inside an alias string.
/// Use during input commit, not on every keystroke.
export function sanitizeAlias(s: string): string {
  return s.replace(ALIAS_FORBIDDEN, "").trim();
}
