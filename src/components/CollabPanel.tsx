import { Component, createSignal, createResource, createEffect, onMount, For, Show } from "solid-js";
import { save, open } from "@tauri-apps/plugin-dialog";
import * as ipc from "../lib/ipc";
import type { CollectionFile, ReviewResult, DecisionAction, ChangeKind } from "../lib/types";
import { showToast } from "../stores/toasts";
import { bumpPropertyVersion } from "../stores/notebox";

/// The collaboration controls inside Collection Settings: identity, the
/// enable toggle, package/import buttons, and an inline review list that
/// drives the import → accept/reject → apply loop. This is the minimal
/// surface that makes the package-handoff backend drivable end to end; a
/// richer right-panel review experience can layer on later.
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
  const [review, setReview] = createSignal<ReviewResult | null>(null);
  const [decisions, setDecisions] = createSignal<Record<string, DecisionAction>>({});
  const [busy, setBusy] = createSignal(false);

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
      if (r && (r.note_items.length > 0 || r.bib_conflicts.length > 0)) {
        loadReview(r);
      }
    } catch {
      // No staged import / not collaborative — nothing to resume.
    }
  });

  function loadReview(r: ReviewResult) {
    setReview(r);
    const d: Record<string, DecisionAction> = {};
    for (const it of r.note_items) d[it.collabid] = "accept";
    setDecisions(d);
  }

  function setDecision(collabid: string, action: DecisionAction) {
    setDecisions((d) => ({ ...d, [collabid]: action }));
  }

  /// Set every reviewable item to one action (sets the target state, not a
  /// toggle).
  function setAll(action: DecisionAction) {
    const r = review();
    if (!r) return;
    const d: Record<string, DecisionAction> = {};
    for (const it of r.note_items) d[it.collabid] = action;
    setDecisions(d);
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
      if (r.note_items.length === 0 && r.bib_conflicts.length === 0) {
        showToast("info", "Nothing to review", "No incoming changes.");
      }
    } catch (e) {
      showToast("error", "Import failed", String(e));
    } finally {
      setBusy(false);
    }
  }

  async function applyDecisions() {
    const r = review();
    if (!r) return;
    const list = r.note_items.map((it) => ({
      collabid: it.collabid,
      action: decisions()[it.collabid] ?? "skip",
    }));
    setBusy(true);
    try {
      const rep = await ipc.collabReviewApply(props.collectionPath, list);
      showToast(
        "success",
        "Changes applied",
        `${rep.applied} written, ${rep.deleted} deleted, ${rep.rejected} rejected, ${rep.skipped} skipped.`,
      );
      setReview(null);
      // Refetch this collection's own status, the collection table rows,
      // and any other open collection views (membership may have changed).
      props.onSaved();
      bumpPropertyVersion();
      refetch();
    } catch (e) {
      showToast("error", "Apply failed", String(e));
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
            Package…
          </button>
          <button class="collection-table__toolbar-btn" disabled={busy()} onClick={doImport}>
            Import package…
          </button>
        </Show>
      </div>

      <Show when={review()}>
        {(r) => (
          <div class="collab-panel__review">
            <div class="collection-meta__section-label">
              Incoming changes — {r().note_items.length} to review
            </div>

            <Show when={r().note_items.length > 1}>
              <div class="collab-panel__bulk">
                <span class="collection-meta__hint">Set all:</span>
                <button class="collection-table__toolbar-btn" onClick={() => setAll("accept")}>
                  Accept all
                </button>
                <button class="collection-table__toolbar-btn" onClick={() => setAll("reject")}>
                  Reject all
                </button>
                <button class="collection-table__toolbar-btn" onClick={() => setAll("skip")}>
                  Skip all
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
              <div class="collection-meta__hint">
                Bibliography conflicts (kept local for now): {r().bib_conflicts.join(", ")}
              </div>
            </Show>

            <For each={r().note_items}>
              {(item) => (
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
              )}
            </For>

            <div class="collection-meta__row collab-panel__actions">
              <button
                class="collection-table__toolbar-btn"
                disabled={busy() || r().note_items.length === 0}
                onClick={applyDecisions}
              >
                Apply decisions
              </button>
              <button
                class="collection-table__toolbar-btn"
                disabled={busy()}
                onClick={() => setReview(null)}
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
