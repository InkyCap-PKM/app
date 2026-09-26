// Brings files from outside the notebox into it: the file tree's "Copy into
// notebox", files dropped on the file tree, and files dropped into the editor
// all go through here so they behave the same way. Markdown files can be
// converted to Typst notes (the user is asked once per batch), everything else
// is copied, and copied Typst files are checked for the InkyCap import line.
// Where each file lands is decided by the backend from the `placement` given
// (see `IncomingPlacement` in ipc.ts).

import { toastError, toastSuccess } from "../stores/toasts";
import { askMarkdownImport } from "./markdown-import-prompt";
import { ensureNoteboxImports } from "./notebox-import-check";
import { fileToBase64 } from "./file-bytes";
import { t } from "./i18n";
import * as ipc from "./ipc";

/** A file arriving from outside the notebox: either a filesystem path the
 *  backend is allowed to read (authorized by a native drop or the file
 *  picker), or the file's contents (Windows drag and drop hands over contents,
 *  not paths). */
export type IncomingFile = { name: string; path: string } | { name: string; file: File };

/** An incoming file for a filesystem path, named after the path's last part. */
export function incomingFromPath(path: string): IncomingFile {
  return { name: path.split(/[/\\]/).pop() ?? path, path };
}

const isMarkdown = (name: string) => /\.(md|markdown)$/i.test(name);

/**
 * Copy (or convert) `files` into the notebox and resolve with the saved
 * notebox-relative paths, in order, leaving out any that failed. Resolves
 * `null` if the user cancelled the "Convert Markdown?" question. With
 * `announce`, a toast summarizes what was brought in.
 */
export async function bringFilesIntoNotebox(
  files: IncomingFile[],
  placement: ipc.IncomingPlacement,
  options: { announce?: boolean } = {},
): Promise<string[] | null> {
  const markdown = files.filter((f) => isMarkdown(f.name));
  let convertMarkdown = false;
  if (markdown.length > 0) {
    const choice = await askMarkdownImport(markdown.map((f) => f.name));
    if (choice === "cancel") return null;
    convertMarkdown = choice === "convert";
  }

  const saved: string[] = [];
  const copied: string[] = [];
  let notes = 0;
  for (const f of files) {
    const convert = convertMarkdown && isMarkdown(f.name);
    try {
      let rel: string;
      if ("path" in f) {
        rel = convert
          ? await ipc.importMarkdownFile(f.path, placement)
          : await ipc.copyPathIntoNotebox(f.path, placement);
      } else {
        const base64 = await fileToBase64(f.file);
        rel = convert
          ? await ipc.importMarkdownText(f.name, base64, placement)
          : await ipc.copyBytesIntoNotebox(f.name, base64, placement);
      }
      saved.push(rel);
      if (convert) notes += 1;
      else copied.push(rel);
    } catch (e) {
      toastError(t("leftSidebar.uploadFailed"), e);
    }
  }

  if (options.announce) announce(saved, notes);
  // Converted notes already carry the import; copied Typst files may not.
  await ensureNoteboxImports(copied);
  return saved;
}

/** Summarize the outcome: the note phrasing when Markdown was converted (the
 *  headline outcome of a mixed batch), else the copied-file phrasing. */
function announce(saved: string[], notes: number): void {
  const lastName = saved.length > 0 ? (saved[saved.length - 1].split("/").pop() ?? "") : "";
  if (notes > 0) {
    toastSuccess(
      notes === 1
        ? t("leftSidebar.importedNoteOne", { name: lastName })
        : t("leftSidebar.importedNoteMany", { count: notes }),
    );
  } else if (saved.length > 0) {
    toastSuccess(
      saved.length === 1
        ? t("leftSidebar.uploadedOne", { name: lastName })
        : t("leftSidebar.uploadedMany", { count: saved.length }),
    );
  }
}
