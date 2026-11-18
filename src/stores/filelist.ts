// Flattened file list derived from the file tree.
// Used by quick-open for fuzzy searching.

import { createSignal } from "solid-js";
import { pathEquals, pathStartsWith } from "../lib/paths";
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

/**
 * The folder at `dirPath`, as its chain of names from the notebox root (`2
 * Box/Drafts`), found by walking the tree. Doesn't depend on how the notebox
 * root is spelled, which can differ from the tree's paths (a notebox opened
 * through a symlink). `null` if the folder isn't in the tree.
 */
export function treeFolderPath(tree: FileTreeNode[], dirPath: string): string | null {
  for (const node of tree) {
    if (!node.is_dir) continue;
    if (pathEquals(node.path, dirPath)) return node.name;
    if (node.children && pathStartsWith(dirPath, node.path)) {
      const rest = treeFolderPath(node.children, dirPath);
      if (rest !== null) return `${node.name}/${rest}`;
    }
  }
  return null;
}

export { fileList };
