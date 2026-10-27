// "Convert Markdown to Typst?" chooser for every way a `.md` file is brought
// into the notebox (the file tree's "Copy into notebox", dragging in from
// outside). A Markdown file is a note, not an attachment, so the user is asked
// once per operation whether to convert it or keep it as is. ✕, Esc and the
// backdrop cancel.

import { promptChoice } from "../stores/prompt";
import { t, tPlural } from "./i18n";

/** Outcome of {@link askMarkdownImport}. */
export type MarkdownImportChoice = "convert" | "keep" | "cancel";

/**
 * Ask whether to convert the Markdown files to Typst. `names` are the files in
 * this operation (one file's name is shown). Returns `"cancel"` if dismissed;
 * the caller should then stop the whole import.
 */
export async function askMarkdownImport(
  names: string[],
): Promise<MarkdownImportChoice> {
  const count = names.length;
  const message =
    count === 1
      ? tPlural("import.markdown.message", 1, { name: names[0] })
      : tPlural("import.markdown.message", count);
  const id = await promptChoice({
    title: t("import.markdown.title"),
    message,
    // Primary action (Convert) rightmost, matching the app's footer convention.
    options: [
      { id: "keep", label: t("import.markdown.keep"), variant: "secondary" },
      { id: "convert", label: t("import.markdown.convert"), variant: "primary" },
    ],
  });
  return id === null ? "cancel" : (id as "convert" | "keep");
}
