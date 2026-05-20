// Renders the active folder picker (if any) as a styled modal.
// Mounted once at the app root; driven by the activeFolderPicker signal
// in stores/folderPicker.ts. See that file for the call-site contract.
//
// The list is built from the live notebox file tree each time the picker
// opens, so it always reflects folders that currently exist. Reuses the
// .quick-open__* styles for visual consistency with the Ctrl+O switcher.

import {
  Component,
  Show,
  For,
  createSignal,
  createMemo,
  createEffect,
} from "solid-js";
import { activeFolderPicker, resolveFolderPicker } from "../stores/folderPicker";
import { noteboxInfo } from "../stores/notebox";
import * as ipc from "../lib/ipc";
import { normalizePath, pathEquals, pathStartsWith } from "../lib/paths";
import type { FileTreeNode } from "../lib/types";

/** A selectable destination folder. */
interface FolderEntry {
  /** Absolute filesystem path. */
  abs: string;
  /** Notebox-relative path; empty string for the notebox root. */
  rel: string;
  /** Display label ("/" for the root, otherwise the relative path). */
  label: string;
}

const FolderPickerHost: Component = () => {
  const [query, setQuery] = createSignal("");
  const [selectedIndex, setSelectedIndex] = createSignal(0);
  const [folders, setFolders] = createSignal<FolderEntry[]>([]);
  let inputRef: HTMLInputElement | undefined;
  let itemRefs: (HTMLDivElement | undefined)[] = [];

  // Rebuild the folder list every time the picker opens.
  createEffect(() => {
    const p = activeFolderPicker();
    if (!p) return;
    setQuery("");
    setSelectedIndex(0);

    const root = noteboxInfo()?.path ?? "";
    const rootNorm = normalizePath(root);
    ipc.getFileTree().then((tree) => {
      const entries: FolderEntry[] = [];
      const walk = (nodes: FileTreeNode[]) => {
        for (const n of nodes) {
          if (!n.is_dir || n.name === ".inkycap") continue;
          // Derive the notebox-relative path via canonical-shape comparison
          // so a stray separator difference between root and node.path
          // doesn't silently strand every folder under "<top-level name>"
          // (the `n.name` fallback).
          const nodeNorm = normalizePath(n.path);
          const rel =
            nodeNorm.startsWith(rootNorm + "/")
              ? nodeNorm.slice(rootNorm.length + 1)
              : n.name;
          entries.push({ abs: n.path, rel, label: rel });
          if (n.children) walk(n.children);
        }
      };
      walk(tree);

      // Drop folders the caller forbade: the dragged folder itself plus
      // its descendants (can't move into self), and the current parent
      // (moving there would be a no-op).
      const filtered = entries.filter((e) => {
        if (p.disallowPrefix && pathStartsWith(e.abs, p.disallowPrefix)) {
          return false;
        }
        if (p.currentParent && pathEquals(e.abs, p.currentParent)) return false;
        return true;
      });
      filtered.sort((a, b) => a.label.localeCompare(b.label));

      // Pin the notebox root as the first entry so the user can always
      // move an item to the top of the notebox, unless the root itself is
      // the item's current parent (moving there would be a no-op).
      const rootEntry: FolderEntry = { abs: root, rel: "", label: "Notebox root" };
      const showRoot = !pathEquals(p.currentParent, root);
      setFolders(showRoot ? [rootEntry, ...filtered] : filtered);
    });

    queueMicrotask(() => inputRef?.focus());
  });

  // Substring filter over the relative path. Root ("/") always matches
  // an empty query and also a literal "/" query.
  const results = createMemo((): FolderEntry[] => {
    const q = query().trim().toLowerCase();
    if (!q) return folders();
    return folders().filter(
      (f) => f.label.toLowerCase().includes(q),
    );
  });

  // Keep the highlighted row visible as the user arrows through.
  createEffect(() => {
    const idx = selectedIndex();
    itemRefs[idx]?.scrollIntoView({ block: "nearest" });
  });

  function close() {
    resolveFolderPicker(null);
  }

  function commit() {
    const list = results();
    const choice = list[selectedIndex()];
    if (choice) resolveFolderPicker(choice.rel);
  }

  function onKeyDown(e: KeyboardEvent) {
    const list = results();
    if (e.key === "Escape") {
      e.preventDefault();
      close();
    } else if (e.key === "ArrowDown") {
      e.preventDefault();
      setSelectedIndex((i) => Math.min(i + 1, list.length - 1));
    } else if (e.key === "ArrowUp") {
      e.preventDefault();
      setSelectedIndex((i) => Math.max(i - 1, 0));
    } else if (e.key === "Enter") {
      e.preventDefault();
      commit();
    }
  }

  return (
    <Show when={activeFolderPicker()}>
      {(p) => (
        <div
          class="quick-open__overlay"
          onMouseDown={(e) => {
            if (e.target === e.currentTarget) close();
          }}
        >
          <div
            class="quick-open"
            role="dialog"
            aria-modal="true"
            onMouseDown={(e) => e.stopPropagation()}
          >
            <input
              ref={inputRef}
              class="quick-open__input"
              type="text"
              placeholder={p().placeholder ?? "Type to filter and find a folder"}
              value={query()}
              onInput={(e) => {
                setQuery(e.currentTarget.value);
                setSelectedIndex(0);
              }}
              onKeyDown={onKeyDown}
            />
            <div class="quick-open__results">
              <For each={results()}>
                {(folder, index) => (
                  <div
                    ref={(el) => (itemRefs[index()] = el)}
                    class={`quick-open__result ${index() === selectedIndex() ? "quick-open__result--selected" : ""}`}
                    onMouseEnter={() => setSelectedIndex(index())}
                    onClick={() => resolveFolderPicker(folder.rel)}
                  >
                    <span class="quick-open__result-name">{folder.label}</span>
                  </div>
                )}
              </For>
              <Show when={results().length === 0}>
                <div class="quick-open__empty">No matching folders</div>
              </Show>
            </div>
            <div class="folder-picker__footer">
              <span>↑↓ select</span>
              <span>↵ move now</span>
              <span>esc to cancel</span>
            </div>
          </div>
        </div>
      )}
    </Show>
  );
};

export default FolderPickerHost;
