// Renders the active folder picker as a dialog. Mounted once at the app root
// and driven by activeFolderPicker in stores/folderPicker.ts (see there for
// usage).
//
// The list is built from the file tree each time it opens, so it shows the
// folders that exist now. Uses the .quick-open__* styles, like Ctrl+O.

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
import { compareName } from "../lib/sort";
import { useI18n } from "../lib/i18n";
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
  const t = useI18n();
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
          // Compare canonical forms when deriving the notebox-relative path, so
          // a separator difference between root and node.path doesn't leave
          // every folder under its top-level name (the `n.name` fallback).
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

      // Leave out what the caller excluded: the folder being moved and its
      // subfolders, and the current folder (moving there does nothing).
      const filtered = entries.filter((e) => {
        if (p.disallowPrefix && pathStartsWith(e.abs, p.disallowPrefix)) {
          return false;
        }
        if (p.currentParent && pathEquals(e.abs, p.currentParent)) return false;
        return true;
      });
      filtered.sort((a, b) => compareName(a.label, b.label));

      // The notebox root comes first, so an item can always be moved to the
      // top, unless the root is already its folder.
      const rootEntry: FolderEntry = { abs: root, rel: "", label: t("folderPicker.noteboxRoot") };
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
              placeholder={p().placeholder ?? t("folderPicker.placeholder")}
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
                <div class="quick-open__empty">{t("folderPicker.noMatch")}</div>
              </Show>
            </div>
            <div class="folder-picker__footer">
              <span>{t("folderPicker.selectHint")}</span>
              <span>{t("folderPicker.moveNowHint")}</span>
              <span>{t("folderPicker.cancelHint")}</span>
            </div>
          </div>
        </div>
      )}
    </Show>
  );
};

export default FolderPickerHost;
