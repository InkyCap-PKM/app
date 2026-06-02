// Read-only version-compare view: an inline diff between a note's current
// content and a past version, opened from the "History" list. Renders the
// current note with everything that changed since the chosen version
// highlighted inline (deletions shown above their replacement) via
// `@codemirror/merge`'s unified merge view. The editor is fully read-only — this
// is for *reading* a diff, not editing; bringing the old version back is the
// explicit Restore action in the header.

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

  // Persist the (chunk-restored) doc back to the note, debounced so a burst of
  // chunk restores coalesces into one write. A restore is an ordinary edit the
  // user then Syncs — lossless (earlier content stays in git history).
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

  /** Per-chunk control: only "Restore" (revert this region to the old version).
   *  "Accept" is intentionally omitted — in a unified merge it would rewrite the
   *  *comparison baseline*, which is meaningless here (the baseline is the chosen
   *  past version, not something to mutate). */
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
            // Not typeable (a compare view, not free editing), but the per-chunk
            // Restore buttons dispatch programmatically, so reverting a single
            // change still works. `editable:false` blocks DOM input; it does not
            // block those dispatches.
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
              // The merge base theme (a) positions the per-chunk controls
              // `position: absolute` at the chunk's top-right — which collapses
              // to invisible on a pure-insertion chunk (its deleted-text widget
              // has no height) — and (b) styles `.cm-deletedChunk button` as
              // white-on-transparent (meant for its coloured accept/reject
              // backgrounds). Both rules out-specify a plain class, so we
              // override them here in the editor theme (higher precedence than
              // the base theme): float the controls into normal flow and give the
              // Restore button the app's muted-button look so it's actually visible.
              ".cm-deletedChunk": { position: "relative" },
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
