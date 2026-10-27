// The "History" half of the "Changes & History" pane: the open note's past
// versions from the git history. Each row shows who, when and the message;
// clicking opens that version read-only, and Restore writes it back as a new
// edit to sync (history is never rewritten). Only for collaborative noteboxes,
// since the history is git's.

import { Component, For, Show, createResource, createMemo } from "solid-js";
import { History, RotateCcw, Columns2 } from "lucide-solid";
import * as ipc from "../lib/ipc";
import type { GitNoteVersion } from "../lib/types";
import { collaborative, refreshStatus, syncReviewVersion } from "../stores/git";
import { openVersionDiff, openVersionDiffSplit } from "../stores/tabs";
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
  // Fetch again when the note changes, collaboration is turned on or off, or
  // the files change (sync, pull or revert bump `syncReviewVersion`), so after
  // a sync the list and its "current"/"latest shared" badge are up to date.
  const key = createMemo(() =>
    collaborative() ? { path: props.path, rev: syncReviewVersion() } : null,
  );
  const [versions, { refetch }] = createResource(key, async (k) => {
    return k ? ipc.gitNoteHistory(k.path) : ([] as GitNoteVersion[]);
  });

  const basename = () => props.path.split("/").pop() ?? props.path;

  // Whether the note's file matches the latest commit (the top row). A note can
  // be ahead of the shared history (local edits or a reverted incoming change
  // are committed at the next sync), so the badge says "current" when they match
  // and "latest shared" when they don't. Checked again when `syncReviewVersion`
  // changes (saves, reverts), since a revert changes the file without a commit.
  const [headSync] = createResource(
    () => {
      const v = versions();
      // Depend on the working-tree version so a revert/save re-evaluates.
      syncReviewVersion();
      return collaborative() && v && v.length > 0
        ? { path: props.path, head: v[0].commit }
        : null;
    },
    async (k) => {
      try {
        const [current, head] = await Promise.all([
          ipc.readFileContent(k.path),
          ipc.gitNoteVersionText(k.path, k.head),
        ]);
        return current === head;
      } catch {
        return true; // on error, fall back to the simple "current" label
      }
    },
  );
  // Default to matching (show "current") while the check is in flight, to avoid
  // a flash of the "latest shared" wording on every open.
  const workingMatchesHead = () => headSync() !== false;

  /**
   * Open a read-only inline comparison of this version with the note's current
   * content, reusing this note's comparison tab if open.
   */
  function viewVersion(v: GitNoteVersion) {
    openVersionDiff(
      props.path,
      t("history.versionTab", { name: basename(), hash: v.shortHash }),
      { commit: v.commit, shortHash: v.shortHash, timestamp: v.timestamp },
    );
  }

  /** Open this version *beside* the current note — a right-split with the live
   *  note on the left and the version (diff) on the right. */
  function viewSideBySide(e: MouseEvent, v: GitNoteVersion) {
    e.stopPropagation();
    openVersionDiffSplit(
      props.path,
      t("history.versionTab", { name: basename(), hash: v.shortHash }),
      { commit: v.commit, shortHash: v.shortHash, timestamp: v.timestamp },
    );
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
      void refreshStatus(); // the restore made the working tree dirty
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
            {/* The list shows committed (shared) versions. When the working copy
                differs from the latest one (unsynced local edits or a reverted
                incoming change), say so — otherwise the top "latest shared" row
                reads as if it were the note you currently have. */}
            <Show when={!workingMatchesHead()}>
              <p class="note-history__local">{t("history.localUnsynced")}</p>
            </Show>
            <div class="note-history__list">
              <For each={versions()}>
                {(v, i) => (
                  <div
                    class="sidebar-item note-history__item"
                    onClick={() => void viewVersion(v)}
                    title={v.tookTheirsBaseline ? t("history.tookTheirs.view") : t("history.view")}
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
                          <span class="note-history__badge">
                            {workingMatchesHead() ? t("history.current") : t("history.latestShared")}
                          </span>
                        </Show>
                      </span>
                      {/* The user's pre-merge version when the last sync took
                          theirs — on its own line so it reads as a status, not a
                          chip on the message. Click the row to compare with the
                          current note and see what their edit was replaced with. */}
                      <Show when={v.tookTheirsBaseline}>
                        <span class="note-history__took-theirs">
                          {t("history.tookTheirs.badge")}
                        </span>
                      </Show>
                      <span class="note-history__secondary">
                        {[v.authorName, when(v.timestamp)].filter(Boolean).join(" · ")}
                        {" · "}
                        <span class="note-history__hash">{v.shortHash}</span>
                      </span>
                    </span>
                    <button
                      class="note-history__action"
                      title={t("history.sideBySide")}
                      aria-label={t("history.sideBySide")}
                      onClick={(e) => viewSideBySide(e, v)}
                    >
                      <Columns2 size={13} />
                    </button>
                    <button
                      class="note-history__action"
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
