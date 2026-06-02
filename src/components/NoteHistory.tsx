// The "History" half of the right-panel "Changes & History" pane: the version
// history of the open note, read from the git commit graph. Each row is a past
// version (who / when / message); clicking opens that version as a read-only
// scratch tab, and Restore writes it back as a new edit to Sync (never rewrites
// history). Shown only for a collaborative notebox — version history is the git
// commit graph, so a non-collaborative notebox has none.

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
  // Re-fetch whenever the note changes, collaboration toggles, or the working
  // tree moves (a sync/pull/revert bumps `syncReviewVersion`). Including the
  // review version in the source means the list — and the HEAD reference the
  // "current"/"latest shared" badge derives from — refreshes after a sync, so a
  // just-synced note correctly reads "current" instead of "latest shared".
  const key = createMemo(() =>
    collaborative() ? { path: props.path, rev: syncReviewVersion() } : null,
  );
  const [versions, { refetch }] = createResource(key, async (k) => {
    return k ? ipc.gitNoteHistory(k.path) : ([] as GitNoteVersion[]);
  });

  const basename = () => props.path.split("/").pop() ?? props.path;

  // Whether the note's working copy matches the latest committed version (HEAD,
  // the top row). In the merge-first model a note can sit *ahead of* its shared
  // history — local edits, or a reverted incoming change, aren't committed until
  // the next Sync — so the top commit isn't necessarily "what you have". This
  // tells the badge whether to read "current" (working copy == HEAD) or "latest
  // shared" (your local note differs). Re-checked when the working tree changes
  // (`syncReviewVersion` bumps on saves / reverts) since a revert doesn't add a
  // commit but does change the working copy. */
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

  /** Open a read-only inline diff comparing this past version with the note's
   *  current content. Reuses an already-open compare tab for this note (clicking
   *  another version updates it in place) rather than stacking tabs. */
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
