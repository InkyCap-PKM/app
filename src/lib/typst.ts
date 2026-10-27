// Helpers for writing Typst source from TypeScript.
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

/// Characters not allowed in an alias: the comma separates aliases in the
/// property editor, and quotes, backslashes and newlines would break the Typst
/// written.
const ALIAS_FORBIDDEN = /[",\\\n\r\t]/g;

/// Strip characters that aren't allowed inside an alias string.
/// Use during input commit, not on every keystroke.
export function sanitizeAlias(s: string): string {
  return s.replace(ALIAS_FORBIDDEN, "").trim();
}
