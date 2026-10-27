// Flattened file list derived from the file tree.
// Used by quick-open for fuzzy searching.

import { createSignal } from "solid-js";
import { compareName } from "../lib/sort";
import type { FileTreeNode } from "../lib/types";

export interface FileEntry {
  path: string;
  name: string;
  /** Folder path relative to notebox root, for display. */
  folder: string;
  /** Last-modified time in Unix epoch seconds (0 if the backend couldn't
   *  stat the file). Used by quick-open to surface recently edited notes. */
  modified_time: number;
}

const [fileList, setFileList] = createSignal<FileEntry[]>([]);

/** Whether a file is a note (a `.typ` file) rather than an attachment such as
 *  a PDF or an image. The file list holds both. */
export function isNoteFile(entry: FileEntry): boolean {
  return /\.typ$/i.test(entry.name);
}

/** Flatten a file tree into a flat list of file entries. */
export function buildFileList(tree: FileTreeNode[], basePath = "") {
  const entries: FileEntry[] = [];

  function walk(nodes: FileTreeNode[], folder: string) {
    for (const node of nodes) {
      if (node.is_dir) {
        if (node.children) {
          walk(node.children, folder ? `${folder}/${node.name}` : node.name);
        }
      } else {
        entries.push({
          path: node.path,
          name: node.name,
          folder,
          modified_time: node.modified_time,
        });
      }
    }
  }

  walk(tree, basePath);
  setFileList(entries);
}

/**
 * Every folder holding the notebox's notes, root-relative with `/`, including
 * each level, in natural name order. Derived from the same flat list, so it
 * always matches. Used by the search box to complete `path:` filters.
 */
export function folderPaths(entries: FileEntry[]): string[] {
  const seen = new Set<string>();
  for (const entry of entries) {
    if (!entry.folder) continue;
    const parts = entry.folder.split("/");
    for (let depth = 1; depth <= parts.length; depth++) {
      seen.add(parts.slice(0, depth).join("/"));
    }
  }
  return [...seen].sort(compareName);
}

export { fileList };
