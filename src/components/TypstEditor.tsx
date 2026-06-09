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
} from "solid-js";
import * as ipc from "../lib/ipc";
import { buildChecker } from "../lib/spellchecker";
import { loadMediaObjectUrl, revokeBlobUrls } from "../lib/media-src";
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
  canGoBack,
  canGoForward,
  goBack,
  goForward,
  getCachedEditorState,
  setCachedEditorState,
  getCachedScroll,
  getCachedReadingScroll,
  setCachedReadingScroll,
  closeTab,
  tabReadingFormat,
  setTabReadingFormat,
} from "../stores/tabs";
import { navigateWikilink, showWikilinkContextMenu } from "../lib/wikilink-nav";
import { isDocumentationWindow } from "../lib/docs-window";
import { searchHighlights } from "../stores/search";
import { pathEquals } from "../lib/paths";
import { onFileChanged } from "../lib/events";
import type { TypstCompileResult, TypstHtmlResult, TypstDiagnostic } from "../lib/types";
import { EditorView } from "@codemirror/view";
import { createTypstEditor, type TypstEditorHandle } from "../editor/typst-editor";
import { getLspClient, lspReady } from "../stores/lsp";
import { filePathToUri, createLspDiagnosticsUpdater } from "../editor/lsp";
import { noteboxInfo } from "../stores/notebox";
import { registerEditorView, unregisterEditorView } from "../stores/editor";
import { trackWrite, awaitPendingWrite } from "../stores/editor-writes";
import { resolveTextFontSync } from "../lib/fontResolver";
import { toastError } from "../stores/toasts";
import {
  isEnabled as isScrollEnabled,
  canScrollNavBack,
  canScrollNavForward,
  getAnchorPath,
  getScrollDirection,
  scrollNavBack,
  scrollNavForward,
} from "../stores/journal-scroll";
import {
  BrainCircuit,
  ArrowUpFromDot,
  ArrowDownToDot,
  ArrowLeft,
  ArrowRight,
  BookA,
  FileCode,
  Code,
  PenLine,
  Eye,
  FlaskConical,
} from "lucide-solid";
import JournalScrollPill from "./JournalScrollPill";
import JournalScrollView from "./JournalScrollView";
import { DiagnosticRow } from "./DiagnosticRow";

export interface TypstEditorProps {
  path: string;
  tabId: string;
  onDirtyChange?: (dirty: boolean) => void;
}

const AUTOSAVE_DEBOUNCE_MS = 1500;

type TypstMode = "source" | "live" | "reading";

/// Select a search-match range and scroll it into view. The CodeMirror
/// selection itself acts as the visual highlight, which is the cheapest
/// and most native way to draw the user's eye to the match.
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

function scrollToHeadingLabel(handle: TypstEditorHandle, doc: string, label: string) {
  const escaped = label.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const byLabel = new RegExp(`^=+\\s+.*<${escaped}>\\s*$`, "m");
  const byText = new RegExp(`^=+\\s+${escaped}\\s*(?:<[^>]+>)?\\s*$`, "im");
  const match = doc.match(byLabel) ?? doc.match(byText);
  if (match?.index !== undefined) {
    const pos = match.index;
    const view = handle.view;
    view.dispatch({
      selection: { anchor: pos },
      effects: EditorView.scrollIntoView(pos, { y: "start", yMargin: 16 }),
    });
    view.focus();
  }
}

const TypstEditor: Component<TypstEditorProps> = (props) => {
  // Reading-view render format is a per-tab override (so two panes showing
  // the same note in reading mode can differ), falling back to the user's
  // default. Reactive via the tab store.
  const readingFormat = () => tabReadingFormat(props.tabId);
  const setReadingFormat = (fmt: "svg" | "html") =>
    setTabReadingFormat(props.tabId, fmt);

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

  async function flushSave(): Promise<void> {
    if (saveTimer === null) return;
    cancelPendingSave();
    if (!currentPath) return;
    const text = docText();
    if (text === lastSaved) {
      setDirty(false);
      return;
    }
    const targetPath = currentPath;
    const writePromise = (async () => {
      try {
        await ipc.writeFileContent(targetPath, text);
        if (targetPath === currentPath) {
          lastSaved = text;
          setDirty(false);
        }
        document.dispatchEvent(
          new CustomEvent("inkycap:note-saved", { detail: { path: targetPath } }),
        );
      } catch (err) {
        console.error("[TypstEditor] flush save failed:", err);
        toastError(t("editor.toast.saveFailed"), err);
      }
    })();
    trackWrite(targetPath, writePromise);
    await writePromise;
  }

  function scheduleSave(text: string) {
    if (text === lastSaved) {
      setDirty(false);
      return;
    }
    cancelPendingSave();
    const targetPath = currentPath;
    saveTimer = setTimeout(() => {
      saveTimer = null;
      if (!targetPath || targetPath !== currentPath) return;
      const writePromise = (async () => {
        try {
          await ipc.writeFileContent(targetPath, text);
          if (targetPath === currentPath) {
            lastSaved = text;
            setDirty(false);
          }
          // Notify the sidebar that metadata may have changed (reindex
          // happens inside writeFileContent on the backend).
          document.dispatchEvent(
            new CustomEvent("inkycap:note-saved", { detail: { path: targetPath } }),
          );
        } catch (err) {
          toastError(t("editor.toast.autoSaveFailed"), err);
        }
      })();
      trackWrite(targetPath, writePromise);
    }, AUTOSAVE_DEBOUNCE_MS);
  }

  function onDocUpdate(text: string) {
    if (suppressChange) return;
    setDocText(text);
    if (text !== lastSaved) {
      setDirty(true);
      scheduleSave(text);
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

  // True for the first file-load reconciliation after we restored editor
  // state from the per-tab cache. The createEffect that watches the disk
  // content uses this to skip the setText() that would otherwise clobber the
  // cached doc (and reset history) when the tab is reactivated.
  let usedCachedState = false;

  function mountEditor() {
    if (!editorMountRef || editorHandle) return;
    const client = getLspClient();
    const uri = props.path ? buildDocumentUri(props.path) : undefined;
    const cached = getCachedEditorState(props.tabId, props.path);
    editorHandle = createTypstEditor({
      parent: editorMountRef,
      doc: docText(),
      visualMode: currentMode() === "live",
      smartIndentLists: settings.editor.smart_indent_lists,
      enterInsertsLineBreak: settings.editor.enter_inserts_line_break,
      typewriterMode: settings.editor.typewriter_mode,
      selectionToolbar: settings.editor.selection_toolbar,
      commandPalette: settings.editor.command_palette,
      lspClient: client,
      documentUri: uri,
      onUpdate: onDocUpdate,
      restoreState: cached,
      restoreScroll: getCachedScroll(props.tabId, props.path),
    });
    if (cached) {
      usedCachedState = true;
      currentPath = props.path;
      setDocText(editorHandle.getText());
      if (currentMode() === "live") {
        editorHandle.ensureParsed();
      }
    }
    registerEditorView(props.tabId, editorHandle);
  }

  function destroyEditor() {
    if (editorHandle) {
      // Snapshot the editor state before tearing the view down so the next
      // mount of this tab can restore doc + selection + undo history + scroll
      // position.
      if (currentPath) {
        try {
          setCachedEditorState(
            props.tabId,
            currentPath,
            editorHandle.serializeState(),
            editorHandle.scrollSnapshot(),
          );
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
    // Fire any pending edit to disk before unmounting. flushSave()
    // registers the write in `pendingWrites` keyed by path, so a
    // subsequent mount of the same path (via createResource below)
    // awaits this completion before reading — preventing the
    // stale-read-then-overwrite race that loses in-progress edits.
    void flushSave();
    cleanupDiagnostics?.();
    lspCloseDocument();
    destroyEditor();
  });

  // ── Mode handling ──────────────────────────────────────

  // Tooling files (scaffolds, package manifests, package lib.typ) live
  // under `.inkycap/scaffolds/` and `.inkycap/packages/`. They are author-
  // facing source artifacts, not user notes — visual/reading modes and the
  // tab back/forward stack don't apply, so we hide the editor header for
  // them and lock to source mode.
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

  // Journal Scroll replaces the editor for this tab. Toggling scroll does
  // not remount this component — only the <Show> blocks in the render swap
  // the editor's mount node in and out of the DOM. So when scroll turns on
  // we must tear down the CodeMirror handle ourselves; otherwise it keeps
  // pointing at a now-detached DOM node, the re-rendered editor shows blank,
  // and operations on the stale handle can crash. When scroll turns back
  // off, the mount node's ref callback re-runs and re-creates the editor
  // (editorHandle is undefined again), restoring the cached doc + history.
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
      [() => settings.editor.focus_mode, () => settings.editor.focus_dim, currentMode],
      ([mode, dim, editorMode]) => {
        if (!editorHandle) return;
        const isVisual = editorMode === "live";
        if (isVisual && mode !== "none") {
          editorHandle.setFocusMode(mode, dim);
        } else {
          editorHandle.setFocusMode("none", false);
        }
      },
    ),
  );

  createEffect(
    on([() => settings.editor.typewriter_mode, currentMode], ([enabled, editorMode]) => {
      // Typewriter scrolling only applies in the visual editor; the handle
      // gates on its own visual-mode flag, but we also pass the live setting
      // through so toggling it (or switching modes) reconfigures immediately.
      editorHandle?.setTypewriterMode(enabled && editorMode === "live");
    }),
  );

  // Spellcheck: build a Hunspell-backed checker from the active dictionaries +
  // the notebox user dictionary, then install it on the editor. Rebuilds when
  // the toggle or language set changes, or when the dictionary file changes
  // (Mycelial rescue / "Add to dictionary" dispatch `inkycap:dictionary-changed`).
  // A generation counter discards a stale async build if settings change again
  // before it finishes.
  let spellGen = 0;
  async function rebuildSpellChecker() {
    const gen = ++spellGen;
    if (!editorHandle) return;
    const enabled = settings.editor.spellcheck_languages ?? [];
    if (!settings.editor.spellcheck || enabled.length === 0) {
      editorHandle.setSpellChecker(null);
      return;
    }
    // The status-bar chip narrows checking to one language, or "all" (union of
    // enabled). A stale active code (its dictionary was disabled) falls back to
    // the full enabled set.
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
    on(() => settings.editor.selection_toolbar, (enabled) => {
      editorHandle?.setSelectionToolbar(enabled);
    }),
  );

  createEffect(
    on(() => settings.editor.command_palette, (enabled) => {
      editorHandle?.setCommandPalette(enabled);
    }),
  );

  // Refresh editor-owned translated UI when the user switches UI language.
  // `defer: true` skips the initial run — the editor is built with the active
  // locale already, so only subsequent switches need a refresh.
  createEffect(
    on(localeVersion, () => editorHandle?.relocalize(), { defer: true }),
  );

  // ── File loading ───────────────────────────────────────
  // The component is keyed on `path` in MainContent, so it remounts for
  // each file. We load the file content once on mount.

  const [content] = createResource(
    () => props.path,
    async (path) => {
      // If a previous editor instance for this path is still flushing
      // an in-progress save, wait for it before reading from disk —
      // otherwise we'd read the pre-flush content and a subsequent edit
      // would clobber the just-written changes.
      await awaitPendingWrite(path);
      try {
        return await ipc.readFileContent(path);
      } catch (err) {
        toastError(t("editor.toast.openFailed"), err);
        closeTab(props.tabId);
        return undefined;
      }
    },
  );

  // Issue 3A: highlight ALL of the opened file's search matches, not just the
  // clicked line. The search store records every match for the path when a
  // result is opened; mark them here. Source/live only — the char positions are
  // source offsets (same constraint as scrollToMatch); reading mode clears them.
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

      // When the editor was restored from cache, the buffer already holds
      // the user's most recent doc (possibly with unsaved edits and a live
      // undo stack). Don't call setText() — that would reset history and
      // discard those edits. Just reconcile the dirty flag against disk.
      const restoredFromCache = usedCachedState;
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
              editorHandle.ensureParsed();
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
          // Two rAFs let CM6 finish layout before we scroll, matching the
          // heading-jump path. Without this the line measurements are
          // pre-layout and scrollIntoView lands in the wrong spot.
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
              scrollToHeadingLabel(editorHandle, editorHandle.getText(), pendingHeading);
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

      // The doc is now loaded for this path; mark its search matches (if this
      // file is the one a search result was opened from). Reads are untracked
      // here because the enclosing effect uses `on`, so this doesn't subscribe
      // the file-load effect to the search store.
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
        scrollToHeadingLabel(editorHandle, doc, label);
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

  // ── Flush-on-demand for sidebar property edits ─────────
  // The sidebar dispatches this before calling updateProperty so that
  // the disk content is current with the editor buffer. The event detail
  // carries a `done` promise resolver so the caller can await completion.
  const onFlushRequest = (e: Event) => {
    const detail = (e as CustomEvent).detail;
    if (detail?.path !== currentPath) { detail?.done?.(); return; }
    cancelPendingSave();
    const text = docText();
    if (text !== lastSaved && currentPath) {
      ipc.writeFileContent(currentPath, text).then(() => {
        lastSaved = text;
        setDirty(false);
        detail?.done?.();
      }).catch((err) => {
        console.error("[TypstEditor] flush for property edit failed:", err);
        detail?.done?.();
      });
    } else {
      detail?.done?.();
    }
  };
  document.addEventListener("inkycap:flush-editor", onFlushRequest);
  onCleanup(() => document.removeEventListener("inkycap:flush-editor", onFlushRequest));

  // Re-read the open file from disk and replace the CM6 buffer when it differs.
  // Shared by the sidebar property-edit reload and the post-sync reload. The
  // buffer-equality check makes a no-change reload a cheap no-op (so a file
  // whose content didn't actually move never churns the editor).
  async function reloadFromDisk() {
    if (!currentPath) return;
    try {
      const freshContent = await ipc.readFileContent(currentPath);
      // Compare against the actual editor buffer (not the cached docText
      // signal) — otherwise transient signal updates can make the early-return
      // fire when the buffer is still stale.
      const bufferText = editorHandle?.getText() ?? docText();
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
          // Visual mode reloads need a parse-aware rebuild. setText alone
          // runs visualField's update against a possibly-partial tree, so
          // pre-existing Replace widgets can mask the new content and the
          // editor renders blank. rebuildVisual() retries until the tree
          // spans the new doc, then dispatches the rebuild effect.
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
  // When the sidebar property editor writes to disk, reload the file so the
  // CM6 buffer reflects the updated #note(...) call. The sidebar flushes the
  // editor before writing, so reloading here never drops unsaved work.
  const onPropChanged = (e: Event) => {
    const detail = (e as CustomEvent).detail;
    if (detail?.path !== currentPath) return;
    cancelPendingSave(); // synchronous, to prevent a save racing the reload
    void reloadFromDisk();
  };
  document.addEventListener("inkycap:note-property-changed", onPropChanged);
  onCleanup(() => document.removeEventListener("inkycap:note-property-changed", onPropChanged));

  // ── Post-sync reload ───────────────────────────────────
  // A git Sync / Check for updates can rewrite the open note on disk (a merged
  // or fast-forwarded version). Reload it so the buffer isn't stale — but only
  // when the buffer is clean: a dirty buffer holds unsaved edits we must not
  // clobber (those edits stay, and merge on the next Sync). Path-agnostic: every
  // editor re-reads its own file, and the buffer-equality guard makes untouched
  // files a no-op.
  const onNoteboxSynced = () => {
    if (!currentPath || dirty) return;
    cancelPendingSave();
    void reloadFromDisk();
  };
  document.addEventListener("inkycap:notebox-synced", onNoteboxSynced);
  onCleanup(() => document.removeEventListener("inkycap:notebox-synced", onNoteboxSynced));

  // ── External file change (another window / external editor) ─────
  // The same note can be open in another window, or edited by an external
  // tool. The notebox file watcher emits `notebox:file-changed` (targeted at
  // this window). Reload the buffer so it doesn't go stale — but only when
  // it's clean: a dirty buffer holds unsaved edits we must not clobber (this
  // window keeps them; they win on its next save). The buffer-equality guard
  // inside reloadFromDisk makes this editor's *own* save a cheap no-op.
  let fileChangedUnlisten: (() => void) | undefined;
  void onFileChanged((payload) => {
    if (!currentPath || dirty) return;
    if (!pathEquals(payload.path, currentPath)) return;
    cancelPendingSave();
    void reloadFromDisk();
  }).then((un) => {
    fileChangedUnlisten = un;
  });
  onCleanup(() => fileChangedUnlisten?.());

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

  const [compileResult] = createResource<
    TypstCompileResult | undefined,
    readonly [string, TypstMode, "svg" | "html"]
  >(
    () => [props.path, currentMode(), readingFormat()] as const,
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
    readonly [string, TypstMode, "svg" | "html"]
  >(
    () => [props.path, currentMode(), readingFormat()] as const,
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
    // These vars are read by both the editor and the journal-scroll view,
    // so they live on documentElement rather than the per-editor container.
    // When readable-line-length is on, max-width caps the content and
    // side-padding-min floors the gap so narrow panes still keep some
    // breathing room — the floor scales with viewport so wider windows
    // get a more generous gutter. When off, both collapse to a no-op and
    // content goes edge-to-edge.
    const root = document.documentElement;
    // --md-body-font and --verse-font are owned by applyFontSettings()
    // in stores/theme.ts, driven by UserSettings.fonts. Editor body
    // size is independent (numeric editor preference, not a family).
    root.style.setProperty("--md-body-size", `${s.body_font_size}px`);
    root.style.setProperty(
      "--md-max-width",
      s.readable_line_length ? `${s.max_line_width}ch` : "100%",
    );
    root.style.setProperty(
      "--md-side-padding-min",
      // With the comfortable measure off the text runs full-width; keep a
      // one-character gutter on each edge so it isn't flush against the panel
      // borders. `ch` tracks the body font so the breathing room scales.
      s.readable_line_length ? "clamp(16px, 4vw, 64px)" : "1ch",
    );
  });

  // The header back/forward arrows mean different things depending on
  // whether Journal Scroll is on. With scroll off they walk the tab's file
  // history; with scroll on they walk the within-scroll wikilink history
  // (and are disabled until the user has actually jumped via a wikilink).
  const navCanBack = () =>
    isScrollEnabled(props.tabId)
      ? canScrollNavBack(props.tabId)
      : canGoBack(props.tabId);
  const navCanForward = () =>
    isScrollEnabled(props.tabId)
      ? canScrollNavForward(props.tabId)
      : canGoForward(props.tabId);
  const doNavBack = () =>
    isScrollEnabled(props.tabId)
      ? scrollNavBack(props.tabId)
      : goBack(props.tabId);
  const doNavForward = () =>
    isScrollEnabled(props.tabId)
      ? scrollNavForward(props.tabId)
      : goForward(props.tabId);

  // Journal Scroll status line, shown centred in the editor header while
  // scroll is on — a quiet reminder of the feed's direction and anchor.
  const scrollStatusText = () => {
    const anchor = getAnchorPath(props.tabId);
    const base = anchor.split("/").pop() ?? anchor;
    const title = base.replace(/\.typ$/i, "");
    return t(
      getScrollDirection(props.tabId) === "desc"
        ? "journalScroll.status.recentFirst"
        : "journalScroll.status.oldestFirst",
      { anchor: title },
    );
  };

  return (
    <div class="typst-editor-container" ref={containerRef}>
      <Show when={!isToolingFile()}>
      <div class="editor-header">
        <div class="editor-header__nav" role="group" aria-label={t("editor.nav.label")}>
          <button
            type="button"
            class="editor-header__nav-btn"
            classList={{ "is-disabled": !navCanBack() }}
            disabled={!navCanBack()}
            onClick={() => doNavBack()}
            title={t("editor.nav.back")}
            aria-label={t("editor.nav.back")}
          >
            <ArrowLeft size={14} />
          </button>
          <button
            type="button"
            class="editor-header__nav-btn"
            classList={{ "is-disabled": !navCanForward() }}
            disabled={!navCanForward()}
            onClick={() => doNavForward()}
            title={t("editor.nav.forward")}
            aria-label={t("editor.nav.forward")}
          >
            <ArrowRight size={14} />
          </button>
        </div>

        <div class="editor-header__center">
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
        </div>

        <div class="editor-header__right-group">
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
          <JournalScrollPill tabId={props.tabId} anchorPath={props.path} />
        <Show when={!isScrollEnabled(props.tabId) && currentMode() === "reading"}>
          <div
            class="editor-header__mode-toggle editor-header__format-toggle"
            role="group"
            aria-label={t("readingFormat.toggle")}
          >
            <button
              type="button"
              class="editor-header__mode-seg editor-header__format-seg is-format-svg"
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
              class="editor-header__mode-seg editor-header__format-seg is-format-html"
              classList={{ "is-active": readingFormat() === "html" }}
              onClick={() => setReadingFormat("html")}
              title={t("readingFormat.html.title")}
              aria-pressed={readingFormat() === "html"}
            >
              <FileCode size={14} />
              <span>{t("readingFormat.html")}</span>
            </button>
          </div>
        </Show>
        <Show when={!isScrollEnabled(props.tabId)}>
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
        </Show>
        </div>
      </div>
      </Show>

      <Show when={isDocumentationWindow()}>
        <div class="docs-banner" role="note">
          <FlaskConical class="docs-banner__icon" size={15} />
          <span>{t("docs.ephemeralBanner")}</span>
        </div>
      </Show>

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
            tabId={props.tabId}
            path={props.path}
          />
        }>
          <TypstReadingView
            result={compileResult()}
            loading={compileResult.loading}
            tabId={props.tabId}
            path={props.path}
          />
        </Show>
      </Show>
    </div>
  );
};

const PT_TO_CSS_PX = 4 / 3;

/** Persist and restore the scroll offset of a reading-mode container across
 *  tab switches. The `.typst-reading` div is the scroll surface and is
 *  unmounted/remounted whenever the active tab changes, so — like the CM6
 *  editor — it would otherwise snap back to the top. We remember the user's
 *  place (rAF-throttled, one write per frame) keyed by tab + path, and re-apply
 *  it once the compiled content has laid out. The cached offset lives until the
 *  tab is closed (see `closeTab`), matching source/live mode. */
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
  tabId: string;
  path: string;
}

const TypstReadingView: Component<TypstReadingViewProps> = (props) => {
  // The SVG reading view renders Typst's own paged output, where a wikilink is a
  // plain `link("<name>.typ")` — an `<a>` with no class/data-target (unlike the
  // HTML target). Without interception the webview follows that href and
  // navigates away from the app (notebox reopens / open-notebox dialog). Detect
  // wikilinks by their `.typ` destination and route them through the same in-app
  // navigation the visual editor uses; external links (no `.typ`) pass through.
  const onWikilinkClick = (e: MouseEvent) => {
    const a = (e.target as Element | null)?.closest("a");
    if (!a) return;
    const href = a.getAttribute("href") ?? a.getAttribute("xlink:href") ?? "";
    const [pathPart, hash] = href.split("#");
    if (!/\.typ$/i.test(pathPart)) return; // not a wikilink — let it through
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
      ref={(el) => attachReadingScrollMemory(el, props.tabId, props.path, () => !!props.result)}
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
                  {(d) => <DiagnosticRow d={d} />}
                </For>
              </div>
            </Show>
            <div class="typst-reading__pages">
              <For each={r().frames}>
                {(frame) => (
                  <div
                    class="typst-reading__page"
                    style={{
                      width: `${frame.width_pt * PT_TO_CSS_PX}px`,
                      height: `${frame.height_pt * PT_TO_CSS_PX}px`,
                    }}
                    ref={(el) => {
                      const parser = new DOMParser();
                      const doc = parser.parseFromString(frame.svg, "text/html");
                      const svg = doc.querySelector("svg");
                      if (svg) {
                        svg.querySelectorAll("script").forEach((s) => s.remove());
                        el.replaceChildren(svg);
                      }
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
  tabId: string;
  path: string;
}

/// typst-html emits `#video`/`#audio` as `<video src="/Assets/clip.mp4">` with
/// a notebox-root-absolute path, which the webview can't load directly. Replace
/// each src with a `blob:` URL of the file's bytes so the players work in the
/// HTML reading view (WebKitGTK won't stream media from the asset protocol —
/// see media-src.ts). srcs that already carry a scheme are left untouched.
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

// Note: images need no frontend src resolution here. typst-html inlines every
// `#image(...)` as a self-contained base64 `data:` URI (typst-html's IMAGE_RULE
// → `convert_image_to_base64_url`), so `<img>` tags already render. Only
// `<video>`/`<audio>` (not inlined) need the blob resolution above. Aligned
// images are handled on the backend via the `#show align: html-align` shim
// (typst-html otherwise drops `align()` blocks).

const TypstHtmlReadingView: Component<TypstHtmlReadingViewProps> = (props) => {
  // Font size is intentionally left to CSS (--md-body-size) so the
  // content zoom (Ctrl+= / Ctrl+-) applies here. Only the font family
  // is pinned from settings.
  const contentStyle = () => {
    const s: Record<string, string> = {};
    if (props.documentFont) {
      s["font-family"] = `"${props.documentFont}", var(--editor-font-body, sans-serif)`;
    }
    return s;
  };

  // Wikilinks compile to plain `<a class="inkycap-wikilink" href="<name>.typ"
  // data-target="<name>">`. Without interception the browser would follow that
  // href and navigate the webview away from the app (which manifests as the
  // notebox reopening or the open-notebox dialog). Delegate clicks on the
  // container and route them through the same in-app navigation the visual
  // editor uses, so reading view browses the notebox like every other mode.
  const onWikilinkClick = (e: MouseEvent) => {
    const a = (e.target as HTMLElement | null)?.closest<HTMLAnchorElement>(
      "a.inkycap-wikilink",
    );
    if (!a) return;
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
      ref={(el) => attachReadingScrollMemory(el, props.tabId, props.path, () => !!props.result?.html)}
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
                  {(d) => <DiagnosticRow d={d} />}
                </For>
              </div>
            </Show>
            <Show when={r().html}>
              <div
                class="typst-reading__html-content"
                style={contentStyle()}
                ref={(el) => {
                  const parser = new DOMParser();
                  const doc = parser.parseFromString(r().html, "text/html");
                  doc.querySelectorAll("script").forEach((s) => s.remove());
                  const body = doc.body;
                  if (body) {
                    // Release any object URLs from the previous render first.
                    revokeBlobUrls(el);
                    while (el.firstChild) el.removeChild(el.firstChild);
                    while (body.firstChild) el.appendChild(body.firstChild);
                    void resolveMediaSources(el);
                  }
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
