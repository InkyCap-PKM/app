import { Component, Show, For, createSignal, createMemo, createResource } from "solid-js";
import {
  ArchiveRestore,
  Archive,
  Check,
  TextCursorInput,
  Handshake,
  RefreshCw,
  ChevronUp,
  Maximize,
  Minimize,
  SpellCheck,
} from "lucide-solid";
import { TextCountIcon } from "./icons";
import { noteboxInfo, noteboxRegistry, openNotebox } from "../stores/notebox";
import { wordCountStats } from "../editor/typst-decorations/word-count";
import { cursorPosition } from "../editor/typst-decorations/cursor-position";
import { getActiveTab, renameTabPath } from "../stores/tabs";
import * as ipc from "../lib/ipc";
import { normalizePath, pathEquals } from "../lib/paths";
import { toastError } from "../stores/toasts";
import { settings, updateSetting } from "../stores/settings";
import {
  distractionFree,
  toggleDistractionFree,
  statusCountMode,
  toggleStatusCountMode,
} from "../stores/layout";
import { collaborative, gitStatus, gitSyncing, pendingCount, incomingCount } from "../stores/git";
import { t } from "../lib/i18n";

const StatusBar: Component = () => {
  const isFileTab = () => getActiveTab()?.type === "file";
  const stats = wordCountStats;

  // Cursor line:column — shown only in Source Edit mode, where it matches the
  // raw file so the user can jump to a reported error (e.g. the audit's L55:28).
  // In Live/Reading mode the source positions don't line up with what's shown,
  // so it's hidden.
  const sourceCursor = createMemo(() => {
    const tab = getActiveTab();
    if (tab?.type !== "file") return null;
    // Mirror TypstEditor's effective-mode resolution: an explicit per-tab mode,
    // else the global default. Only Source Edit mode shows the readout.
    const mode =
      tab.editingMode ??
      (settings.editor.default_editing_mode === "source" ? "source" : "live");
    if (mode !== "source") return null;
    return cursorPosition();
  });

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

  // ── Spellcheck language switcher ──────────────────────────────────────
  // The chip near the word count shows the active spellcheck language (or Off)
  // and opens an upward menu — like the notebox switcher — to pick a single
  // language, "All" (check against every enabled dictionary), or turn it off.
  const [spellDicts] = createResource(() => ipc.listSpellcheckDictionaries());
  const [spellMenu, setSpellMenu] = createSignal<{ x: number; y: number } | null>(null);

  /** Enabled dictionaries (those checked in Settings → Language), with names. */
  const enabledDicts = createMemo(() => {
    const enabled = settings.editor.spellcheck_languages ?? [];
    const infos = spellDicts() ?? [];
    return enabled.map(
      (code) => infos.find((d) => d.code === code) ?? { code, name: code, bundled: false },
    );
  });

  /** Short 2-letter label for the chip: the active language code, "All", or
   *  "Off". */
  const spellLabel = createMemo(() => {
    if (!settings.editor.spellcheck) return "Off";
    const active = settings.editor.spellcheck_active || "all";
    if (active === "all") return "All";
    return active.slice(0, 2).toUpperCase();
  });

  function setSpellActive(code: string) {
    setSpellMenu(null);
    updateSetting("editor", "spellcheck", true);
    updateSetting("editor", "spellcheck_active", code);
  }

  function turnSpellOff() {
    setSpellMenu(null);
    updateSetting("editor", "spellcheck", false);
  }

  function toggleSpellMenu(e: MouseEvent) {
    e.preventDefault();
    e.stopPropagation();
    if (spellMenu()) {
      setSpellMenu(null);
      return;
    }
    const rect = (e.currentTarget as HTMLElement).getBoundingClientRect();
    // Rows: each enabled language + "All" + separator + "Off".
    const rows = enabledDicts().length + 2;
    const estimatedHeight = rows * 30 + 14;
    setSpellMenu({ x: rect.left, y: Math.max(4, rect.top - estimatedHeight - 4) });
    setTimeout(() => {
      const onDocClick = () => {
        setSpellMenu(null);
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
    // A collaboration-review (staged "Resolve:") tab points at an internal
    // staging path and must not be renamed mid-merge. Hide the path, name, and
    // rename affordance entirely while reviewing — the file identity isn't the
    // user's to change here.
    if (tab.collab) return null;
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

  // Compact git sync summary for the collaborative-notebox chip. Mirrors the
  // panel's status line but terse (status bar real estate is tight).
  const gitSummary = createMemo(() => {
    const s = gitStatus();
    const pending = pendingCount();
    if (pending > 0) return t("git.status.incomingN", { n: pending });
    // A read-only "Check for updates" found incoming commits (status_summary's
    // own `behind` is upstream-tracking-based and often 0 without a fetch).
    if (incomingCount() > 0) return t("git.status.behind", { n: incomingCount() });
    if (!s) return "";
    if (!s.head && !s.dirty) return t("git.status.unborn");
    if (s.behind > 0) return t("git.status.behind", { n: s.behind });
    // Outgoing state is qualitative ("Changes to share") — a commit count
    // misleads (commits ≠ files) and never resets in package mode.
    if (s.unshared) return t("git.status.toShare");
    return t("git.status.synced");
  });

  function openCollaboration() {
    document.dispatchEvent(new CustomEvent("inkycap:open-collaboration"));
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
    <div
      class="status-bar"
      classList={{ "status-bar--distraction-free": distractionFree() }}
    >
      {/* Everything except the distraction-free toggle collapses away in
          distraction-free mode, leaving just the exit button at the edge. */}
      <Show when={!distractionFree()}>
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

      <Show when={collaborative()}>
        <button
          class="status-bar__git"
          classList={{ "status-bar__git--attention": pendingCount() > 0 || incomingCount() > 0 }}
          onClick={openCollaboration}
          title={t("git.toolbar.title")}
        >
          <Show when={gitSyncing()} fallback={<Handshake size={13} />}>
            <RefreshCw size={13} class="status-bar__git-spin" />
          </Show>
          <span>{gitSummary()}</span>
          {/* Trails the summary at the button's right edge; cues that the
              click opens the collaboration pane upward (like the notebox
              switcher above it). */}
          <ChevronUp size={13} class="status-bar__git-chevron" />
        </button>
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

      <Show when={sourceCursor()}>
        {(pos) => (
          <span
            class="status-bar__stat status-bar__cursor"
            title="Cursor line and column"
          >
            L{pos().line}:{pos().col}
          </span>
        )}
      </Show>

      <Show when={isFileTab()}>
        {/* Spellcheck language chip — pick the active language, "All", or Off. */}
        <button
          class="status-bar__spell"
          classList={{ "status-bar__spell--off": !settings.editor.spellcheck }}
          onClick={toggleSpellMenu}
          title="Spellcheck language"
        >
          <SpellCheck size={13} class="status-bar__spell-icon" />
          <span class="status-bar__spell-label">{spellLabel()}</span>
          <ChevronUp size={12} class="status-bar__spell-chevron" />
        </button>

        {/* Word & character counts share one slot at the right edge; clicking
            toggles which is shown (default words). */}
        <button
          class="status-bar__count"
          onClick={toggleStatusCountMode}
          title={
            statusCountMode() === "words"
              ? "Word count. Click for characters"
              : "Character count. Click for words"
          }
        >
          <TextCountIcon size={13} class="status-bar__count-icon" />
          <span class="status-bar__count-value">
            {statusCountMode() === "words"
              ? `${stats().words} words`
              : `${stats().chars} characters`}
          </span>
        </button>
      </Show>
      </Show>

      {/* In distraction-free mode the whole bar is lifted out of the grid and
          shrink-wrapped to the bottom-right corner (see CSS), so this button
          is all that floats there. */}
      <button
        class="status-bar__df"
        onClick={toggleDistractionFree}
        title={
          distractionFree()
            ? "Exit distraction-free mode"
            : "Distraction-free mode"
        }
        aria-label={
          distractionFree()
            ? "Exit distraction-free mode"
            : "Distraction-free mode"
        }
        aria-pressed={distractionFree()}
      >
        <Show when={distractionFree()} fallback={<Maximize size={14} />}>
          <Minimize size={14} />
        </Show>
      </button>

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

      <Show when={spellMenu()}>
        {(menu) => (
          <div
            class="context-menu"
            style={{ position: "fixed", left: `${menu().x}px`, top: `${menu().y}px` }}
          >
            <Show
              when={enabledDicts().length > 0}
              fallback={
                <span class="context-menu__hint">
                  No dictionaries enabled — see Settings → Language.
                </span>
              }
            >
              <button
                class="context-menu__item"
                onClick={() => setSpellActive("all")}
              >
                <span>All languages</span>
                <Show when={settings.editor.spellcheck && (settings.editor.spellcheck_active || "all") === "all"}>
                  <Check size={14} class="context-menu__check" />
                </Show>
              </button>
              <For each={enabledDicts()}>
                {(dict) => (
                  <button
                    class="context-menu__item"
                    onClick={() => setSpellActive(dict.code)}
                  >
                    <span>{dict.name}</span>
                    <Show when={settings.editor.spellcheck && settings.editor.spellcheck_active === dict.code}>
                      <Check size={14} class="context-menu__check" />
                    </Show>
                  </button>
                )}
              </For>
            </Show>
            <div class="context-menu__separator" />
            <button class="context-menu__item" onClick={turnSpellOff}>
              <span>Off</span>
              <Show when={!settings.editor.spellcheck}>
                <Check size={14} class="context-menu__check" />
              </Show>
            </button>
          </div>
        )}
      </Show>
    </div>
  );
};

export default StatusBar;
