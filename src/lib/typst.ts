// Small helpers for emitting Typst source from TypeScript.
//
// Typst string literals (`"..."`) follow Rust-style escapes: backslash
// and double-quote must be escaped, and control characters need their
// `\n` / `\r` / `\t` forms. Any TypeScript code that interpolates a
// user-derived value into a `"..."` literal must run it through
// `typstStringEscape` first — otherwise an alias, heading, or filename
// containing a quote produces broken Typst.

export function typstStringEscape(s: string): string {
  return s
    .replace(/\\/g, "\\\\")
    .replace(/"/g, '\\"')
    .replace(/\n/g, "\\n")
    .replace(/\r/g, "\\r")
    .replace(/\t/g, "\\t");
}

/// Characters not allowed in an alias. Aliases are simple display strings;
/// the comma is reserved as the user-visible separator in the property
/// editor, and quotes/backslashes/newlines would either break the emitted
/// Typst or escape out of the alias intent.
const ALIAS_FORBIDDEN = /[",\\\n\r\t]/g;

/// Strip characters that aren't allowed inside an alias string.
/// Use during input commit, not on every keystroke.
export function sanitizeAlias(s: string): string {
  return s.replace(ALIAS_FORBIDDEN, "").trim();
}
