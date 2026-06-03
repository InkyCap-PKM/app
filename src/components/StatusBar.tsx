import { Component, Show, For, createSignal, createMemo, createResource, onMount, onCleanup } from "solid-js";
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
  SquarePlus,
} from "lucide-solid";
import { TextCountIcon, SquareArrowOutUpRight } from "./icons";
import { noteboxInfo, noteboxRegistry, openNotebox } from "../stores/notebox";
import { openNoteboxWindow } from "../lib/new-window";
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
import { collaborative, gitStatus, gitSyncing, incomingCount, unresolvedCount, changesSinceSyncCount } from "../stores/git";
import { useI18n, tPlural } from "../lib/i18n";

/** Consistent gap, in px, between an upward-opening status-bar menu's bottom
 *  edge and the top of its trigger. */
const STATUS_MENU_GAP = 4;

/** Position an upward-opening status-bar menu so its bottom edge sits a
 *  consistent {@link STATUS_MENU_GAP}px above the status bar. Menus carry
 *  varying numbers of entries and separators, so we measure the real rendered
 *  height instead of estimating it — that keeps the bottom baseline identical
 *  across every status-bar menu (notebox switcher, spellcheck language picker,
 *  …) while letting the top edge fall where it must.
 *
 *  Called from the menu element's `ref`. Measurement is deferred to a
 *  microtask because the menu's dynamic rows (`<For>`/`<Show>`) are inserted
 *  after the ref fires; reading `offsetHeight` synchronously would see a
 *  near-empty element and place the menu too low (opening downward). The menu
 *  stays `visibility: hidden` until placed, so there's no flicker. */
function placeUpwardStatusMenu(el: HTMLElement, anchorTop: number) {
  queueMicrotask(() => {
    if (!document.body.contains(el)) return;
    const top = Math.max(STATUS_MENU_GAP, anchorTop - el.offsetHeight - STATUS_MENU_GAP);
    el.style.top = `${top}px`;
    el.style.visibility = "visible";
  });
}

const StatusBar: Component = () => {
  const t = useI18n();
  const isFileTab = () => getActiveTab()?.type === "file";
  const stats = wordCountStats;

  // Shared "click anywhere to dismiss" wiring for the upward status-bar menus.
  // The next document click closes the menu and removes the listener; tracking
  // the active handler lets `onCleanup` tear it down too, so a menu left open
  // when the component unmounts doesn't leak a document listener.
  let activeDismiss: (() => void) | null = null;
  const armDismiss = (close: () => void) => {
    setTimeout(() => {
      const onDocClick = () => {
        close();
        document.removeEventListener("click", onDocClick);
        activeDismiss = null;
      };
      activeDismiss = () => document.removeEventListener("click", onDocClick);
      document.addEventListener("click", onDocClick);
    }, 0);
  };
  onCleanup(() => activeDismiss?.());

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

  // `anchorTop` is the trigger's top edge; the menu element measures its own
  // height at mount and positions its bottom just above it (see
  // placeUpwardStatusMenu).
  const [switcherMenu, setSwitcherMenu] = createSignal<{
    x: number;
    anchorTop: number;
  } | null>(null);

  function toggleSwitcher(e: MouseEvent) {
    e.preventDefault();
    e.stopPropagation();
    if (switcherMenu()) {
      setSwitcherMenu(null);
      return;
    }
    const rect = (e.currentTarget as HTMLElement).getBoundingClientRect();
    setSwitcherMenu({ x: rect.left, anchorTop: statusBarTop() });
    armDismiss(() => setSwitcherMenu(null));
  }

  // ── Spellcheck language switcher ──────────────────────────────────────
  // The chip near the word count shows the active spellcheck language (or Off)
  // and opens an upward menu — like the notebox switcher — to pick a single
  // language, "All" (check against every enabled dictionary), or turn it off.
  const [spellDicts] = createResource(() => ipc.listSpellcheckDictionaries());
  const [spellMenu, setSpellMenu] = createSignal<{ x: number; anchorTop: number } | null>(null);

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
    if (!settings.editor.spellcheck) return t("statusBar.spell.off");
    const active = settings.editor.spellcheck_active || "all";
    if (active === "all") return t("statusBar.spell.all");
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
    setSpellMenu({ x: rect.left, anchorTop: statusBarTop() });
    armDismiss(() => setSpellMenu(null));
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

  // The `file:rename` command (F2) starts the inline rename from anywhere via
  // this event — the status bar owns the draft/commit state, so the command
  // just signals intent. Mirrors the click affordance below.
  onMount(() => {
    const onStart = () => startRename();
    document.addEventListener("inkycap:start-rename", onStart);
    onCleanup(() => document.removeEventListener("inkycap:start-rename", onStart));
  });

  function startRename() {
    const tab = getActiveTab();
    if (!tab || tab.type !== "file") return;
    // Respect the same guard as the visible affordance: no inline rename for a
    // collab-review tab or a file outside the notebox root (activeFilePath()
    // is null in both cases). Keeps the F2 command / event in step with the UI.
    if (!activeFilePath()) return;
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
      toastError(t("statusBar.renameFailed"), err);
    }
  }

  // Compact git sync summary for the collaborative-notebox chip. Mirrors the
  // panel's status line but terse (status bar real estate is tight).
  const gitSummary = createMemo(() => {
    const s = gitStatus();
    // A read-only "Check for updates" found incoming commits (status_summary's
    // own `behind` is upstream-tracking-based and often 0 without a fetch).
    if (incomingCount() > 0) return t("git.status.behind", { n: incomingCount() });
    // Merge-first: the last sync folded incoming changes in; these notes are
    // waiting to be reviewed (and reverted if unwanted). The primary incoming
    // backlog, surfaced ahead of the manual-suggestion count and "to share".
    if (changesSinceSyncCount() > 0)
      return t("git.status.sinceSync", { n: changesSinceSyncCount() });
    // Persistent, notebox-wide: notes still carry unresolved manual
    // `#suggestion(...)` tracked changes awaiting an accept/reject decision.
    if (unresolvedCount() > 0) return t("git.status.unresolved", { n: unresolvedCount() });
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

  /** Open a specific notebox in its own new window (leaves this one untouched). */
  function openNoteboxInNewWindow(path: string) {
    setSwitcherMenu(null);
    openNoteboxWindow(path);
  }

  /** Open a fresh window that prompts for a notebox to open. */
  function openNewWindow() {
    setSwitcherMenu(null);
    openNoteboxWindow();
  }

  // Noteboxes currently open in another window. A notebox lives in only one
  // window, so these are disabled in the switcher (the user can't switch to or
  // re-open one that's already open elsewhere). Refetched when the menu opens.
  const [openBoxes] = createResource(
    () => switcherMenu(),
    async (menu) => (menu ? await ipc.listOpenNoteboxes() : []),
  );
  const isOpenElsewhere = (path: string) =>
    !pathEquals(path, noteboxInfo()?.path) &&
    (openBoxes() ?? []).some((o) => pathEquals(o.path, path));

  // The status bar element itself is the shared baseline for upward-opening
  // menus: every menu's bottom edge aligns to its top, regardless of where the
  // individual trigger sits within the bar.
  let statusBarEl: HTMLDivElement | undefined;
  const statusBarTop = () =>
    statusBarEl?.getBoundingClientRect().top ?? window.innerHeight;

  return (
    <div
      ref={statusBarEl}
      class="status-bar"
      classList={{ "status-bar--distraction-free": distractionFree() }}
      data-focus-region="status-bar"
    >
      {/* Everything except the distraction-free toggle collapses away in
          distraction-free mode, leaving just the exit button at the edge. */}
      <Show when={!distractionFree()}>
      <Show when={noteboxInfo()} fallback={<span>{t("statusBar.noNotebox")}</span>}>
        {(info) => (
          <>
            <button
              class="status-bar__notebox-name"
              onClick={toggleSwitcher}
              title={t("statusBar.changeNotebox")}
            >
              {displayName()}
              <ArchiveRestore size={14} />
            </button>
            <span>{tPlural("common.file", info().file_count)}</span>
          </>
        )}
      </Show>

      <Show when={collaborative()}>
        <button
          class="status-bar__git"
          classList={{ "status-bar__git--attention": incomingCount() > 0 || unresolvedCount() > 0 }}
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
                    title={t("statusBar.renameFile")}
                    aria-label={t("statusBar.renameFile")}
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
                aria-label={t("statusBar.newFileName")}
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
                title={t("statusBar.confirmRename")}
                aria-label={t("statusBar.confirmRename")}
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
            title={t("statusBar.cursorPos")}
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
          title={t("statusBar.spellLanguage")}
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
              ? t("statusBar.wordCountTitle")
              : t("statusBar.charCountTitle")
          }
        >
          <TextCountIcon size={13} class="status-bar__count-icon" />
          <span class="status-bar__count-value">
            {statusCountMode() === "words"
              ? tPlural("statusBar.words", stats().words)
              : tPlural("statusBar.chars", stats().chars)}
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
            ? t("statusBar.exitDistractionFree")
            : t("statusBar.distractionFree")
        }
        aria-label={
          distractionFree()
            ? t("statusBar.exitDistractionFree")
            : t("statusBar.distractionFree")
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
            ref={(el) => placeUpwardStatusMenu(el, menu().anchorTop)}
            class="context-menu"
            style={{
              position: "fixed",
              left: `${menu().x}px`,
              top: "0px",
              visibility: "hidden",
            }}
          >
            <For each={noteboxRegistry()}>
              {(entry) => (
                <div class="notebox-switcher__row">
                  <button
                    class="context-menu__item notebox-switcher__switch"
                    onClick={() => switchToNotebox(entry.path)}
                    disabled={isOpenElsewhere(entry.path)}
                    title={isOpenElsewhere(entry.path) ? t("statusBar.openElsewhere") : undefined}
                  >
                    <span class="notebox-switcher__name">{entry.display_name}</span>
                    <Show when={pathEquals(entry.path, noteboxInfo()?.path)}>
                      <Check size={14} class="context-menu__check" />
                    </Show>
                    <Show when={isOpenElsewhere(entry.path)}>
                      <span class="notebox-switcher__badge">{t("statusBar.openElsewhere")}</span>
                    </Show>
                  </button>
                  {/* "Open in a new window" only for a notebox that isn't already
                      open anywhere — the one in THIS window, or one already open
                      in another window, can't be opened a second time. */}
                  <Show
                    when={
                      !pathEquals(entry.path, noteboxInfo()?.path) &&
                      !isOpenElsewhere(entry.path)
                    }
                  >
                    <button
                      class="notebox-switcher__new-window"
                      title={t("statusBar.openInNewWindow")}
                      aria-label={t("statusBar.openInNewWindow")}
                      onClick={() => openNoteboxInNewWindow(entry.path)}
                    >
                      <SquareArrowOutUpRight size={13} />
                    </button>
                  </Show>
                </div>
              )}
            </For>
            <div class="context-menu__separator" />
            <button class="context-menu__item" onClick={openNewWindow}>
              <SquarePlus size={14} style={{ "margin-right": "6px", opacity: "0.6", "flex-shrink": "0" }} />
              {t("statusBar.newWindow")}
            </button>
            <button class="context-menu__item" onClick={openManageNoteboxes}>
              <Archive size={14} style={{ "margin-right": "6px", opacity: "0.6", "flex-shrink": "0" }} />
              {t("statusBar.manageNoteboxes")}
            </button>
          </div>
        )}
      </Show>

      <Show when={spellMenu()}>
        {(menu) => (
          <div
            ref={(el) => placeUpwardStatusMenu(el, menu().anchorTop)}
            class="context-menu"
            style={{ position: "fixed", left: `${menu().x}px`, top: "0px", visibility: "hidden" }}
          >
            <Show
              when={enabledDicts().length > 0}
              fallback={
                <span class="context-menu__hint">
                  {t("statusBar.noDicts")}
                </span>
              }
            >
              <button
                class="context-menu__item"
                onClick={() => setSpellActive("all")}
              >
                <span>{t("statusBar.allLanguages")}</span>
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
              <span>{t("statusBar.spell.off")}</span>
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
