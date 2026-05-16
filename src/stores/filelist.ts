// Flattened file list derived from the file tree.
// Used by quick-open for fuzzy searching.

import { createSignal } from "solid-js";
import type { FileTreeNode } from "../lib/types";

export interface FileEntry {
  path: string;
  name: string;
  /** Folder path relative to notebox root, for display. */
  folder: string;
}

const [fileList, setFileList] = createSignal<FileEntry[]>([]);

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
        });
      }
    }
  }

  walk(tree, basePath);
  setFileList(entries);
}

export { fileList };
