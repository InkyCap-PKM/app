// Finds a Typst label definition in source text, without DOM or CodeMirror so
// it can be tested alone. widgets.ts uses it so clicking `#link(<label>)` goes
// to the element the label tags, not to a reference to it.

/**
 * Offset of the `<label>` definition, the anchor tagging an element (e.g. `=
 * Heading <intro>`), or -1 if none.
 *
 * Function arguments are skipped: a reference like `#link(<intro>)` or
 * `#ref(<intro>)` has the same `<intro>` text but follows `(` or `,` (ignoring
 * spaces), and jumping there would land inside the clicked link. A definition
 * tags what's before it, so its `<` follows a letter, `]`, `)`, a newline and
 * so on.
 */
export function findLabelDefinition(doc: string, label: string): number {
  const needle = `<${label}>`;
  let from = 0;
  for (;;) {
    const idx = doc.indexOf(needle, from);
    if (idx < 0) return -1;
    // Char immediately before the `<`, skipping inline spaces/tabs (a label
    // sits on the same line as the content it tags).
    let j = idx - 1;
    while (j >= 0 && (doc[j] === " " || doc[j] === "\t")) j--;
    const prev = j >= 0 ? doc[j] : "";
    if (prev !== "(" && prev !== ",") return idx;
    from = idx + needle.length;
  }
}
