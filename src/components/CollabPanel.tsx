import { Component, createSignal, createResource, createEffect, onMount, For, Show } from "solid-js";
import { save, open } from "@tauri-apps/plugin-dialog";
import * as ipc from "../lib/ipc";
import type { CollectionFile, ReviewResult, DecisionAction, ChangeKind } from "../lib/types";
import { MessageSquareCheck } from "lucide-solid";
import { showToast } from "../stores/toasts";
import {
  review,
  decisions,
  reasons,
  bibChoices,
  currentReviewCollabid,
  loadReview as loadReviewStore,
  clearReview,
  applyReview,
  setDecision,
  setReason,
  setBibChoice,
  setAllDecisions as setAll,
  reviewHasContent,
  setCurrentReviewCollabid,
} from "../stores/collab";
import { setRightCollapsed } from "../stores/layout";

/// The collaboration controls inside Collection Settings: identity, the
/// enable toggle, package/import buttons, and a review list that drives the
/// import → accept/reject → apply loop. The per-note diff lives in the
/// right-panel Review tab (ReviewPanel); this panel owns identity/enable/
/// package/import and the single Apply. Review session state is shared via
/// the `stores/collab` module so both surfaces edit one source of truth.
const CollabPanel: Component<{
  collectionPath: string;
  collectionName: string;
  collectionFile: CollectionFile;
  onSaved: () => void;
}> = (props) => {
  const [status, { refetch }] = createResource(
    () => props.collectionPath,
    (p) => ipc.collabStatus(p),
  );
  const [handle, setHandle] = createSignal("");
  const [handleTouched, setHandleTouched] = createSignal(false);
  const [importFolder, setImportFolder] = createSignal("");
  const [busy, setBusy] = createSignal(false);

  // Load a staged review into the shared session, scoped to this collection.
  const loadReview = (r: ReviewResult) =>
    loadReviewStore(props.collectionPath, props.collectionName, r);

  // Seed the handle field from the pinned identity once, without clobbering
  // an in-progress edit.
  createEffect(() => {
    const s = status();
    if (!handleTouched() && s?.handle) setHandle(s.handle);
  });

  // Seed the import-folder field from the collection file.
  createEffect(() => {
    setImportFolder(props.collectionFile.collaboration?.import_folder ?? "");
  });

  // The default landing folder when no override is set, shown as the input's
  // placeholder so the effective behaviour is always visible.
  const defaultImportFolder = () => `Collaboration/${props.collectionName}`;

  const enabled = () => status()?.enabled ?? false;

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
      refetch();
    } catch (e) {
      showToast("error", "Couldn't save identity", String(e));
    }
  }

  async function saveImportFolder() {
    try {
      await ipc.collabSetImportFolder(props.collectionPath, importFolder().trim());
      props.onSaved();
    } catch (e) {
      showToast("error", "Couldn't save import folder", String(e));
    }
  }

  async function doEnable() {
    const h = handle().trim();
    if (!h) {
      showToast("warning", "Enter your collaborator handle first.");
      return;
    }
    setBusy(true);
    try {
      const r = await ipc.collabEnable(props.collectionPath, h);
      showToast(
        "success",
        "Collaboration enabled",
        `${r.members} member notes, ${r.stamped} newly stamped.`,
      );
      props.onSaved();
      refetch();
    } catch (e) {
      showToast("error", "Enable failed", String(e));
    } finally {
      setBusy(false);
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
      // and clears the session. On success, also refresh this panel's own
      // status + the collection table rows (membership may have changed).
      const ok = await applyReview();
      if (ok) {
        props.onSaved();
        refetch();
      }
    } finally {
      setBusy(false);
    }
  }

  const kindLabel = (k: ChangeKind) =>
    ({ added: "Added", modified: "Modified", deleted: "Deleted", conflict: "Conflict" })[k];

  return (
    <div class="collab-panel">
      <Show
        when={enabled()}
        fallback={
          <div class="collection-meta__row">
            <span class="collection-meta__hint">
              Collaboration shares this collection as a portable package that
              collaborators exchange and review. The collection needs a
              membership filter before it can be enabled.
            </span>
          </div>
        }
      >
        <div class="collection-meta__row">
          <span class="collection-meta__hint">
            Tracked notes: {status()?.note_count ?? 0}
          </span>
        </div>

        <div class="collection-meta__row">
          <span class="collection-meta__hint">
            Membership is defined by each note's collection property, not its
            folder — so you and your collaborators can organize files however
            you like. Add or remove notes by setting their collection, not by
            editing this collection's filter (which is managed automatically
            while collaborative).
          </span>
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
          <span class="collection-meta__hint">
            Where notes new to this machine land on import. Local to you;
            collaborators each choose their own.
          </span>
        </div>
      </Show>

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
        <span class="collection-meta__hint">
          Identifies your edits in the version history. Stays on this machine.
        </span>
      </div>

      <div class="collection-meta__row collab-panel__actions">
        <Show
          when={enabled()}
          fallback={
            <button class="collection-table__toolbar-btn" disabled={busy()} onClick={doEnable}>
              Enable collaboration
            </button>
          }
        >
          <button class="collection-table__toolbar-btn" disabled={busy()} onClick={doPackage}>
            Package export…
          </button>
          <button class="collection-table__toolbar-btn" disabled={busy()} onClick={doImport}>
            Import package…
          </button>
        </Show>
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
                    <select
                      class="settings__text-input collab-panel__decision"
                      value={bibChoices()[key] ? "take_incoming" : "keep_local"}
                      onChange={(e) =>
                        setBibChoice(key, e.currentTarget.value === "take_incoming")
                      }
                    >
                      <option value="keep_local">Keep mine</option>
                      <option value="take_incoming">Take theirs</option>
                    </select>
                  </div>
                )}
              </For>
            </Show>

            <For each={r().note_items}>
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
                      <span class="collab-panel__path">{item.path}</span>
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
                      <select
                        class="settings__text-input collab-panel__decision"
                        value={decisions()[item.collabid] ?? "accept"}
                        onChange={(e) =>
                          setDecision(item.collabid, e.currentTarget.value as DecisionAction)
                        }
                      >
                        <option value="accept">Accept</option>
                        <option value="reject">Reject</option>
                        <option value="skip">Skip</option>
                      </select>
                    </div>
                  </div>
                  <Show when={(decisions()[item.collabid] ?? "accept") === "reject"}>
                    <input
                      type="text"
                      class="settings__text-input collab-panel__reject-reason"
                      value={reasons()[item.collabid] ?? ""}
                      onInput={(e) => setReason(item.collabid, e.currentTarget.value)}
                      placeholder="Why are you rejecting this? (recorded in the rejection log)"
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
              <button
                class="collection-table__toolbar-btn"
                disabled={busy()}
                onClick={() => clearReview()}
              >
                Cancel
              </button>
            </div>
          </div>
        )}
      </Show>
    </div>
  );
};

export default CollabPanel;
