import { errorText } from "../lib/errors";
import {
  Component,
  createEffect,
  createMemo,
  createResource,
  createSignal,
  For,
  on,
  onCleanup,
  onMount,
  Show,
  type JSX,
} from "solid-js";
import * as ipc from "../lib/ipc";
import { buildChecker } from "../lib/spellchecker";
import { loadMediaObjectUrl, revokeBlobUrls } from "../lib/media-src";
import { sanitizeNoteHtml } from "../lib/safe-html";
import { t } from "../lib/i18n";
import { settings } from "../stores/settings";
import { localeVersion } from "../lib/i18n";
import {
  tabs,
  openTab,
  setTabEditingMode,
  consumePendingCursorOffset,
  consumePendingHeadingLabel,
  consumePendingMatch,
  activeTabId,
  getCachedEditorState,
  setCachedEditorState,
  markCachedEditorStateSaved,
  getCachedSavedText,
  getCachedScroll,
  setCachedScroll,
  getCachedReadingScroll,
  setCachedReadingScroll,
  closeTab,
  tabReadingFormat,
  setTabReadingFormat,
  tabReadingZoom,
} from "../stores/tabs";
import { navigateWikilink, showWikilinkContextMenu } from "../lib/wikilink-nav";
import { openLink, startsWithSchemeAndSlashes } from "../lib/open-link";
import { isDocumentationWindow } from "../lib/docs-window";
import { ComposeNotice } from "./ComposePanel";
import { searchHighlights } from "../stores/search";
import { pathEquals, pathStartsWith } from "../lib/paths";
import { onFileChanged, onFileCreated } from "../lib/events";
import { listenWhileMounted } from "../lib/listen-while-mounted";
import type { TypstCompileResult, TypstHtmlResult, TypstDiagnostic } from "../lib/types";
import { EditorView } from "@codemirror/view";
import { createTypstEditor, type TypstEditorHandle } from "../editor/typst-editor";
import { findLabelDefinition } from "../editor/typst-decorations/label-nav";
import { getLspClient, lspReady } from "../stores/lsp";
import { filePathToUri, createLspDiagnosticsUpdater } from "../editor/lsp";
import { noteboxInfo } from "../stores/notebox";
import { registerEditorView, unregisterEditorView } from "../stores/editor";
import {
  trackWrite,
  awaitPendingWrite,
  FLUSH_EDITOR_EVENT,
  EDITOR_PATH_MOVED_EVENT,
} from "../stores/editor-writes";
import { resolveTextFontSync } from "../lib/fontResolver";
import { toastError } from "../stores/toasts";
import {
  isEnabled as isScrollEnabled,
  getAnchorPath,
  getScrollDirection,
  getScrollScope,
  setScrollScope,
} from "../stores/journal-scroll";
import {
  BrainCircuit,
  CalendarRange,
  Waypoints,
  ArrowUpFromDot,
  ArrowDownToDot,
  BookA,
  FileCode,
  Code,
  PenLine,
  Eye,
  FlaskConical,
  MoreHorizontal,
} from "lucide-solid";
import JournalScrollPill from "./JournalScrollPill";
import JournalScrollView from "./JournalScrollView";
import ReadingZoomControl, { attachReadingZoomWheel } from "./ReadingZoomControl";
import PaneNavBar from "./panes/PaneNavBar";
import { DiagnosticRow } from "./DiagnosticRow";
import { ensureNoteboxImport } from "../lib/notebox-import-check";

export interface TypstEditorProps {
  path: string;
  tabId: string;
  onDirtyChange?: (dirty: boolean) => void;
}

const AUTOSAVE_DEBOUNCE_MS = 1500;

type TypstMode = "source" | "live" | "reading";

/// Select a search match and scroll it into view; the selection is the
/// highlight.
function scrollToMatch(
  handle: TypstEditorHandle,
  match: { line: number; charStart: number; charEnd: number },
) {
  const view = handle.view;
  const lineCount = view.state.doc.lines;
  const lineNo = Math.max(1, Math.min(match.line, lineCount));
  const line = view.state.doc.line(lineNo);
  const lineLen = line.to - line.from;
  // Clamp to the line's bounds in case the file changed since indexing.
  const start = line.from + Math.max(0, Math.min(match.charStart, lineLen));
  const end = line.from + Math.max(0, Math.min(match.charEnd, lineLen));
  view.dispatch({
    selection: { anchor: start, head: end },
    effects: EditorView.scrollIntoView(start, { y: "center", yMargin: 32 }),
  });
  view.focus();
}

/**
 * Scroll to a wikilink's anchor: the heading with this label, then a heading
 * whose text is the label, then any other label definition (prose, figure,
 * equation).
 */
function scrollToLabel(handle: TypstEditorHandle, doc: string, label: string) {
  const escaped = label.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const byLabel = new RegExp(`^=+\\s+.*<${escaped}>\\s*$`, "m");
  const byText = new RegExp(`^=+\\s+${escaped}\\s*(?:<[^>]+>)?\\s*$`, "im");
  const match = doc.match(byLabel) ?? doc.match(byText);
  const pos = match?.index ?? findLabelDefinition(doc, label);
  if (pos < 0) return;
  const view = handle.view;
  view.dispatch({
    selection: { anchor: pos },
    effects: EditorView.scrollIntoView(pos, { y: "start", yMargin: 16 }),
  });
  view.focus();
}

/**
 * Overflow "⋯" button for the header controls when the pane is too narrow.
 * Children render only while the menu is open, so the controls exist in one
 * place at a time.
 */
const HeaderOverflowMenu: Component<{ children: JSX.Element }> = (props) => {
  const [open, setOpen] = createSignal(false);
  let wrapRef: HTMLDivElement | undefined;

  function onDocPointerDown(e: PointerEvent) {
    if (wrapRef && !wrapRef.contains(e.target as Node)) setOpen(false);
  }
  function onKeyDown(e: KeyboardEvent) {
    if (e.key === "Escape") setOpen(false);
  }
  onCleanup(() => {
    document.removeEventListener("pointerdown", onDocPointerDown);
    document.removeEventListener("keydown", onKeyDown);
  });

  function toggle() {
    const next = !open();
    setOpen(next);
    if (next) {
      document.addEventListener("pointerdown", onDocPointerDown);
      document.addEventListener("keydown", onKeyDown);
    } else {
      document.removeEventListener("pointerdown", onDocPointerDown);
      document.removeEventListener("keydown", onKeyDown);
    }
  }

  return (
    <div class="editor-header__overflow" ref={wrapRef}>
      <button
        type="button"
        class="editor-header__icon-btn"
        aria-haspopup="menu"
        aria-expanded={open()}
        title={t("editor.toolbar.more")}
        aria-label={t("editor.toolbar.more")}
        onClick={toggle}
      >
        <MoreHorizontal size={14} />
      </button>
      <Show when={open()}>
        <div class="editor-header__overflow-popup" role="menu">
          {props.children}
        </div>
      </Show>
    </div>
  );
};

const TypstEditor: Component<TypstEditorProps> = (props) => {
  // Reading-view format is per tab (two panes of one note can differ),
  // defaulting to the user's setting.
  const readingFormat = () => tabReadingFormat(props.tabId);
  const setReadingFormat = (fmt: "svg" | "html") =>
    setTabReadingFormat(props.tabId, fmt);

  // Reading-view zoom, also per tab. The SVG view scales its pages (no
  // recompile); the HTML view uses CSS `zoom`, which scales the layout so text
  // still reflows.
  const readingZoom = () => tabReadingZoom(props.tabId);

  // Below these header widths the controls collapse into the "⋯" menu; reading
  // mode has more controls, so needs more room. A width breakpoint, rather than
  // measuring the content, avoids flicker, since collapsing doesn't change the
  // header width. Pixels are fine because the controls are icons.
  const COMPACT_TOOLBAR_READING_PX = 540;
  const COMPACT_TOOLBAR_EDIT_PX = 340;
  const [headerWidth, setHeaderWidth] = createSignal(0);
  let headerResizeObserver: ResizeObserver | undefined;
  const observeHeaderWidth = (el: HTMLElement) => {
    headerResizeObserver?.disconnect();
    headerResizeObserver = new ResizeObserver((entries) => {
      for (const entry of entries) setHeaderWidth(entry.contentRect.width);
    });
    headerResizeObserver.observe(el);
  };
  onCleanup(() => headerResizeObserver?.disconnect());
  const compactToolbar = () => {
    const w = headerWidth();
    // Before first measurement, assume roomy so the cluster starts inline.
    if (w === 0) return false;
    return w < (currentMode() === "reading" ? COMPACT_TOOLBAR_READING_PX : COMPACT_TOOLBAR_EDIT_PX);
  };

  let containerRef: HTMLDivElement | undefined;
  let editorMountRef: HTMLDivElement | undefined;
  let editorHandle: TypstEditorHandle | undefined;

  let currentPath: string | undefined;
  let currentDocUri: string | undefined;
  let lastSaved: string | undefined;
  let saveTimer: ReturnType<typeof setTimeout> | null = null;
  let dirty = false;
  let suppressChange = false;

  const [docText, setDocText] = createSignal("");
  const autoExpand = () => settings.editor.auto_expand_markup;

  function setDirty(next: boolean) {
    if (dirty === next) return;
    dirty = next;
    props.onDirtyChange?.(next);
  }

  function cancelPendingSave() {
    if (saveTimer !== null) {
      clearTimeout(saveTimer);
      saveTimer = null;
    }
  }

  // Every write from this editor waits for the previous one, so writes land
  // on disk in the order they were made and `lastSaved` always matches disk.
  let writeQueue: Promise<void> = Promise.resolve();

  /** Queue a write of the current buffer to the note's current path. The
   *  returned promise settles once every write queued so far has landed. */
  function writeBuffer(failureToastKey: string): Promise<void> {
    const targetPath = currentPath;
    const text = docText();
    if (!targetPath || text === lastSaved) return writeQueue;
    const write = writeQueue.then(async () => {
      try {
        await ipc.writeFileContent(targetPath, text);
        document.dispatchEvent(
          new CustomEvent("inkycap:note-saved", { detail: { path: targetPath } }),
        );
        if (!currentPath || !pathEquals(targetPath, currentPath)) return;
        lastSaved = text;
        // The user may have kept typing while this write was on its way.
        // Only a buffer that still matches the written text is saved.
        if (docText() === text) {
          setDirty(false);
        } else if (saveTimer === null) {
          scheduleSave();
        }
      } catch (err) {
        console.error("[TypstEditor] save failed:", err);
        toastError(t(failureToastKey), err);
      }
    });
    writeQueue = write;
    trackWrite(targetPath, write);
    return write;
  }

  /** Save now instead of waiting for the autosave delay. Resolves once the
   *  buffer (and any earlier write) is on disk. */
  function flushSave(): Promise<void> {
    cancelPendingSave();
    return writeBuffer("editor.toast.saveFailed");
  }

  function scheduleSave() {
    cancelPendingSave();
    saveTimer = setTimeout(() => {
      saveTimer = null;
      void writeBuffer("editor.toast.autoSaveFailed");
    }, AUTOSAVE_DEBOUNCE_MS);
  }

  function onDocUpdate(text: string) {
    if (suppressChange) return;
    setDocText(text);
    if (text === lastSaved) {
      // Typed back to what is on disk: nothing left to save.
      cancelPendingSave();
      setDirty(false);
    } else {
      setDirty(true);
      scheduleSave();
    }
  }

  // ── LSP helpers ────────────────────────────────────────

  function buildDocumentUri(filePath: string): string {
    const notebox = noteboxInfo();
    if (!notebox) return filePathToUri(filePath);
    if (filePath.startsWith("/") || filePath.startsWith("\\")) {
      return filePathToUri(filePath);
    }
    return filePathToUri(`${notebox.path}/${filePath}`);
  }

  let cleanupDiagnostics: (() => void) | null = null;

  async function lspOpenDocument(filePath: string, text: string) {
    const client = getLspClient();
    if (!client) return;
    const uri = buildDocumentUri(filePath);
    currentDocUri = uri;
    await client.openDocument(uri, text);
    editorHandle?.setLsp(client, uri);
    if (editorHandle) {
      cleanupDiagnostics?.();
      cleanupDiagnostics = createLspDiagnosticsUpdater(editorHandle.view);
    }
  }

  async function lspCloseDocument() {
    if (!currentDocUri) return;
    const client = getLspClient();
    if (client) {
      await client.closeDocument(currentDocUri);
    }
    currentDocUri = undefined;
  }

  // ── CodeMirror lifecycle ──────────────────────────────

  // True for the first file load after the editor was restored from the per-tab
  // cache, so that load doesn't `setText()` over the cached doc and reset its
  // history.
  let usedCachedState = false;

  function mountEditor() {
    if (!editorMountRef || editorHandle) return;
    const client = getLspClient();
    const uri = props.path ? buildDocumentUri(props.path) : undefined;
    const cached = getCachedEditorState(props.tabId, props.path);
    const restoreScroll = getCachedScroll(props.tabId, props.path);
    editorHandle = createTypstEditor({
      parent: editorMountRef,
      doc: docText(),
      visualMode: currentMode() === "live",
      smartIndentLists: settings.editor.smart_indent_lists,
      enterInsertsLineBreak: settings.editor.enter_inserts_line_break,
      autoPairBrackets: settings.editor.auto_pair_brackets,
      typewriterMode: settings.editor.typewriter_mode,
      focusMode: settings.editor.focus_mode,
      focusDim: settings.editor.focus_dim,
      selectionToolbar: settings.editor.selection_toolbar,
      commandPalette: settings.editor.command_palette,
      lspClient: client,
      documentUri: uri,
      onUpdate: onDocUpdate,
      restoreState: cached,
      restoreScroll,
    });
    // Track the scroll offset continuously (once per frame), so returning to this
    // editor lands where the user left off. Captured live because by teardown the
    // editor div is already detached and reads as scrolled to the top. Like the
    // reading view's attachReadingScrollMemory.
    {
      const scroller = editorHandle.view.scrollDOM;
      let queued = false;
      scroller.addEventListener(
        "scroll",
        () => {
          if (queued || !editorHandle) return;
          queued = true;
          requestAnimationFrame(() => {
            queued = false;
            if (editorHandle) setCachedScroll(props.tabId, props.path, editorHandle.scrollSnapshot());
          });
        },
        { passive: true },
      );
    }
    // Re-apply the restored scroll on the next frame: the first `scrollTo` runs
    // before the container has a height.
    if (restoreScroll) {
      const handle = editorHandle;
      requestAnimationFrame(() => {
        if (handle !== editorHandle) return; // remounted/destroyed meanwhile
        handle.view.dispatch({ effects: restoreScroll });
      });
    }
    if (cached) {
      usedCachedState = true;
      currentPath = props.path;
      setDocText(editorHandle.getText());
      // A restored buffer known to be saved counts as saved, so it doesn't
      // overwrite a newer file if hidden again before the note is read.
      const savedText = getCachedSavedText(props.tabId, props.path);
      if (savedText !== undefined && savedText === editorHandle.getText()) {
        lastSaved = savedText;
      }
      if (currentMode() === "live") {
        // A full rebuild rather than `ensureParsed()`: the restored state's
        // decorations can be built from an unfinished tree and stay stuck as
        // raw source. `rebuildVisual()` waits for the tree to cover the doc
        // first, as reloadFromDisk does.
        editorHandle.rebuildVisual();
      }
    }
    registerEditorView(props.tabId, editorHandle);
  }

  function destroyEditor() {
    if (editorHandle) {
      // Save doc, selection and undo history so the next mount of this tab
      // restores them. Scroll is tracked live in mountEditor (see
      // setCachedScroll), since the editor div is already detached here.
      if (currentPath) {
        try {
          const path = currentPath;
          const text = editorHandle.getText();
          const json = editorHandle.serializeState();
          setCachedEditorState(props.tabId, path, json);
          // Once the save queued at teardown lands, note that this text is on
          // disk, so a later restore can tell whether the file changed since.
          void writeQueue.then(() => {
            if (lastSaved === text) markCachedEditorStateSaved(props.tabId, path, json, text);
          });
        } catch (err) {
          console.error("[TypstEditor] failed to cache editor state:", err);
        }
      }
      unregisterEditorView(props.tabId, editorHandle);
      editorHandle.destroy();
      editorHandle = undefined;
    }
  }

  onMount(() => {
    mountEditor();
  });

  onCleanup(() => {
    // Save any pending edit before unmounting. `flushSave()` registers the
    // write in `pendingWrites`, and the next mount of the same path waits for
    // it before reading, so edits aren't lost. After a rename or move,
    // `currentPath` already names the new location (see onPathMoved).
    void flushSave();
    cleanupDiagnostics?.();
    lspCloseDocument();
    destroyEditor();
  });

  // ── Mode handling ──────────────────────────────────────

  // Tooling files (`.inkycap/scaffolds/`, `.inkycap/packages/`) aren't notes:
  // no editor header, no back/forward, source mode only.
  const isToolingFile = createMemo(() => {
    const p = props.path;
    return /[/\\]\.inkycap[/\\](scaffolds|packages)[/\\]/.test(p);
  });

  const currentMode = createMemo<TypstMode>(() => {
    if (isToolingFile()) return "source";
    const t = tabs.find((x) => x.id === props.tabId);
    if (t?.editingMode) return t.editingMode;
    return settings.editor.default_editing_mode === "source" ? "source" : "live";
  });

  async function setMode(next: TypstMode) {
    if (currentMode() === next) return;
    if (next === "reading") {
      await flushSave();
    }
    setTabEditingMode(props.tabId, next);
  }

  createEffect(
    on(currentMode, (mode, prevMode) => {
      if (prevMode === undefined) return;
      const needsEditor = mode === "source" || mode === "live";
      const hadEditor = prevMode === "source" || prevMode === "live";
      if (needsEditor && !hadEditor) {
        queueMicrotask(() => mountEditor());
      } else if (!needsEditor && hadEditor) {
        destroyEditor();
      } else if (needsEditor && hadEditor && editorHandle) {
        editorHandle.setVisualMode(mode === "live");
      }
    }),
  );

  // Journal Scroll replaces the editor without remounting this component, so
  // tear down the CodeMirror handle when it turns on; otherwise it points at a
  // detached node. When it turns off, the mount ref re-creates the editor from
  // the cached doc and history.
  createEffect(
    on(
      () => isScrollEnabled(props.tabId),
      (scrollOn, prevScrollOn) => {
        if (prevScrollOn === undefined) return;
        if (scrollOn) destroyEditor();
      },
    ),
  );

  createEffect(
    on(autoExpand, (enabled) => {
      editorHandle?.setAutoExpand(enabled);
    }),
  );

  createEffect(
    on(
      // `currentMode` is a dependency, not an argument: the handle decides
      // whether the settings apply to its mode.
      [() => settings.editor.focus_mode, () => settings.editor.focus_dim, currentMode],
      ([mode, dim]) => {
        editorHandle?.setFocusMode(mode, dim);
      },
    ),
  );

  createEffect(
    on([() => settings.editor.typewriter_mode, currentMode], ([enabled, editorMode]) => {
      // Typewriter scrolling only applies in the visual editor; pass the
      // setting so toggling it, or switching modes, applies at once.
      editorHandle?.setTypewriterMode(enabled && editorMode === "live");
    }),
  );

  // Spellcheck: build a Hunspell checker from the active dictionaries and the
  // notebox's user dictionary. Rebuilds when the toggle or languages change, or
  // the dictionary file changes (`inkycap:dictionary-changed`). A generation
  // counter drops a stale async build.
  let spellGen = 0;
  async function rebuildSpellChecker() {
    const gen = ++spellGen;
    if (!editorHandle) return;
    const enabled = settings.editor.spellcheck_languages ?? [];
    if (!settings.editor.spellcheck || enabled.length === 0) {
      editorHandle.setSpellChecker(null);
      return;
    }
    // The status-bar chip limits checking to one language or "all" enabled
    // ones. A disabled language falls back to all.
    const active = settings.editor.spellcheck_active || "all";
    const codes =
      active !== "all" && enabled.includes(active) ? [active] : enabled;
    try {
      const userWords = await ipc.listUserDictionary().catch(() => []);
      console.info("[spellcheck] building checker for", codes);
      const checker = await buildChecker(codes, userWords);
      if (gen !== spellGen) return;
      if (!checker) {
        console.warn("[spellcheck] no dictionary could be loaded for", codes);
        toastError(
          "Spellcheck unavailable",
          `Could not load dictionaries: ${codes.join(", ")}`,
        );
      } else {
        console.info("[spellcheck] checker ready for", codes);
      }
      editorHandle?.setSpellChecker(checker);
    } catch (err) {
      console.error("[spellcheck] build failed", err);
      if (gen === spellGen) {
        editorHandle?.setSpellChecker(null);
        toastError(t("editor.toast.spellcheckFailed"), err);
      }
    }
  }

  createEffect(
    on(
      [
        () => settings.editor.spellcheck,
        () => settings.editor.spellcheck_languages,
        () => settings.editor.spellcheck_active,
      ],
      () => void rebuildSpellChecker(),
    ),
  );

  const onDictionaryChanged = () => void rebuildSpellChecker();
  document.addEventListener("inkycap:dictionary-changed", onDictionaryChanged);
  onCleanup(() =>
    document.removeEventListener("inkycap:dictionary-changed", onDictionaryChanged),
  );

  createEffect(
    on(() => settings.editor.smart_indent_lists, (enabled) => {
      editorHandle?.setSmartIndentLists(enabled);
    }),
  );

  createEffect(
    on(() => settings.editor.enter_inserts_line_break, (enabled) => {
      editorHandle?.setEnterInsertsLineBreak(enabled);
    }),
  );

  createEffect(
    on(() => settings.editor.auto_pair_brackets, (enabled) => {
      editorHandle?.setAutoPairBrackets(enabled);
    }),
  );

  createEffect(
    on(() => settings.editor.selection_toolbar, (enabled) => {
      editorHandle?.setSelectionToolbar(enabled);
    }),
  );

  createEffect(
    on(() => settings.editor.command_palette, (enabled) => {
      editorHandle?.setCommandPalette(enabled);
    }),
  );

  // Refresh the editor's translated UI when the language changes. `defer: true`
  // skips the first run.
  createEffect(
    on(localeVersion, () => editorHandle?.relocalize(), { defer: true }),
  );

  // ── File loading ───────────────────────────────────────
  // MainContent keys this component on `path`, so the file loads once per
  // mount.

  const [content] = createResource(
    () => props.path,
    async (path) => {
      // Wait for a previous editor's pending save of this path before reading,
      // so the read isn't stale.
      await awaitPendingWrite(path);
      // Add the InkyCap import to a note without it (or ask first) before
      // reading. Skipped when restoring the in-memory state, whose unsaved
      // edits would overwrite the fix.
      if (getCachedEditorState(props.tabId, path) === undefined) {
        await ensureNoteboxImport(path);
      }
      try {
        return await ipc.readFileContent(path);
      } catch (err) {
        toastError(t("editor.toast.openFailed"), err);
        closeTab(props.tabId);
        return undefined;
      }
    },
  );

  // Highlight every search match in the opened file, not just the clicked one.
  // Source and visual modes only, since the positions are source offsets.
  function applySearchHighlights() {
    if (!editorHandle) return;
    const hl = searchHighlights();
    const mode = currentMode();
    if (
      hl &&
      currentPath &&
      pathEquals(hl.path, currentPath) &&
      (mode === "source" || mode === "live")
    ) {
      editorHandle.setSearchMatches(hl.ranges);
    } else {
      editorHandle.setSearchMatches([]);
    }
  }

  // Re-apply when the search store changes (clicking another result in the
  // already-open file, or clearing the search) or the mode changes.
  createEffect(() => {
    searchHighlights();
    currentMode();
    applySearchHighlights();
  });

  createEffect(
    on([() => props.path, content], ([path, doc]) => {
      if (doc === undefined) return;

      currentPath = path;
      lastSaved = doc;

      // A buffer restored from cache already holds the latest doc and undo
      // history; don't `setText()`, just compare with disk for the dirty flag.
      // A saved buffer is discarded if the file on disk has changed since.
      const savedText = getCachedSavedText(props.tabId, path);
      const changedWhileAway = savedText !== undefined && savedText !== doc;
      const restoredFromCache = usedCachedState && !changedWhileAway;
      usedCachedState = false;

      if (restoredFromCache && editorHandle) {
        const editorText = editorHandle.getText();
        setDocText(editorText);
        setDirty(editorText !== doc);
      } else {
        suppressChange = true;
        try {
          setDocText(doc);
          if (editorHandle) {
            editorHandle.setText(doc);
            if (currentMode() === "live") {
              // Full rebuild after `setText`, as in reloadFromDisk.
              editorHandle.rebuildVisual();
            }
          }
        } finally {
          queueMicrotask(() => {
            suppressChange = false;
          });
        }
        setDirty(false);
      }

      lspOpenDocument(path, editorHandle?.getText() ?? doc);

      if (editorHandle && (currentMode() === "source" || currentMode() === "live")) {
        const pendingOffset = consumePendingCursorOffset(props.tabId);
        const pendingHeading = consumePendingHeadingLabel(props.tabId);
        const pendingMatch = consumePendingMatch(props.tabId);
        if (pendingMatch) {
          // Wait two frames for layout before scrolling, as heading jumps do.
          requestAnimationFrame(() => {
            requestAnimationFrame(() => {
              if (!editorHandle) return;
              scrollToMatch(editorHandle, pendingMatch);
            });
          });
        } else if (pendingHeading) {
          requestAnimationFrame(() => {
            requestAnimationFrame(() => {
              if (!editorHandle) return;
              scrollToLabel(editorHandle, editorHandle.getText(), pendingHeading);
            });
          });
        } else if (restoredFromCache) {
          // Cached state already carries the prior selection — just reclaim focus.
          queueMicrotask(() => editorHandle?.focus());
        } else {
          queueMicrotask(() => {
            if (!editorHandle) return;
            if (pendingOffset !== undefined) {
              editorHandle.setCursor(pendingOffset);
            } else if (currentMode() === "live") {
              editorHandle.focusAtContent();
            } else {
              editorHandle.focus();
            }
          });
        }
      }

      // Mark this file's search matches. Untracked, since the enclosing effect
      // uses `on`.
      applySearchHighlights();
    }),
  );

  // Handle heading label navigation when an already-open tab is activated.
  // Only runs for already-loaded tabs — the file-load effect handles fresh mounts.
  createEffect(
    on(activeTabId, (id) => {
      if (id !== props.tabId || !editorHandle) return;
      const doc = editorHandle.getText();
      if (!doc) return; // Doc not loaded yet — file-load effect will handle it
      const tab = tabs.find((t) => t.id === props.tabId);
      if (tab?.pendingMatch) {
        const m = consumePendingMatch(props.tabId);
        if (m) scrollToMatch(editorHandle, m);
        return;
      }
      if (!tab?.pendingHeadingLabel) return;
      const label = consumePendingHeadingLabel(props.tabId);
      if (label) {
        scrollToLabel(editorHandle, doc, label);
      }
    }),
  );

  // When the LSP becomes ready after the editor has already loaded a file,
  // retroactively open the document and wire up the extension.
  createEffect(
    on(lspReady, (ready) => {
      if (!ready || !currentPath || !editorHandle) return;
      lspOpenDocument(currentPath, docText());
    }),
  );

  // ── Save on request ─────────────────────────────────────
  // `flushEditorsAt` (before a rename, move or property edit touches this note)
  // and `flushAllEditors` (before quitting) ask for an immediate save. The
  // write registers with `trackWrite` synchronously, so the caller can wait for
  // it.
  const onFlushRequest = (e: Event) => {
    const path = (e as CustomEvent<{ path: string }>).detail?.path;
    if (!path || !currentPath || !pathStartsWith(currentPath, path)) return;
    void flushSave();
  };
  document.addEventListener(FLUSH_EDITOR_EVENT, onFlushRequest);
  onCleanup(() => document.removeEventListener(FLUSH_EDITOR_EVENT, onFlushRequest));

  const onFlushAll = () => void flushSave();
  document.addEventListener("inkycap:flush-all-editors", onFlushAll);
  onCleanup(() => document.removeEventListener("inkycap:flush-all-editors", onFlushAll));

  // ── Follow a renamed or moved note ──────────────────────
  // The tab is switching to the new path. Take it first, so the teardown save
  // and cached state go to the new location.
  const onPathMoved = (e: Event) => {
    const detail = (e as CustomEvent<{ from: string; to: string }>).detail;
    if (!detail || !currentPath || !pathEquals(currentPath, detail.from)) return;
    currentPath = detail.to;
  };
  document.addEventListener(EDITOR_PATH_MOVED_EVENT, onPathMoved);
  onCleanup(() => document.removeEventListener(EDITOR_PATH_MOVED_EVENT, onPathMoved));

  // Re-read the file and replace the buffer if it differs. Used after property
  // edits and syncs; a reload with no change does nothing.
  async function reloadFromDisk() {
    if (!currentPath) return;
    const path = currentPath;
    // Compare with the editor buffer itself, not the `docText` signal, which
    // can lag.
    const readBuffer = () => editorHandle?.getText() ?? docText();
    const bufferBeforeRead = readBuffer();
    try {
      const freshContent = await ipc.readFileContent(path);
      const bufferText = readBuffer();
      // Typing (or a move to another path) while the file was being read
      // wins: replacing the buffer now would throw that typing away.
      if (bufferText !== bufferBeforeRead || dirty || !pathEquals(path, currentPath)) return;
      if (freshContent === bufferText) {
        // Buffer is already current; just settle the dirty flag / lastSaved.
        lastSaved = freshContent;
        setDirty(false);
        return;
      }
      lastSaved = freshContent;
      suppressChange = true;
      try {
        setDocText(freshContent);
        if (editorHandle) {
          editorHandle.setText(freshContent);
          // Visual mode needs a parse-aware rebuild, or old widgets can hide
          // the new content.
          if (currentMode() === "live") {
            editorHandle.rebuildVisual();
          }
        }
      } finally {
        queueMicrotask(() => { suppressChange = false; });
      }
      setDirty(false);
    } catch (err) {
      console.error("[TypstEditor] reload from disk failed:", err);
    }
  }

  // ── External property edits (sidebar) ──────────────────
  // Reload after the sidebar writes a property. The sidebar saves the editor
  // first, so nothing is lost.
  const onPropChanged = (e: Event) => {
    const detail = (e as CustomEvent).detail;
    if (detail?.path !== currentPath) return;
    cancelPendingSave(); // synchronous, to prevent a save racing the reload
    void reloadFromDisk();
  };
  document.addEventListener("inkycap:note-property-changed", onPropChanged);
  onCleanup(() => document.removeEventListener("inkycap:note-property-changed", onPropChanged));

  // ── Post-sync reload ───────────────────────────────────
  // A sync can rewrite the open note. Reload only a clean buffer; unsaved edits
  // stay and merge on the next sync.
  const onNoteboxSynced = () => {
    if (!currentPath || dirty) return;
    cancelPendingSave();
    void reloadFromDisk();
  };
  document.addEventListener("inkycap:notebox-synced", onNoteboxSynced);
  onCleanup(() => document.removeEventListener("inkycap:notebox-synced", onNoteboxSynced));

  // ── External file change (another window / external editor) ─────
  // Reload when the watcher reports the note changed (`notebox:file-changed`),
  // or replaced by a new file (`notebox:file-created`). Only a clean buffer;
  // unsaved edits stay and win on the next save. This editor's own saves are a
  // no-op.
  const onNoteReplacedOnDisk = (payload: { path: string }) => {
    if (!currentPath || dirty) return;
    if (!pathEquals(payload.path, currentPath)) return;
    cancelPendingSave();
    void reloadFromDisk();
  };
  listenWhileMounted(onFileChanged(onNoteReplacedOnDisk));
  listenWhileMounted(onFileCreated(onNoteReplacedOnDisk));

  // ── Wikilink click-to-navigate ────────────────────────
  const onWikilinkNav = (e: Event) => {
    const detail = (e as CustomEvent).detail;
    const target = detail?.target as string | undefined;
    const label = detail?.label as string | undefined;
    const newTab = detail?.newTab as boolean | undefined;
    if (!target) return;
    void navigateWikilink(target, label, newTab ?? false);
  };
  document.addEventListener("inkycap:navigate-wikilink", onWikilinkNav);
  onCleanup(() => document.removeEventListener("inkycap:navigate-wikilink", onWikilinkNav));

  // ── Reading-mode compile ───────────────────────────────

  // Reading and preview panes compile from disk, so bump a revision on each
  // save of this tab's path to make them recompile.
  const [savedRevision, setSavedRevision] = createSignal(0);
  const onExternalSave = (e: Event) => {
    const savedPath = (e as CustomEvent).detail?.path as string | undefined;
    if (savedPath && currentPath && pathEquals(savedPath, currentPath)) {
      setSavedRevision((n) => n + 1);
    }
  };
  document.addEventListener("inkycap:note-saved", onExternalSave);
  onCleanup(() => document.removeEventListener("inkycap:note-saved", onExternalSave));

  const [compileResult] = createResource<
    TypstCompileResult | undefined,
    readonly [string, TypstMode, "svg" | "html", number]
  >(
    () => [props.path, currentMode(), readingFormat(), savedRevision()] as const,
    async ([path, mode, fmt]) => {
      if (mode !== "reading" || fmt !== "svg") return undefined;
      try {
        return await ipc.compileTypstSvg(path);
      } catch (err) {
        return ipcErrorToResult(err);
      }
    },
  );

  const [htmlResult] = createResource<
    TypstHtmlResult | undefined,
    readonly [string, TypstMode, "svg" | "html", number]
  >(
    () => [props.path, currentMode(), readingFormat(), savedRevision()] as const,
    async ([path, mode, fmt]) => {
      if (mode !== "reading" || fmt !== "html") return undefined;
      try {
        return await ipc.compileTypstHtml(path);
      } catch (err) {
        return ipcErrorToHtmlResult(err);
      }
    },
  );

  // ── Settings reactivity ────────────────────────────────

  createEffect(() => {
    const s = settings.editor;
    // Set on the document element because the editor and the Journal Scroll
    // both use them. With readable line length on, the content width is capped
    // and the side padding has a floor that grows with the window; off, content
    // runs edge to edge.
    const root = document.documentElement;
    // The font variables are set by applyFontSettings() in stores/theme.ts; the
    // body size is a separate editor setting.
    root.style.setProperty("--md-body-size", `${s.body_font_size}px`);
    root.style.setProperty(
      "--md-max-width",
      s.readable_line_length ? `${s.max_line_width}ch` : "100%",
    );
    root.style.setProperty(
      "--md-side-padding-min",
      // Full width still keeps a one-character gutter from the panel edges.
      s.readable_line_length ? "clamp(16px, 4vw, 64px)" : "1ch",
    );
  });

  // Journal Scroll status line, shown centred in the editor header while
  // scroll is on — a quiet reminder of the feed's direction and anchor.
  const scrollStatusText = () => {
    const anchor = getAnchorPath(props.tabId);
    const base = anchor.split("/").pop() ?? anchor;
    const title = base.replace(/\.typ$/i, "");
    const desc = getScrollDirection(props.tabId) === "desc";
    if (getScrollScope(props.tabId) === "neighbourhood") {
      return t(
        desc
          ? "journalScroll.status.neighbourhoodRecentFirst"
          : "journalScroll.status.neighbourhoodOldestFirst",
        { anchor: title },
      );
    }
    return t(
      desc ? "journalScroll.status.recentFirst" : "journalScroll.status.oldestFirst",
      { anchor: title },
    );
  };

  // The header's right-hand controls: Mycelial button (not in scroll),
  // Timeline/Neighbourhood toggle (scroll only), Journal Scroll pill, reading format
  // and zoom (reading mode only) and the mode toggle. Inline when there is room,
  // otherwise in the overflow menu (see `compactToolbar`).
  const RightControls: Component<{ layout?: "inline" | "menu" }> = (rc) => {
    const inMenu = rc.layout === "menu";
    // In the overflow menu each control gets a labelled row; inline, Row adds
    // nothing.
    const Row: Component<{ label: string; children: JSX.Element }> = (rp) =>
      inMenu ? (
        <div class="editor-header__menu-row">
          <span class="editor-header__menu-label">{rp.label}</span>
          <div class="editor-header__menu-control">{rp.children}</div>
        </div>
      ) : (
        <>{rp.children}</>
      );

    return (
    <>
      <Show when={!isScrollEnabled(props.tabId)}>
      <Row label={t("editor.toolbar.mycelialLabel")}>
      <button
        type="button"
        class="editor-header__icon-btn"
        onClick={() => {
          const tab = tabs.find((t) => t.id === props.tabId);
          if (!tab) return;
          const name = tab.title.replace(/\.[^.]+$/, "");
          openTab(
            { type: "mycelial", title: name, path: tab.path },
            { forceNewTab: true },
          );
        }}
        title={t("mycelial.button.title")}
        aria-label={t("mycelial.button.title")}
      >
        <BrainCircuit size={14} />
      </button>
      </Row>
      </Show>
      <Show when={isScrollEnabled(props.tabId)}>
        <Row label={t("journalScroll.scope.toggle")}>
        <div
          class="editor-header__mode-toggle editor-header__format-toggle"
          role="group"
          aria-label={t("journalScroll.scope.toggle")}
        >
          <button
            type="button"
            class="editor-header__mode-seg editor-header__format-seg"
            classList={{ "is-active": getScrollScope(props.tabId) === "timeline" }}
            onClick={() => void setScrollScope(props.tabId, "timeline")}
            title={t("journalScroll.scope.timeline.title")}
            aria-pressed={getScrollScope(props.tabId) === "timeline"}
          >
            <CalendarRange size={14} />
            <span>{t("journalScroll.scope.timeline")}</span>
          </button>
          <button
            type="button"
            class="editor-header__mode-seg editor-header__format-seg"
            classList={{ "is-active": getScrollScope(props.tabId) === "neighbourhood" }}
            onClick={() => void setScrollScope(props.tabId, "neighbourhood")}
            title={t("journalScroll.scope.neighbourhood.title")}
            aria-pressed={getScrollScope(props.tabId) === "neighbourhood"}
          >
            <Waypoints size={14} />
            <span>{t("journalScroll.scope.neighbourhood")}</span>
          </button>
        </div>
        </Row>
      </Show>
      <Row label={t("journalScroll.group")}>
        <JournalScrollPill tabId={props.tabId} anchorPath={props.path} />
      </Row>
      <Show when={inMenu}>
        <div class="editor-header__menu-divider" />
      </Show>
      <Show when={!isScrollEnabled(props.tabId) && currentMode() === "reading"}>
        <Row label={t("readingFormat.toggle")}>
        <div
          class="editor-header__mode-toggle editor-header__format-toggle"
          role="group"
          aria-label={t("readingFormat.toggle")}
        >
          <button
            type="button"
            class="editor-header__mode-seg editor-header__format-seg"
            classList={{ "is-active": readingFormat() === "svg" }}
            onClick={() => setReadingFormat("svg")}
            title={t("readingFormat.svg.title")}
            aria-pressed={readingFormat() === "svg"}
          >
            <BookA size={14} />
            <span>{t("readingFormat.svg")}</span>
          </button>
          <button
            type="button"
            class="editor-header__mode-seg editor-header__format-seg"
            classList={{ "is-active": readingFormat() === "html" }}
            onClick={() => setReadingFormat("html")}
            title={t("readingFormat.html.title")}
            aria-pressed={readingFormat() === "html"}
          >
            <FileCode size={14} />
            <span>{t("readingFormat.html")}</span>
          </button>
        </div>
        </Row>
        <Row label={t("editor.reading.zoom.label")}>
        <ReadingZoomControl tabId={props.tabId} />
        </Row>
      </Show>
      <Show when={!isScrollEnabled(props.tabId)}>
        <Row label={t("editor.mode.label")}>
        <div class="editor-header__mode-toggle" role="group" aria-label={t("editor.mode.label")}>
          <button
            type="button"
            class="editor-header__mode-seg"
            classList={{ "is-active": currentMode() === "source" }}
            onClick={() => setMode("source")}
            title={t("editor.mode.source")}
            aria-pressed={currentMode() === "source"}
          >
            <Code size={14} />
          </button>
          <button
            type="button"
            class="editor-header__mode-seg"
            classList={{ "is-active": currentMode() === "live" }}
            onClick={() => setMode("live")}
            title={t("editor.mode.visual")}
            aria-pressed={currentMode() === "live"}
          >
            <PenLine size={14} />
          </button>
          <button
            type="button"
            class="editor-header__mode-seg"
            classList={{ "is-active": currentMode() === "reading" }}
            onClick={() => setMode("reading")}
            title={t("editor.mode.reading")}
            aria-pressed={currentMode() === "reading"}
          >
            <Eye size={14} />
          </button>
        </div>
        </Row>
      </Show>
    </>
    );
  };

  return (
    <div class="typst-editor-container" ref={containerRef}>
      <Show when={!isToolingFile()}>
      <PaneNavBar
        tabId={props.tabId}
        barRef={observeHeaderWidth}
        centre={
          <Show when={isScrollEnabled(props.tabId)}>
            <span class="editor-header__scroll-status">
              <Show
                when={getScrollDirection(props.tabId) === "desc"}
                fallback={
                  // "Viewing old to new": arrow-down-to-dot, flipped up.
                  <ArrowDownToDot
                    size={14}
                    style={{ transform: "rotate(180deg)" }}
                  />
                }
              >
                {/* "Viewing new to old": arrow-up-from-dot, flipped down. */}
                <ArrowUpFromDot
                  size={14}
                  style={{ transform: "rotate(180deg)" }}
                />
              </Show>
              {scrollStatusText()}
            </span>
          </Show>
        }
        right={
          /* In a narrow pane the controls collapse into the "⋯" menu;
             RightControls mounts in only one branch. */
          <Show when={compactToolbar()} fallback={<RightControls />}>
            <HeaderOverflowMenu>
              <RightControls layout="menu" />
            </HeaderOverflowMenu>
          </Show>
        }
      />
      </Show>

      <Show when={isDocumentationWindow()}>
        <div class="editor-notice" role="note">
          <FlaskConical class="editor-notice__icon" size={15} />
          <span>{t("docs.ephemeralBanner")}</span>
        </div>
      </Show>
      <ComposeNotice tabId={props.tabId} />

      {/* Everything below the toolbar. Its own element so the gutter can be
          a rounded panel in its own right — the toolbar stays flush and full
          width above it. */}
      <div class="typst-editor-body">
        <Show when={isScrollEnabled(props.tabId)}>
          <JournalScrollView tabId={props.tabId} />
        </Show>

        <Show when={!isScrollEnabled(props.tabId) && (currentMode() === "source" || currentMode() === "live")}>
          <div
            class="typst-editor"
            ref={(el) => {
              editorMountRef = el;
              if (!editorHandle) {
                queueMicrotask(() => mountEditor());
              }
            }}
          />
        </Show>

        <Show when={!isScrollEnabled(props.tabId) && currentMode() === "reading"}>
          <Show when={readingFormat() === "svg"} fallback={
            <TypstHtmlReadingView
              result={htmlResult()}
              loading={htmlResult.loading}
              documentFont={resolveTextFontSync(settings.fonts)}
              zoom={readingZoom()}
              tabId={props.tabId}
              path={props.path}
            />
          }>
            <TypstReadingView
              result={compileResult()}
              loading={compileResult.loading}
              zoom={readingZoom()}
              tabId={props.tabId}
              path={props.path}
            />
          </Show>
        </Show>
      </div>
    </div>
  );
};

/** CSS pixels per Typst point (96 px per inch / 72 pt per inch). */
export const PT_TO_CSS_PX = 4 / 3;

/**
 * Remember and restore a reading view's scroll offset across tab switches,
 * keyed by tab and path, as source and visual modes do. Applied once the
 * compiled content has laid out; kept until the tab closes (see `closeTab`).
 */
function attachReadingScrollMemory(
  el: HTMLElement,
  tabId: string,
  path: string,
  ready: () => boolean,
): void {
  let queued = false;
  el.addEventListener(
    "scroll",
    () => {
      if (queued) return;
      queued = true;
      requestAnimationFrame(() => {
        queued = false;
        setCachedReadingScroll(tabId, path, el.scrollTop);
      });
    },
    { passive: true },
  );

  const saved = getCachedReadingScroll(tabId, path);
  if (!saved) return;
  let restored = false;
  createEffect(() => {
    if (restored || !ready()) return;
    restored = true;
    // Defer one frame so the compiled pages have committed to the DOM and the
    // container has its full scrollHeight before we set the offset.
    requestAnimationFrame(() => {
      if (el.isConnected) el.scrollTop = saved;
    });
  });
}

interface TypstReadingViewProps {
  result: TypstCompileResult | undefined;
  loading: boolean;
  zoom: number;
  tabId: string;
  path: string;
}

const TypstReadingView: Component<TypstReadingViewProps> = (props) => {
  // In the SVG view a wikilink is a plain `<a>` to `<name>.typ`, which the
  // webview would follow out of the app. Detect the `.typ` target and use in-app
  // navigation.
  const onWikilinkClick = (e: MouseEvent) => {
    const a = (e.target as Element | null)?.closest("a");
    if (!a) return;
    const href = a.getAttribute("href") ?? a.getAttribute("xlink:href") ?? "";
    const [pathPart, hash] = href.split("#");
    // A URL can end in `.typ` too (`inkycap://open?…&file=Note.typ`), so a
    // scheme rules out a wikilink before the extension is checked.
    if (startsWithSchemeAndSlashes(href) || !/\.typ$/i.test(pathPart)) {
      // Other links (URLs, `#link(...)` to files) go through `openLink`, so
      // they open in the browser or default app rather than navigating the
      // webview. The context menu is left alone so "Copy link" works.
      if (e.type === "contextmenu") return;
      const target = href.trim();
      if (target) {
        e.preventDefault();
        void openLink(target);
      }
      return;
    }
    e.preventDefault();
    const baseName = decodeURIComponent(pathPart)
      .replace(/^.*[/\\]/, "")
      .replace(/\.typ$/i, "")
      .trim();
    if (!baseName) return;
    const label = hash ? decodeURIComponent(hash) : undefined;
    if (e.type === "contextmenu") {
      showWikilinkContextMenu(e.clientX, e.clientY, baseName, label);
      return;
    }
    const newTab = e.ctrlKey || e.metaKey || e.button === 1;
    void navigateWikilink(baseName, label, newTab);
  };

  return (
    <div
      class="typst-reading"
      ref={(el) => {
        attachReadingScrollMemory(el, props.tabId, props.path, () => !!props.result);
        attachReadingZoomWheel(el, props.tabId);
      }}
      onClick={onWikilinkClick}
      onAuxClick={onWikilinkClick}
      onContextMenu={onWikilinkClick}
    >
      <Show when={props.loading && !props.result}>
        <div class="typst-reading__status">{t("editor.reading.compiling")}</div>
      </Show>
      <Show when={props.result}>
        {(r) => (
          <>
            <Show when={r().diagnostics.length > 0}>
              <div class="typst-reading__diagnostics">
                <Show when={r().recovered}>
                  <div class="typst-reading__recovered-note">
                    {t("editor.reading.recovered")}
                  </div>
                </Show>
                <For each={r().diagnostics}>
                  {(d) => <DiagnosticRow d={d} notePath={props.path} />}
                </For>
              </div>
            </Show>
            <div class="typst-reading__pages">
              <For each={r().frames}>
                {(frame) => (
                  <div
                    class="typst-reading__page"
                    style={{
                      // Resize the page box rather than transforming it, so the
                      // column stays centred and the container scrolls to the
                      // zoomed size.
                      width: `${frame.width_pt * PT_TO_CSS_PX * props.zoom}px`,
                      height: `${frame.height_pt * PT_TO_CSS_PX * props.zoom}px`,
                    }}
                    ref={(el) => {
                      const svg = sanitizeNoteHtml(frame.svg).querySelector("svg");
                      if (svg) el.replaceChildren(svg);
                    }}
                  />
                )}
              </For>
              <Show when={r().ok && r().frames.length === 0}>
                <div class="typst-reading__status">
                  {t("editor.reading.noPages")}
                </div>
              </Show>
            </div>
          </>
        )}
      </Show>
    </div>
  );
};

interface TypstHtmlReadingViewProps {
  result: TypstHtmlResult | undefined;
  loading: boolean;
  documentFont?: string;
  zoom: number;
  tabId: string;
  path: string;
}

/// Replace the notebox-root paths typst-html writes for `#video` / `#audio`
/// with `blob:` URLs, since WebKitGTK won't stream media from the asset
/// protocol (see media-src.ts). Sources with a scheme are left alone.
async function resolveMediaSources(root: HTMLElement): Promise<void> {
  const media = Array.from(root.querySelectorAll<HTMLMediaElement>("video[src], audio[src]"));
  for (const el of media) {
    const raw = el.getAttribute("src");
    if (!raw || /^[a-z][a-z0-9+.-]*:/i.test(raw)) continue;
    const url = await loadMediaObjectUrl(raw);
    // Skip if the view was torn down/replaced while we were loading.
    if (url && el.isConnected) el.src = url;
    else if (url) URL.revokeObjectURL(url);
  }
}

// Images need nothing here: typst-html inlines them as `data:` URIs. Aligned
// images are handled by the backend's `html-align` shim.

const TypstHtmlReadingView: Component<TypstHtmlReadingViewProps> = (props) => {
  // Font size comes from CSS (`--md-body-size`); only the family is set here.
  //
  // Zoom uses CSS `zoom`, which scales the whole layout so the measure and
  // images grow with the text and it still reflows. A font-size change would
  // squeeze the line length, and `transform: scale()` doesn't affect layout, so
  // the container wouldn't scroll to the full size.
  const contentStyle = () => {
    const s: Record<string, string> = {};
    if (props.documentFont) {
      s["font-family"] = `"${props.documentFont}", var(--editor-font-body, sans-serif)`;
    }
    if (props.zoom !== 1) s["zoom"] = String(props.zoom);
    return s;
  };

  // Wikilinks compile to `<a class="inkycap-wikilink" data-target="<name>">`;
  // route clicks through in-app navigation instead of letting the webview
  // follow the href.
  const onWikilinkClick = (e: MouseEvent) => {
    const a = (e.target as HTMLElement | null)?.closest<HTMLAnchorElement>(
      "a.inkycap-wikilink",
    );
    if (!a) {
      // Other links go through `openLink` (browser or default app). The context
      // menu is left alone so "Copy link" works.
      if (e.type === "contextmenu") return;
      const other = (e.target as HTMLElement | null)?.closest<HTMLAnchorElement>(
        "a[href]",
      );
      const href = other?.getAttribute("href")?.trim();
      if (href) {
        e.preventDefault();
        void openLink(href);
      }
      return;
    }
    e.preventDefault();
    const rawName = a.dataset.target ?? "";
    const baseName = rawName.split("::")[0].split("#")[0].trim();
    if (!baseName) return;
    const label = rawName.includes("::")
      ? rawName.split("::")[1].trim() || undefined
      : undefined;
    if (e.type === "contextmenu") {
      showWikilinkContextMenu(e.clientX, e.clientY, baseName, label);
      return;
    }
    const newTab = e.ctrlKey || e.metaKey || e.button === 1;
    void navigateWikilink(baseName, label, newTab);
  };

  return (
    <div
      class="typst-reading typst-reading--html"
      ref={(el) => {
        attachReadingScrollMemory(el, props.tabId, props.path, () => !!props.result?.html);
        attachReadingZoomWheel(el, props.tabId);
      }}
      onClick={onWikilinkClick}
      onAuxClick={onWikilinkClick}
      onContextMenu={onWikilinkClick}
    >
      <Show when={props.loading && !props.result}>
        <div class="typst-reading__status">{t("editor.reading.compiling")}</div>
      </Show>
      <Show when={props.result}>
        {(r) => (
          <>
            <Show when={r().diagnostics.length > 0}>
              <div class="typst-reading__diagnostics">
                <Show when={r().recovered}>
                  <div class="typst-reading__recovered-note">
                    {t("editor.reading.recovered")}
                  </div>
                </Show>
                <For each={r().diagnostics}>
                  {(d) => <DiagnosticRow d={d} notePath={props.path} />}
                </For>
              </div>
            </Show>
            <Show when={r().html}>
              <div
                class="typst-reading__html-content"
                style={contentStyle()}
                ref={(el) => {
                  // This element survives recompiles, so refill it whenever the
                  // HTML changes.
                  createEffect(() => {
                    const html = r().html;
                    // Release any object URLs from the previous render first.
                    revokeBlobUrls(el);
                    el.replaceChildren(sanitizeNoteHtml(html));
                    void resolveMediaSources(el);
                  });
                }}
              />
            </Show>
            <Show when={r().ok && !r().html}>
              <div class="typst-reading__status">
                {t("editor.reading.noHtml")}
              </div>
            </Show>
          </>
        )}
      </Show>
    </div>
  );
};

function ipcErrorToResult(err: unknown): TypstCompileResult {
  return {
    ok: false,
    recovered: false,
    frames: [],
    diagnostics: [
      {
        severity: "error",
        message: errorText(err),
        primary: null,
        trace: [],
        hints: [],
      },
    ],
  };
}

function ipcErrorToHtmlResult(err: unknown): TypstHtmlResult {
  return {
    ok: false,
    recovered: false,
    html: "",
    diagnostics: [
      {
        severity: "error",
        message: errorText(err),
        primary: null,
        trace: [],
        hints: [],
      },
    ],
  };
}

export default TypstEditor;
