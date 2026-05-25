// The "History" half of the right-panel "Changes & History" pane: the version
// history of the open note, read from the git commit graph. Each row is a past
// version (who / when / message); clicking opens that version as a read-only
// scratch tab, and Restore writes it back as a new edit to Sync (never rewrites
// history). Shown only for a collaborative notebox — version history is the git
// commit graph, so a non-collaborative notebox has none.

import { Component, For, Show, createResource, createMemo } from "solid-js";
import { History, RotateCcw } from "lucide-solid";
import * as ipc from "../lib/ipc";
import type { GitNoteVersion } from "../lib/types";
import { collaborative } from "../stores/git";
import { openTab } from "../stores/tabs";
import { showToast, toastError } from "../stores/toasts";
import { promptConfirm } from "../stores/prompt";
import { t } from "../lib/i18n";

/** Compact local date+time for a version row. */
function when(unixSeconds: number): string {
  return new Date(unixSeconds * 1000).toLocaleString(undefined, {
    dateStyle: "medium",
    timeStyle: "short",
  });
}

const NoteHistory: Component<{ path: string }> = (props) => {
  // Re-fetch whenever the note or its collaboration state changes. The source
  // is keyed on both so switching notes (or enabling collaboration) refetches.
  const key = createMemo(() => (collaborative() ? props.path : null));
  const [versions, { refetch }] = createResource(key, async (path) => {
    return path ? ipc.gitNoteHistory(path) : ([] as GitNoteVersion[]);
  });

  const basename = () => props.path.split("/").pop() ?? props.path;

  /** Open a past version as a read-only scratch tab. */
  async function viewVersion(v: GitNoteVersion) {
    try {
      const scratch = await ipc.gitOpenNoteVersion(props.path, v.commit);
      openTab(
        {
          type: "file",
          title: t("history.versionTab", { name: basename(), hash: v.shortHash }),
          path: scratch,
        },
        { forceNewTab: true },
      );
    } catch (err) {
      toastError(t("history.viewFailed"), err);
    }
  }

  /** Restore a past version as a new edit (the user then Syncs it). */
  async function restore(e: MouseEvent, v: GitNoteVersion) {
    e.stopPropagation();
    const ok = await promptConfirm({
      title: t("history.restore.title"),
      message: t("history.restore.confirm", { hash: v.shortHash }),
      confirmLabel: t("history.restore.action"),
    });
    if (!ok) return;
    try {
      await ipc.gitRestoreNoteVersion(props.path, v.commit);
      // Reload the open editor so its buffer reflects the restored content.
      document.dispatchEvent(
        new CustomEvent("inkycap:note-property-changed", { detail: { path: props.path } }),
      );
      showToast("success", t("history.restored", { name: basename() }));
      void refetch();
    } catch (err) {
      toastError(t("history.restoreFailed"), err);
    }
  }

  return (
    <div class="note-history">
      <Show
        when={collaborative()}
        fallback={<p class="sidebar-hint">{t("history.notCollaborative")}</p>}
      >
        <Show
          when={!versions.loading}
          fallback={<p class="sidebar-hint">{t("history.loading")}</p>}
        >
          <Show
            when={(versions()?.length ?? 0) > 0}
            fallback={<p class="sidebar-hint">{t("history.empty")}</p>}
          >
            <div class="note-history__list">
              <For each={versions()}>
                {(v, i) => (
                  <div
                    class="sidebar-item note-history__item"
                    onClick={() => void viewVersion(v)}
                    title={t("history.view")}
                  >
                    <span class="sidebar-item__icon note-history__icon">
                      <History size={14} />
                    </span>
                    <span class="note-history__body">
                      <span class="note-history__primary">
                        <span class="sidebar-item__label">
                          {v.message.trim() || t("history.noMessage")}
                        </span>
                        <Show when={i() === 0}>
                          <span class="note-history__badge">{t("history.current")}</span>
                        </Show>
                      </span>
                      <span class="note-history__secondary">
                        {[v.authorName, when(v.timestamp)].filter(Boolean).join(" · ")}
                        {" · "}
                        <span class="note-history__hash">{v.shortHash}</span>
                      </span>
                    </span>
                    <button
                      class="note-history__restore"
                      title={t("history.restore.action")}
                      aria-label={t("history.restore.action")}
                      onClick={(e) => void restore(e, v)}
                    >
                      <RotateCcw size={13} />
                    </button>
                  </div>
                )}
              </For>
            </div>
          </Show>
        </Show>
      </Show>
    </div>
  );
};

export default NoteHistory;
