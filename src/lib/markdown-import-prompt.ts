// Shared "Convert Markdown to Typst?" chooser, used by every gesture that can
// bring a `.md` file into the notebox (the file tree's "Copy into notebox" and
// external drag-drop). A markdown file is a note, not an attachment, so we ask
// the user — once per operation — whether to run the markdown→Typst conversion
// or keep the file as-is. The header ✕, Esc, and backdrop all cancel.

import { promptChoice } from "../stores/prompt";
import { t, tPlural } from "./i18n";

/** Outcome of {@link askMarkdownImport}. */
export type MarkdownImportChoice = "convert" | "keep" | "cancel";

/**
 * Ask whether to convert the selected markdown file(s) to Typst. `names` is the
 * markdown filenames in the current operation (used to phrase the prompt); when
 * a single file is involved its name is shown. Returns `"cancel"` if the user
 * dismisses the modal, in which case the caller should abort the whole import.
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
