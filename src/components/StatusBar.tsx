import { Component, Show, For, createSignal, createMemo } from "solid-js";
import { ArchiveRestore, Archive, Check, TextCursorInput, MessageSquareCheck } from "lucide-solid";
import { noteboxInfo, noteboxRegistry, openNotebox } from "../stores/notebox";
import { wordCountStats } from "../editor/typst-decorations/word-count";
import { getActiveTab, renameTabPath } from "../stores/tabs";
import * as ipc from "../lib/ipc";
import { normalizePath, pathEquals } from "../lib/paths";
import { toastError } from "../stores/toasts";
import { pendingReviewCount, revealPendingReview } from "../stores/collab";

const StatusBar: Component = () => {
  const isFileTab = () => getActiveTab()?.type === "file";
  const stats = wordCountStats;

  const displayName = createMemo(() => {
    const info = noteboxInfo();
    if (!info) return null;
    const entry = noteboxRegistry().find((e) => pathEquals(e.path, info.path));
    return entry?.display_name ?? info.name;
  });

  const [switcherMenu, setSwitcherMenu] = createSignal<{
    x: number;
    y: number;
  } | null>(null);

  function toggleSwitcher(e: MouseEvent) {
    e.preventDefault();
    e.stopPropagation();
    if (switcherMenu()) {
      setSwitcherMenu(null);
      return;
    }
    const rect = (e.currentTarget as HTMLElement).getBoundingClientRect();
    const entries = noteboxRegistry();
    const estimatedHeight = (entries.length + 1) * 32 + 12;
    const y = rect.top - estimatedHeight - 4;
    setSwitcherMenu({ x: rect.left, y: Math.max(4, y) });
    setTimeout(() => {
      const onDocClick = () => {
        setSwitcherMenu(null);
        document.removeEventListener("click", onDocClick);
      };
      document.addEventListener("click", onDocClick);
    }, 0);
  }

  /// Notebox-relative path of the current file tab, e.g.
  /// "notes/journal/2026.typ". Returns null if the file lives outside the
  /// notebox root (which shouldn't happen for tabs opened normally) so the
  /// status bar doesn't leak the user's full filesystem layout.
  const activeFilePath = createMemo(() => {
    const tab = getActiveTab();
    if (!tab || tab.type !== "file" || !tab.path) return null;
    const root = noteboxInfo()?.path;
    if (!root) return null;
    // Normalize through the canonical-shape helper so a regression on
    // either side of the IPC boundary (e.g. a stray Windows `\\?\` UNC
    // prefix sneaking in) doesn't silently blank the status bar.
    const tabNorm = normalizePath(tab.path);
    const rootNorm = normalizePath(root);
    const prefix = rootNorm.endsWith("/") ? rootNorm : rootNorm + "/";
    if (tabNorm.startsWith(prefix)) {
      return tabNorm.slice(prefix.length);
    }
    return null;
  });

  // ── Inline rename ──────────────────────────────────────────────────
  // The path display swaps to an <input> in place, so renaming feels
  // continuous with the status-bar instead of popping a modal. The
  // rename icon stays visible as the affordance the user clicks to enter
  // edit mode, and clicking it again (or pressing Enter / blurring)
  // commits the change. Escape cancels without writing anything.
  const [renaming, setRenaming] = createSignal(false);
  const [renameDraft, setRenameDraft] = createSignal("");
  let renameInputRef: HTMLInputElement | undefined;
  // The same blur and click handlers can both try to commit; this guard
  // makes commitRename idempotent so a click-to-confirm followed by the
  // implicit blur doesn't double-fire (which would attempt a second
  // rename against a path that no longer exists).
  let renameSettled = false;

  function startRename() {
    const tab = getActiveTab();
    if (!tab || tab.type !== "file") return;
    const oldName = tab.path.split("/").pop()?.replace(/\.[^.]+$/, "") ?? "";
    renameSettled = false;
    setRenameDraft(oldName);
    setRenaming(true);
    queueMicrotask(() => {
      renameInputRef?.focus();
      renameInputRef?.select();
    });
  }

  function cancelRename() {
    renameSettled = true;
    setRenaming(false);
  }

  async function commitRename() {
    if (renameSettled) return;
    renameSettled = true;
    const tab = getActiveTab();
    setRenaming(false);
    if (!tab || tab.type !== "file") return;
    const oldName = tab.path.split("/").pop()?.replace(/\.[^.]+$/, "") ?? "";
    const newName = renameDraft().trim();
    if (!newName || newName === oldName) return;
    try {
      const oldPath = tab.path;
      const newPath = await ipc.renameAndUpdateLinks(oldPath, newName);
      // `renameTabPath` updates the active tab's path + title in place
      // and migrates the cached editor state and history. The previous
      // close+open dance lost editor state and could race with the file
      // watcher's rename event leaving the tab heading on the old name.
      renameTabPath(oldPath, newPath);
    } catch (err) {
      toastError("Rename failed", err);
    }
  }

  async function switchToNotebox(path: string) {
    setSwitcherMenu(null);
    try {
      await openNotebox(path);
    } catch (err) {
      console.error("Failed to switch notebox:", err);
    }
  }

  function openManageNoteboxes() {
    setSwitcherMenu(null);
    document.dispatchEvent(
      new CustomEvent("inkycap:open-settings", { detail: { tab: "overview" } }),
    );
  }

  return (
    <div class="status-bar">
      <Show when={noteboxInfo()} fallback={<span>No notebox open</span>}>
        {(info) => (
          <>
            <button
              class="status-bar__notebox-name"
              onClick={toggleSwitcher}
              title="Change notebox"
            >
              {displayName()}
              <ArchiveRestore size={14} />
            </button>
            <span>{info().file_count} files</span>
          </>
        )}
      </Show>
      <div class="status-bar__spacer" />

      <Show when={activeFilePath()}>
        {(path) => (
          <span class="status-bar__path" title={path()}>
            <Show
              when={renaming()}
              fallback={
                <>
                  <span class="status-bar__path-text">{path()}</span>
                  <button
                    class="status-bar__path-rename"
                    onClick={startRename}
                    title="Rename file"
                    aria-label="Rename file"
                  >
                    <TextCursorInput size={14} />
                  </button>
                </>
              }
            >
              <input
                ref={renameInputRef}
                class="status-bar__rename-input"
                type="text"
                value={renameDraft()}
                onInput={(e) => setRenameDraft(e.currentTarget.value)}
                onKeyDown={(e) => {
                  if (e.key === "Enter") {
                    e.preventDefault();
                    commitRename();
                  } else if (e.key === "Escape") {
                    e.preventDefault();
                    cancelRename();
                  }
                }}
                onBlur={commitRename}
                aria-label="New file name"
              />
              <button
                class="status-bar__path-rename"
                /* mousedown so the click registers before the input's blur
                   handler fires its own commit — without this, the blur
                   commits first and the button click hits a stale state. */
                onMouseDown={(e) => {
                  e.preventDefault();
                  commitRename();
                }}
                title="Confirm rename"
                aria-label="Confirm rename"
              >
                <TextCursorInput size={14} />
              </button>
            </Show>
          </span>
        )}
      </Show>
      <div class="status-bar__spacer" />

      <Show when={pendingReviewCount() > 0}>
        <button
          class="status-bar__review-badge"
          onClick={() => revealPendingReview()}
          title="Review pending collaboration changes"
        >
          <MessageSquareCheck size={14} />
          {pendingReviewCount()} to review
        </button>
      </Show>

      <Show when={isFileTab()}>
        <span class="status-bar__stat">
          {stats().words} words
        </span>
        <span class="status-bar__stat">
          {stats().chars} chars
        </span>
      </Show>

      <Show when={switcherMenu()}>
        {(menu) => (
          <div
            class="context-menu"
            style={{
              position: "fixed",
              left: `${menu().x}px`,
              top: `${menu().y}px`,
            }}
          >
            <For each={noteboxRegistry()}>
              {(entry) => (
                <button
                  class="context-menu__item"
                  onClick={() => switchToNotebox(entry.path)}
                >
                  <span class="notebox-switcher__name">{entry.display_name}</span>
                  <Show when={pathEquals(entry.path, noteboxInfo()?.path)}>
                    <Check size={14} class="context-menu__check" />
                  </Show>
                </button>
              )}
            </For>
            <div class="context-menu__separator" />
            <button class="context-menu__item" onClick={openManageNoteboxes}>
              <Archive size={14} style={{ "margin-right": "6px", opacity: "0.6", "flex-shrink": "0" }} />
              Manage noteboxes...
            </button>
          </div>
        )}
      </Show>
    </div>
  );
};

export default StatusBar;
