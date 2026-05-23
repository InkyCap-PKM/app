import { Component, createSignal, createEffect, onMount, For, Show } from "solid-js";
import { save, open } from "@tauri-apps/plugin-dialog";
import * as ipc from "../lib/ipc";
import type {
  CollectionFile,
  CollabStatus,
  ReviewResult,
  DecisionAction,
  ChangeKind,
} from "../lib/types";
import { MessageSquareCheck } from "lucide-solid";
import { showToast } from "../stores/toasts";
import {
  review,
  decisions,
  comments,
  bibChoices,
  currentReviewCollabid,
  loadReview as loadReviewStore,
  applyReview,
  setDecision,
  setComment,
  setBibChoice,
  setAllDecisions as setAll,
  reviewHasContent,
  setCurrentReviewCollabid,
} from "../stores/collab";
import { setRightCollapsed } from "../stores/layout";
import HelpButton from "./HelpButton";
import { Dropdown } from "./Dropdown";

/// The body of the Collaboration section shown while a collection is actively
/// collaborative (`state === "enabled"`). The Disable / Pause / Enable pill
/// and the enable flow live in the parent `CollaborationSection`; this panel
/// owns the post-enable controls — identity override, import folder,
/// package/import, and the import → accept/reject → apply loop. The per-note
/// diff lives in the right-panel Review tab (ReviewPanel); review session
/// state is shared via `stores/collab` so both surfaces edit one source of
/// truth.
const CollabPanel: Component<{
  collectionPath: string;
  collectionName: string;
  /// Current (enabled) status, owned by the parent so the pill and this body
  /// read one resource.
  status: CollabStatus;
  collectionFile: CollectionFile;
  /// Refetch the parent's status + collection-file resources after a change
  /// originating here (identity override, import folder, apply).
  onChanged: () => void;
}> = (props) => {
  const [handle, setHandle] = createSignal("");
  const [handleTouched, setHandleTouched] = createSignal(false);
  const [importFolder, setImportFolder] = createSignal("");
  const [busy, setBusy] = createSignal(false);

  // Incoming-changes list: a typing filter + an A–Z / Z–A sort so a specific
  // note is quick to find in a large review.
  const [reviewFilter, setReviewFilter] = createSignal("");
  const [reviewSort, setReviewSort] = createSignal<"az" | "za">("az");
  // Display name: the basename without `.typ` (the full path is shown on hover).
  const fileName = (p: string) => (p.split(/[\\/]/).pop() ?? p).replace(/\.typ$/i, "");
  // The note items to render: filtered by name (matches filename or path) and
  // sorted by filename in the chosen direction. Reads the filter/sort signals,
  // so the <For> re-runs when either changes.
  const visibleItems = (items: ReviewResult["note_items"]) => {
    const q = reviewFilter().trim().toLowerCase();
    const out = q
      ? items.filter(
          (it) =>
            fileName(it.path).toLowerCase().includes(q) || it.path.toLowerCase().includes(q),
        )
      : items.slice();
    out.sort((a, b) => {
      const cmp = fileName(a.path).localeCompare(fileName(b.path), undefined, { sensitivity: "base" });
      return reviewSort() === "az" ? cmp : -cmp;
    });
    return out;
  };

  // Load a staged review into the shared session, scoped to this collection.
  const loadReview = (r: ReviewResult) =>
    loadReviewStore(props.collectionPath, props.collectionName, r);

  // Seed the handle field from the pinned identity once, without clobbering
  // an in-progress edit.
  createEffect(() => {
    if (!handleTouched() && props.status.handle) setHandle(props.status.handle);
  });

  // Seed the import-folder field from the collection file.
  createEffect(() => {
    setImportFolder(props.collectionFile.collaboration?.import_folder ?? "");
  });

  // The default landing folder when no override is set, shown as the input's
  // placeholder so the effective behaviour is always visible.
  const defaultImportFolder = () => `Collaboration/${props.collectionName}`;

  // Resume a staged-but-unapplied import when the collection is (re)opened
  // — also how the global "Import package" flow surfaces its review here.
  onMount(async () => {
    try {
      const r = await ipc.collabPendingReview(props.collectionPath);
      if (r && reviewHasContent(r)) {
        loadReview(r);
      }
    } catch {
      // No staged import / not collaborative — nothing to resume.
    }
  });

  const hasReviewContent = () => {
    const r = review();
    return !!r && reviewHasContent(r);
  };

  /// Open the right-panel Review diff for one note: point the session at it
  /// and reveal the (collapsed) panel. RightPanel's effect focuses the Review
  /// tab when the session pointer is set; ReviewPanel fetches the diff and
  /// opens the local note in a tab (when it exists) for context.
  function openReview(collabid: string) {
    setCurrentReviewCollabid(collabid);
    setRightCollapsed(false);
  }

  async function saveIdentity() {
    const h = handle().trim();
    if (!h) return;
    try {
      await ipc.collabSetIdentity(props.collectionPath, h);
      props.onChanged();
    } catch (e) {
      showToast("error", "Couldn't save identity", String(e));
    }
  }

  async function saveImportFolder() {
    try {
      await ipc.collabSetImportFolder(props.collectionPath, importFolder().trim());
      props.onChanged();
    } catch (e) {
      showToast("error", "Couldn't save import folder", String(e));
    }
  }

  async function doPackage() {
    const out = await save({
      title: "Save collaboration package",
      defaultPath: `${props.collectionName}.zip`,
      filters: [{ name: "InkyCap package", extensions: ["zip"] }],
    });
    if (!out) return;
    setBusy(true);
    try {
      const r = await ipc.collabPackage(props.collectionPath, out);
      showToast("success", "Package written", `${r.note_count} notes`);
    } catch (e) {
      showToast("error", "Package failed", String(e));
    } finally {
      setBusy(false);
    }
  }

  async function doImport() {
    const pkg = await open({
      title: "Import collaboration package",
      filters: [{ name: "InkyCap package", extensions: ["zip"] }],
    });
    if (!pkg || Array.isArray(pkg)) return;
    setBusy(true);
    try {
      const r = await ipc.collabImport(props.collectionPath, pkg);
      loadReview(r);
      if (!reviewHasContent(r)) {
        showToast("info", "Nothing to review", "No incoming changes.");
      }
    } catch (e) {
      showToast("error", "Import failed", String(e));
    } finally {
      setBusy(false);
    }
  }

  async function applyDecisions() {
    setBusy(true);
    try {
      // Shared store action does the apply + toast + collection-view refresh
      // and clears the session. On success, also refresh the parent's status +
      // collection file (membership may have changed).
      const ok = await applyReview();
      if (ok) props.onChanged();
    } finally {
      setBusy(false);
    }
  }

  const kindLabel = (k: ChangeKind) =>
    ({ added: "Added", modified: "Modified", deleted: "Deleted", conflict: "Conflict" })[k];

  return (
    <div class="collab-panel">
      <div class="collection-meta__row">
        <span class="collection-meta__hint">
          Tracked notes: {props.status.note_count}
        </span>
        <HelpButton label="How collaboration packaging works">
          Package this collection to share with collaborators and see each
          other's changes. Although collections can filter the files they
          include from across your notebox, when using collaboration packages
          each file will have its collection property set for the collection.
          Only files explicitly assigned to the collection through the property
          will be packaged for collaboration. Each collaborator can organize
          files wherever they like on their local system; folders do not get
          packaged.
        </HelpButton>
      </div>

      <div class="collection-meta__row">
        <label class="collection-meta__label">Import folder</label>
        <input
          type="text"
          class="settings__text-input"
          value={importFolder()}
          onInput={(e) => setImportFolder(e.currentTarget.value)}
          onBlur={saveImportFolder}
          placeholder={defaultImportFolder()}
        />
        <HelpButton label="About the import folder">
          Where notes new to this machine are stored on import. Existing notes
          remain where you have stored them. This does not affect collaborators.
        </HelpButton>
      </div>

      <div class="collection-meta__row">
        <label class="collection-meta__label">Your handle</label>
        <input
          type="text"
          class="settings__text-input"
          value={handle()}
          onInput={(e) => {
            setHandleTouched(true);
            setHandle(e.currentTarget.value);
          }}
          onBlur={saveIdentity}
          placeholder="e.g. joshua-chalifour"
        />
        <HelpButton label="About your handle">
          Identifies your edits in the version history. Stays on this machine.
        </HelpButton>
      </div>

      <div class="collection-meta__row collab-panel__actions">
        <button class="collection-table__toolbar-btn" disabled={busy()} onClick={doPackage}>
          Export package…
        </button>
        <button class="collection-table__toolbar-btn" disabled={busy()} onClick={doImport}>
          Import package…
        </button>
      </div>

      <Show when={review()}>
        {(r) => (
          <div class="collab-panel__review">
            <Show when={r().note_items.length > 0}>
              <div class="collection-meta__section-label">
                Incoming changes — {r().note_items.length} to review
              </div>
            </Show>

            <Show when={r().note_items.length > 1}>
              <div class="collab-panel__review-tools">
                <input
                  type="text"
                  class="settings__text-input collab-panel__review-filter"
                  value={reviewFilter()}
                  onInput={(e) => setReviewFilter(e.currentTarget.value)}
                  placeholder="Filter by name…"
                />
                <button
                  class="collection-table__toolbar-btn"
                  title={reviewSort() === "az" ? "Sorted A→Z (click for Z→A)" : "Sorted Z→A (click for A→Z)"}
                  onClick={() => setReviewSort((s) => (s === "az" ? "za" : "az"))}
                >
                  {reviewSort() === "az" ? "A–Z" : "Z–A"}
                </button>
              </div>
            </Show>

            <Show when={r().note_items.length > 1}>
              <div class="collab-panel__bulk">
                <span class="collection-meta__hint">Set all:</span>
                <button class="collection-table__toolbar-btn" onClick={() => setAll("accept")}>
                  Accept
                </button>
                <button class="collection-table__toolbar-btn" onClick={() => setAll("reject")}>
                  Reject
                </button>
                <button class="collection-table__toolbar-btn" onClick={() => setAll("skip")}>
                  Skip
                </button>
              </div>
            </Show>

            <Show when={r().note_auto_merges.length > 0}>
              <div class="collection-meta__hint">
                {r().note_auto_merges.length} note(s) auto-merged (identical edits).
              </div>
            </Show>
            <Show when={r().bib_auto_merges.length > 0}>
              <div class="collection-meta__hint">
                {r().bib_auto_merges.length} bibliography entr(y/ies) merged automatically.
              </div>
            </Show>
            <Show when={r().bib_conflicts.length > 0}>
              <div class="collection-meta__section-label">
                Bibliography conflicts — {r().bib_conflicts.length}
              </div>
              <For each={r().bib_conflicts}>
                {(key) => (
                  <div class="collab-panel__review-row">
                    <div class="collab-panel__review-info">
                      <span class="collab-panel__kind" data-kind="conflict">
                        Conflict
                      </span>
                      <span class="collab-panel__path">@{key}</span>
                    </div>
                    <Dropdown<string>
                      class="collab-panel__decision"
                      value={bibChoices()[key] ? "take_incoming" : "keep_local"}
                      options={[
                        { value: "keep_local", label: "Keep mine" },
                        { value: "take_incoming", label: "Take theirs" },
                      ]}
                      onChange={(v) => setBibChoice(key, v === "take_incoming")}
                      ariaLabel="Bibliography conflict resolution"
                    />
                  </div>
                )}
              </For>
            </Show>

            <For each={visibleItems(r().note_items)}>
              {(item) => (
                <div
                  class="collab-panel__review-item"
                  classList={{
                    "collab-panel__review-item--active":
                      currentReviewCollabid() === item.collabid,
                  }}
                >
                  <div class="collab-panel__review-row">
                    <div class="collab-panel__review-info">
                      <span class="collab-panel__kind" data-kind={item.kind}>
                        {kindLabel(item.kind)}
                      </span>
                      <span class="collab-panel__path" title={item.path}>{fileName(item.path)}</span>
                      <Show when={item.changed_by.length > 0}>
                        <span class="collection-meta__hint">by {item.changed_by.join(", ")}</span>
                      </Show>
                    </div>
                    <div class="collab-panel__review-controls">
                      <button
                        class="collection-table__toolbar-btn collab-panel__review-btn"
                        title="View changes in the Review panel"
                        onClick={() => openReview(item.collabid)}
                      >
                        <MessageSquareCheck size={14} />
                        Review
                      </button>
                      <Dropdown<DecisionAction>
                        class="collab-panel__decision"
                        value={decisions()[item.collabid] ?? "accept"}
                        options={[
                          { value: "accept", label: "Accept" },
                          { value: "reject", label: "Reject" },
                          { value: "skip", label: "Skip" },
                        ]}
                        onChange={(v) => setDecision(item.collabid, v)}
                        ariaLabel="Decision"
                      />
                    </div>
                  </div>
                  <Show when={(decisions()[item.collabid] ?? "accept") !== "skip"}>
                    <input
                      type="text"
                      class="settings__text-input collab-panel__reject-reason"
                      value={comments()[item.collabid] ?? ""}
                      onInput={(e) => setComment(item.collabid, e.currentTarget.value)}
                      placeholder={
                        (decisions()[item.collabid] ?? "accept") === "reject"
                          ? "Why are you rejecting this? (recorded in the review log)"
                          : "Comment (optional — recorded in the review log)"
                      }
                    />
                  </Show>
                </div>
              )}
            </For>

            <div class="collection-meta__row collab-panel__actions">
              <button
                class="collection-table__toolbar-btn"
                disabled={busy() || !hasReviewContent()}
                onClick={applyDecisions}
              >
                Apply decisions
              </button>
            </div>
          </div>
        )}
      </Show>
    </div>
  );
};

export default CollabPanel;
