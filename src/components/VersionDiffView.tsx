// Read-only comparison of a note with a past version, opened from the History
// list: the current note with everything changed since that version highlighted
// inline (deletions above their replacement), using `@codemirror/merge`'s
// unified view. Not for editing; the old version is brought back with Restore in
// the header.

import { Component, Show, createSignal, onCleanup, onMount } from "solid-js";
import { EditorView } from "@codemirror/view";
import { EditorState } from "@codemirror/state";
import { unifiedMergeView } from "@codemirror/merge";
import { RotateCcw, X } from "lucide-solid";
import * as ipc from "../lib/ipc";
import { closeTab, invalidateEditorCacheForPath } from "../stores/tabs";
import { toastError } from "../stores/toasts";
import { promptConfirm } from "../stores/prompt";
import { useI18n } from "../lib/i18n";

/** Compact local date+time for the version label. */
function fmtDate(timestamp: number): string {
  return new Date(timestamp * 1000).toLocaleString(undefined, {
    year: "numeric",
    month: "short",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
  });
}

const VersionDiffView: Component<{
  path: string;
  tabId: string;
  version: { commit: string; shortHash: string; timestamp: number };
}> = (props) => {
  const t = useI18n();
  const [error, setError] = createSignal<string | null>(null);
  let host: HTMLDivElement | undefined;
  let view: EditorView | undefined;

  const basename = () => props.path.split("/").pop() ?? props.path;

  // Save the document after chunk restores, debounced so several become one
  // write. A restore is an ordinary edit the user then syncs; earlier content
  // stays in git history.
  let persistTimer: ReturnType<typeof setTimeout> | undefined;
  function schedulePersist() {
    clearTimeout(persistTimer);
    persistTimer = setTimeout(() => {
      if (!view) return;
      const content = view.state.doc.toString();
      ipc
        .writeFileContent(props.path, content)
        .then(() => {
          // Mounted editors of this note reload via the event; inactive (cached)
          // tabs would otherwise restore a stale buffer, so drop their cache.
          invalidateEditorCacheForPath(props.path);
          document.dispatchEvent(new CustomEvent("inkycap:notebox-synced"));
        })
        .catch((err) => toastError(t("history.restoreFailed"), err));
    }, 400);
  }

  /**
   * Per-chunk control: only "Restore" (revert this region to the old version).
   * "Accept" would change the comparison base, which here is the chosen past
   * version.
   */
  function chunkControl(type: "accept" | "reject", action: (e: MouseEvent) => void): HTMLElement {
    if (type === "accept") return document.createElement("span");
    const btn = document.createElement("button");
    btn.className = "version-diff__chunk-btn";
    btn.type = "button";
    btn.textContent = t("versionDiff.restoreChunk");
    btn.title = t("versionDiff.restoreChunkHint");
    btn.addEventListener("click", action);
    return btn;
  }

  onMount(async () => {
    try {
      // Current = the editor doc; version = the `original` it diffs against, so
      // the view reads as "what changed since this version".
      const [current, versionText] = await Promise.all([
        ipc.readFileContent(props.path),
        ipc.gitNoteVersionText(props.path, props.version.commit),
      ]);
      if (!host) return;
      view = new EditorView({
        parent: host,
        state: EditorState.create({
          doc: current,
          extensions: [
            // Not typeable, but the Restore buttons still work: `editable:false`
            // blocks typing, not the buttons' transactions.
            EditorView.editable.of(false),
            EditorView.lineWrapping,
            unifiedMergeView({
              original: versionText,
              // Per-chunk Restore (revert-to-old) — the selective counterpart of
              // the header's whole-note Restore.
              mergeControls: chunkControl,
              gutter: true,
            }),
            EditorView.updateListener.of((u) => {
              if (u.docChanged) schedulePersist();
            }),
            EditorView.theme({
              "&": { height: "100%" },
              ".cm-scroller": { fontFamily: "var(--editor-font, var(--font-mono))" },
              // The merge base theme places the chunk controls with `position:
              // absolute` at the chunk's top right, where they vanish on a pure
              // insertion (its deleted-text widget has no height), and styles
              // `.cm-deletedChunk button` white on transparent. Both outrank a plain
              // class, so they are overridden in the editor theme: the controls go
              // into normal flow, and Restore gets the app's muted button look.
              ".cm-deletedChunk": {
                position: "relative",
                backgroundColor: "color-mix(in srgb, var(--accent-danger) 8%, transparent)",
              },
              ".cm-deletedChunk .cm-chunkButtons": {
                position: "static",
                display: "flex",
                justifyContent: "flex-end",
                gap: "4px",
                padding: "2px 6px 0",
                margin: "0",
              },
              ".cm-deletedChunk .cm-chunkButtons button": {
                border: "1px solid var(--border-primary)",
                borderRadius: "var(--radius-control)",
                background: "var(--bg-secondary)",
                color: "var(--fg-muted)",
                font: "inherit",
                fontSize: "var(--text-xs)",
                padding: "1px 8px",
                margin: "0",
                cursor: "pointer",
              },
              ".cm-deletedChunk .cm-chunkButtons button:hover": {
                background: "var(--bg-hover)",
                color: "var(--fg-secondary)",
              },
              // Added and removed text differ in shape as well as colour, so
              // the difference reads without distinguishing colours: added text
              // is underlined, removed text struck through, and the margin
              // shows + / −. The selectors match the merge base theme's so
              // these win.
              "&.cm-merge-b .cm-changedLine": {
                backgroundColor: "color-mix(in srgb, var(--accent-success) 8%, transparent)",
              },
              "&.cm-merge-b .cm-changedText": {
                background: "none",
                textDecoration: "underline 2px var(--accent-success)",
                textUnderlineOffset: "3px",
              },
              // A line with both additions and removals in it.
              ".cm-inlineChangedLine": {
                backgroundColor: "color-mix(in srgb, var(--fg-muted) 6%, transparent)",
              },
              ".cm-deletedChunk .cm-deletedLine del, &.cm-merge-b .cm-deletedText, .cm-deletedChunk .cm-deletedText": {
                background: "none",
                textDecoration: "line-through var(--accent-danger)",
              },
              ".cm-changeGutter": {
                width: "1.2em",
                padding: "0",
                textAlign: "center",
                fontWeight: "600",
              },
              ".cm-changeGutter .cm-gutterElement": {
                background: "none",
              },
              ".cm-changeGutter .cm-changedLineGutter": {
                background: "none",
                color: "var(--accent-success)",
              },
              ".cm-changeGutter .cm-changedLineGutter::before": { content: '"+"' },
              ".cm-changeGutter .cm-deletedLineGutter": {
                background: "none",
                color: "var(--accent-danger)",
              },
              ".cm-changeGutter .cm-inlineChangedLineGutter": {
                background: "none",
                color: "var(--fg-muted)",
              },
              ".cm-changeGutter .cm-deletedLineGutter::before": { content: '"−"' },
              ".cm-changeGutter .cm-inlineChangedLineGutter::before": { content: '"±"' },
            }),
          ],
        }),
      });
    } catch (err) {
      setError(t("history.viewFailed"));
      toastError(t("history.viewFailed"), err);
    }
  });

  onCleanup(() => {
    clearTimeout(persistTimer);
    view?.destroy();
  });

  async function restore() {
    const ok = await promptConfirm({
      title: t("history.restore.title"),
      message: t("history.restore.confirm", { hash: props.version.shortHash }),
      confirmLabel: t("history.restore.action"),
    });
    if (!ok) return;
    try {
      await ipc.gitRestoreNoteVersion(props.path, props.version.commit);
      // The working note now holds the restored content — reload mounted editors
      // and drop stale caches of inactive tabs, then close this compare view.
      invalidateEditorCacheForPath(props.path);
      document.dispatchEvent(new CustomEvent("inkycap:notebox-synced"));
      closeTab(props.tabId);
    } catch (err) {
      toastError(t("history.restoreFailed"), err);
    }
  }

  return (
    <div class="version-diff">
      <div class="version-diff__header">
        <span class="version-diff__label">
          {t("versionDiff.heading", {
            name: basename(),
            date: fmtDate(props.version.timestamp),
            hash: props.version.shortHash,
          })}
        </span>
        <span class="version-diff__actions">
          <button class="version-diff__btn" onClick={() => void restore()}>
            <RotateCcw size={13} /> {t("history.restore.action")}
          </button>
          <button
            class="version-diff__btn"
            onClick={() => closeTab(props.tabId)}
            title={t("versionDiff.close")}
            aria-label={t("versionDiff.close")}
          >
            <X size={13} />
          </button>
        </span>
      </div>
      <Show
        when={!error()}
        fallback={<p class="sidebar-hint version-diff__error">{error()}</p>}
      >
        <div class="version-diff__editor" ref={host} />
      </Show>
    </div>
  );
};

export default VersionDiffView;
