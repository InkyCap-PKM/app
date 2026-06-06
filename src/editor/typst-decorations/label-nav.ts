// Pure helper for locating a Typst label *definition* in source text. Kept
// dependency-free (no DOM, no CM) so it is unit-testable in isolation;
// widgets.ts uses it so a `#link(<label>)` click jumps to the element the
// label tags rather than to a reference to it.

/**
 * Byte offset of the `<label>` *definition* — the anchor that tags an element
 * (e.g. `= Heading <intro>`) — or -1 if none is present.
 *
 * Crucially, occurrences that are function-call arguments are skipped: a
 * *reference* like `#link(<intro>)` or `#ref(<intro>)` writes the same
 * `<intro>` text but is preceded (ignoring spaces) by `(` or `,`. Jumping to
 * one of those would land inside the very link that was clicked. A definition
 * instead tags preceding content, so its `<` is preceded by a letter, `]`,
 * `)`, a newline, etc.
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
