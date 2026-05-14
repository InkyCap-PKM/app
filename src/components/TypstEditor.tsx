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
import { settings } from "../stores/settings";
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
  closeTab,
} from "../stores/tabs";
import type { TypstCompileResult, TypstHtmlResult, TypstDiagnostic } from "../lib/types";
import { EditorView } from "@codemirror/view";
import { createTypstEditor, type TypstEditorHandle } from "../editor/typst-editor";
import { getLspClient, lspReady } from "../stores/lsp";
import { filePathToUri, createLspDiagnosticsUpdater } from "../editor/lsp";
import { vaultInfo } from "../stores/vault";
import { setActiveEditorView } from "../stores/editor";
import { readingFormat, setReadingFormat } from "../stores/reading-format";
import { resolveTextFontSync } from "../lib/fontResolver";
import { toastError } from "../stores/toasts";

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
    try {
      await ipc.writeFileContent(currentPath, text);
      lastSaved = text;
      setDirty(false);
    } catch (err) {
      console.error("[TypstEditor] flush save failed:", err);
    }
  }

  function scheduleSave(text: string) {
    if (text === lastSaved) {
      setDirty(false);
      return;
    }
    cancelPendingSave();
    const targetPath = currentPath;
    saveTimer = setTimeout(async () => {
      saveTimer = null;
      if (!targetPath || targetPath !== currentPath) return;
      try {
        await ipc.writeFileContent(targetPath, text);
        lastSaved = text;
        setDirty(false);
        // Notify the sidebar that metadata may have changed (reindex
        // happens inside writeFileContent on the backend).
        document.dispatchEvent(new CustomEvent("inkycap:note-saved"));
      } catch (err) {
        toastError("Auto-save failed", err);
      }
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
    const vault = vaultInfo();
    if (!vault) return filePathToUri(filePath);
    if (filePath.startsWith("/") || filePath.startsWith("\\")) {
      return filePathToUri(filePath);
    }
    return filePathToUri(`${vault.path}/${filePath}`);
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
      selectionToolbar: settings.editor.selection_toolbar,
      commandPalette: settings.editor.command_palette,
      lspClient: client,
      documentUri: uri,
      onUpdate: onDocUpdate,
      restoreState: cached,
    });
    if (cached) {
      usedCachedState = true;
      currentPath = props.path;
      setDocText(editorHandle.getText());
      if (currentMode() === "live") {
        editorHandle.ensureParsed();
      }
    }
    setActiveEditorView(editorHandle);
  }

  function destroyEditor() {
    if (editorHandle) {
      // Snapshot the editor state before tearing the view down so the next
      // mount of this tab can restore doc + selection + undo history.
      if (currentPath) {
        try {
          setCachedEditorState(props.tabId, currentPath, editorHandle.serializeState());
        } catch (err) {
          console.error("[TypstEditor] failed to cache editor state:", err);
        }
      }
      setActiveEditorView(undefined);
      editorHandle.destroy();
      editorHandle = undefined;
    }
  }

  onMount(() => {
    mountEditor();
  });

  onCleanup(() => {
    cancelPendingSave();
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
    on(() => settings.editor.smart_indent_lists, (enabled) => {
      editorHandle?.setSmartIndentLists(enabled);
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

  // ── File loading ───────────────────────────────────────
  // The component is keyed on `path` in MainContent, so it remounts for
  // each file. We load the file content once on mount.

  const [content] = createResource(
    () => props.path,
    async (path) => {
      try {
        return await ipc.readFileContent(path);
      } catch (err) {
        toastError("Could not open file", err);
        closeTab(props.tabId);
        return undefined;
      }
    },
  );

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

  // ── External property edits (sidebar) ──────────────────
  // When the sidebar property editor writes to disk, reload the file
  // so the CM6 buffer reflects the updated #note(...) call.
  const onPropChanged = (e: Event) => {
    const detail = (e as CustomEvent).detail;
    if (detail?.path !== currentPath) return;
    // Cancel pending save immediately (synchronously) to prevent race
    cancelPendingSave();
    (async () => {
      try {
        const freshContent = await ipc.readFileContent(currentPath!);
        // Compare against the actual editor buffer (not the cached
        // docText signal) — otherwise transient signal updates can make
        // the early-return fire when the buffer is still stale.
        const bufferText = editorHandle?.getText() ?? docText();
        if (freshContent === bufferText) {
          // Buffer is already current, but make sure the dirty flag
          // and lastSaved reflect that.
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
        console.error("[TypstEditor] property reload failed:", err);
      }
    })();
  };
  document.addEventListener("inkycap:note-property-changed", onPropChanged);
  onCleanup(() => document.removeEventListener("inkycap:note-property-changed", onPropChanged));

  // ── Wikilink click-to-navigate ────────────────────────
  const onWikilinkNav = (e: Event) => {
    const detail = (e as CustomEvent).detail;
    const target = detail?.target as string | undefined;
    const label = detail?.label as string | undefined;
    const newTab = detail?.newTab as boolean | undefined;
    if (!target) return;
    (async () => {
      try {
        const resolved = await ipc.resolveWikilink(target);
        if (resolved) {
          const name = resolved.replace(/\.typ$/, "").split("/").pop() ?? resolved;
          openTab(
            { type: "file", title: name, path: resolved },
            { forceNewTab: newTab ?? false, headingLabel: label },
          );
        } else {
          const created = await ipc.createNote(target, "");
          const name = created.replace(/\.typ$/, "").split("/").pop() ?? target;
          openTab(
            { type: "file", title: name, path: created },
            { forceNewTab: newTab ?? false },
          );
        }
      } catch (err) {
        console.error("[TypstEditor] wikilink navigate failed:", err);
      }
    })();
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
      s.readable_line_length ? "clamp(16px, 4vw, 64px)" : "0px",
    );
  });

  return (
    <div class="typst-editor-container" ref={containerRef}>
      <Show when={!isToolingFile()}>
      <div class="editor-header">
        <div class="editor-header__nav" role="group" aria-label="Navigation">
          <button
            type="button"
            class="editor-header__nav-btn"
            classList={{ "is-disabled": !canGoBack(props.tabId) }}
            disabled={!canGoBack(props.tabId)}
            onClick={() => goBack(props.tabId)}
            title="Go back"
            aria-label="Go back"
          >
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
              <path d="M19 12H5" />
              <polyline points="12 19 5 12 12 5" />
            </svg>
          </button>
          <button
            type="button"
            class="editor-header__nav-btn"
            classList={{ "is-disabled": !canGoForward(props.tabId) }}
            disabled={!canGoForward(props.tabId)}
            onClick={() => goForward(props.tabId)}
            title="Go forward"
            aria-label="Go forward"
          >
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
              <path d="M5 12h14" />
              <polyline points="12 5 19 12 12 19" />
            </svg>
          </button>
        </div>

        <div class="editor-header__right-group">
        <Show when={currentMode() === "reading"}>
          <button
            type="button"
            class="editor-header__reading-format-btn"
            classList={{ "is-html": readingFormat() === "html" }}
            onClick={() => setReadingFormat(readingFormat() === "svg" ? "html" : "svg")}
            title={readingFormat() === "svg" ? "Viewing as SVG (paginated) — click for HTML (continuous)" : "Viewing as HTML (continuous) — click for SVG (paginated)"}
            aria-label="Toggle reading format"
          >
            <Show when={readingFormat() === "svg"} fallback={
              <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
                <path d="M4 19.5v-15A2.5 2.5 0 0 1 6.5 2H19a1 1 0 0 1 1 1v18a1 1 0 0 1-1 1H6.5a1 1 0 0 1 0-5H20" />
                <path d="m8 13 4-7 4 7" />
                <path d="M9.1 11h5.7" />
              </svg>
            }>
              <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
                <path d="M15 12h-5" />
                <path d="M15 8h-5" />
                <path d="M19 17V5a2 2 0 0 0-2-2H4" />
                <path d="M8 21h12a2 2 0 0 0 2-2v-1a1 1 0 0 0-1-1H11a1 1 0 0 0-1 1v1a2 2 0 1 1-4 0V5a2 2 0 1 0-4 0v2a1 1 0 0 0 1 1h3" />
              </svg>
            </Show>
          </button>
        </Show>
        <div class="editor-header__mode-toggle" role="group" aria-label="Editing mode">
          <button
            type="button"
            class="editor-header__mode-seg"
            classList={{ "is-active": currentMode() === "source" }}
            onClick={() => setMode("source")}
            title="Source edit"
            aria-pressed={currentMode() === "source"}
          >
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
              <polyline points="16 18 22 12 16 6" />
              <polyline points="8 6 2 12 8 18" />
            </svg>
          </button>
          <button
            type="button"
            class="editor-header__mode-seg"
            classList={{ "is-active": currentMode() === "live" }}
            onClick={() => setMode("live")}
            title="Visual edit"
            aria-pressed={currentMode() === "live"}
          >
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
              <path d="M12 20h9" />
              <path d="M16.376 3.622a1 1 0 0 1 3.002 3.002L7.368 18.635a2 2 0 0 1-.855.506l-2.872.838a.5.5 0 0 1-.62-.62l.838-2.872a2 2 0 0 1 .506-.855z" />
            </svg>
          </button>
          <button
            type="button"
            class="editor-header__mode-seg"
            classList={{ "is-active": currentMode() === "reading" }}
            onClick={() => setMode("reading")}
            title="Reading view"
            aria-pressed={currentMode() === "reading"}
          >
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
              <path d="M1 12s4-8 11-8 11 8 11 8-4 8-11 8-11-8-11-8z" />
              <circle cx="12" cy="12" r="3" />
            </svg>
          </button>
        </div>
        </div>
      </div>
      </Show>

      <Show when={currentMode() === "source" || currentMode() === "live"}>
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

      <Show when={currentMode() === "reading"}>
        <Show when={readingFormat() === "svg"} fallback={
          <TypstHtmlReadingView
            result={htmlResult()}
            loading={htmlResult.loading}
            documentFont={resolveTextFontSync(settings.fonts)}
            documentSize={settings.document.text_size ?? undefined}
          />
        }>
          <TypstReadingView
            result={compileResult()}
            loading={compileResult.loading}
          />
        </Show>
      </Show>
    </div>
  );
};

const PT_TO_CSS_PX = 4 / 3;

interface TypstReadingViewProps {
  result: TypstCompileResult | undefined;
  loading: boolean;
}

const TypstReadingView: Component<TypstReadingViewProps> = (props) => {
  return (
    <div class="typst-reading">
      <Show when={props.loading && !props.result}>
        <div class="typst-reading__status">Compiling…</div>
      </Show>
      <Show when={props.result}>
        {(r) => (
          <>
            <Show when={r().diagnostics.length > 0}>
              <div class="typst-reading__diagnostics">
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
                  (No pages produced.)
                </div>
              </Show>
            </div>
          </>
        )}
      </Show>
    </div>
  );
};

const DiagnosticRow: Component<{ d: TypstDiagnostic }> = (props) => (
  <div
    class="typst-reading__diagnostic"
    classList={{
      "typst-reading__diagnostic--error": props.d.severity === "error",
      "typst-reading__diagnostic--warning": props.d.severity === "warning",
    }}
  >
    <div class="typst-reading__diagnostic-line">
      <span class="typst-reading__diagnostic-severity">{props.d.severity}</span>
      <span class="typst-reading__diagnostic-message">{props.d.message}</span>
      <Show when={props.d.primary?.path}>
        <span class="typst-reading__diagnostic-loc">
          {" — "}
          {props.d.primary!.path} @ {props.d.primary!.start}
        </span>
      </Show>
    </div>
    <Show when={props.d.hints.length > 0}>
      <div class="typst-reading__diagnostic-hints">
        <For each={props.d.hints}>
          {(h) => <div>hint: {h}</div>}
        </For>
      </div>
    </Show>
  </div>
);

interface TypstHtmlReadingViewProps {
  result: TypstHtmlResult | undefined;
  loading: boolean;
  documentFont?: string;
  documentSize?: number;
}

const TypstHtmlReadingView: Component<TypstHtmlReadingViewProps> = (props) => {
  const contentStyle = () => {
    const s: Record<string, string> = {};
    if (props.documentFont) {
      s["font-family"] = `"${props.documentFont}", var(--editor-font-body, sans-serif)`;
    }
    if (props.documentSize) {
      s["font-size"] = `${props.documentSize}pt`;
    }
    return s;
  };

  return (
    <div class="typst-reading typst-reading--html">
      <Show when={props.loading && !props.result}>
        <div class="typst-reading__status">Compiling…</div>
      </Show>
      <Show when={props.result}>
        {(r) => (
          <>
            <Show when={r().diagnostics.length > 0}>
              <div class="typst-reading__diagnostics">
                <For each={r().diagnostics}>
                  {(d) => <DiagnosticRow d={d} />}
                </For>
              </div>
            </Show>
            <Show when={r().ok && r().html}>
              <div
                class="typst-reading__html-content"
                style={contentStyle()}
                ref={(el) => {
                  const parser = new DOMParser();
                  const doc = parser.parseFromString(r().html, "text/html");
                  doc.querySelectorAll("script").forEach((s) => s.remove());
                  const body = doc.body;
                  if (body) {
                    while (el.firstChild) el.removeChild(el.firstChild);
                    while (body.firstChild) el.appendChild(body.firstChild);
                  }
                }}
              />
            </Show>
            <Show when={r().ok && !r().html}>
              <div class="typst-reading__status">
                (No HTML produced.)
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
    frames: [],
    diagnostics: [
      {
        severity: "error",
        message: err instanceof Error ? err.message : String(err),
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
    html: "",
    diagnostics: [
      {
        severity: "error",
        message: err instanceof Error ? err.message : String(err),
        primary: null,
        trace: [],
        hints: [],
      },
    ],
  };
}

export default TypstEditor;
