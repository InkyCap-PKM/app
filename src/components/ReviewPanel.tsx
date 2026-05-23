import { Component, createResource, createEffect, createMemo, createSignal, onCleanup, Show } from "solid-js";
import { EditorState } from "@codemirror/state";
import { EditorView } from "@codemirror/view";
import { unifiedMergeView } from "@codemirror/merge";
import { readOnlyTypstExtensions } from "../editor/typst-editor";
import * as ipc from "../lib/ipc";
import type { ChangeKind } from "../lib/types";
import {
  activeReview,
  reviewItem,
  comments,
  currentReviewCollabid,
  setCurrentReviewPath,
  setComment,
  enterReviewMode,
  endReviewModeFor,
  isMerged,
  applyNote,
  commentOnly,
} from "../stores/collab";
import { openTab, closeTab, tabs } from "../stores/tabs";
import { pathEquals } from "../lib/paths";

/// Right-panel Review tab: a read-only `@codemirror/merge` unified diff
/// (incoming vs the receiver's local copy) for the note currently under
/// review, with whole-file Accept / Reject applied immediately. After a
/// decision the note stays in review display ("Merged") so the user can keep
/// the diff open and continue editing; "End Review Mode" closes the note tab
/// and returns to the collection.
///
/// Mounted only while a review session is active (gated on
/// `currentReviewCollabid` in RightPanel), so it never shows for ordinary
/// notes.

const KIND_LABEL: Record<ChangeKind, string> = {
  added: "Added",
  modified: "Modified",
  deleted: "Deleted",
  conflict: "Conflict",
};

function titleFromPath(p: string): string {
  const base = p.split(/[\\/]/).pop() ?? p;
  return base.replace(/\.typ$/i, "");
}

const ReviewPanel: Component = () => {
  const [busy, setBusy] = createSignal(false);

  // The review item (kind, path, proposer) for the current note — from the
  // full set, so it survives the note leaving the pending list on apply.
  const item = createMemo(() => {
    const id = currentReviewCollabid();
    return id ? reviewItem(id) : null;
  });

  // Stable primitive key so the diff fetches once per note (and stays frozen
  // after a decision is applied — the diff keeps showing the proposed change).
  const reviewKey = createMemo(() => {
    const ar = activeReview();
    const id = currentReviewCollabid();
    return ar && id ? `${ar.collectionPath} ${id}` : null;
  });

  const [detail] = createResource(reviewKey, async (key) => {
    const sep = key.indexOf(" ");
    return ipc.collabReviewDetail(key.slice(0, sep), key.slice(sep + 1));
  });

  // Record the note's local path (for the header badge + review-mode set) and
  // open it in a tab for context. `forceNewTab` preserves the collection view;
  // openTab focuses an existing tab for the same path. Added notes have no
  // local file — the diff still shows their full incoming content.
  createEffect(() => {
    const d = detail();
    const id = currentReviewCollabid();
    setCurrentReviewPath(d?.local_path ?? null);
    if (d?.local_path && id) {
      enterReviewMode(d.local_path, id);
      openTab(
        { type: "file", title: titleFromPath(d.local_path), path: d.local_path },
        { forceNewTab: true },
      );
    }
  });

  // Build / rebuild the read-only unified merge view when content changes.
  // `original` = the local copy (mine); the editor doc = the incoming copy
  // (theirs), so insertions are theirs-added and deletions are theirs-removed.
  let host: HTMLDivElement | undefined;
  let view: EditorView | undefined;
  createEffect(() => {
    const d = detail();
    view?.destroy();
    view = undefined;
    if (!host || !d) return;
    view = new EditorView({
      parent: host,
      state: EditorState.create({
        doc: d.incoming_content ?? "",
        extensions: [
          ...readOnlyTypstExtensions(),
          unifiedMergeView({ original: d.local_content ?? "", mergeControls: false }),
        ],
      }),
    });
  });
  onCleanup(() => view?.destroy());

  async function decide(action: "accept" | "reject") {
    const it = item();
    if (!it) return;
    setBusy(true);
    try {
      const ok = await applyNote(it.collabid, action);
      // Accept overwrote the note with the incoming version — tell its open
      // editor to reload so the main content shows the merged result. (Reject
      // keeps local content, so nothing to reload.) Reuses the same event the
      // sidebar property editor uses for external-write reloads.
      if (ok && action === "accept") {
        const path = detail()?.local_path;
        if (path) {
          document.dispatchEvent(
            new CustomEvent("inkycap:note-property-changed", { detail: { path } }),
          );
        }
      }
    } finally {
      setBusy(false);
    }
  }

  // Record a comment without making a decision (the note stays pending).
  // Clears the field on success so a follow-up comment starts fresh.
  async function addComment(collabid: string, target: string) {
    const text = comments()[collabid] ?? "";
    setBusy(true);
    try {
      if (await commentOnly(target, text)) setComment(collabid, "");
    } finally {
      setBusy(false);
    }
  }

  // Leave review-mode display for this note, close its tab, and return to the
  // collection the review belongs to.
  function endReview() {
    const id = currentReviewCollabid();
    const path = currentReviewPathValue();
    endReviewModeFor(path, id);
    if (path) {
      const tab = tabs.find((t) => t.type === "file" && pathEquals(t.path, path));
      if (tab) closeTab(tab.id);
    }
    const ar = activeReview();
    if (ar) openTab({ type: "collection", title: ar.collectionName, path: ar.collectionPath });
  }
  // Read the path off the open tab/detail without tracking (used in a handler).
  const currentReviewPathValue = () => detail()?.local_path ?? null;

  return (
    <div class="review-panel">
      <Show
        when={item()}
        fallback={
          <div class="review-panel__empty collection-meta__hint">
            No note selected for review.
          </div>
        }
      >
        {(it) => (
          <>
            <div class="review-panel__header">
              <span class="collab-panel__kind" data-kind={it().kind}>
                {KIND_LABEL[it().kind]}
              </span>
              <span class="review-panel__title">{titleFromPath(it().path)}</span>
            </div>

            <Show when={it().changed_by.length > 0}>
              <div class="collection-meta__hint review-panel__by">
                Changes proposed by {it().changed_by.join(", ")}
              </div>
            </Show>

            <div class="review-panel__diff">
              <Show when={it().kind === "added"}>
                <div class="collection-meta__hint review-panel__diff-note">
                  New note — no local version yet; showing the full incoming content.
                </div>
              </Show>
              <Show when={it().kind === "deleted"}>
                <div class="collection-meta__hint review-panel__diff-note">
                  Deletion — the content below would be removed.
                </div>
              </Show>
              <Show when={detail.loading}>
                <div class="collection-meta__hint review-panel__diff-note">Loading changes…</div>
              </Show>
              {/* Host is always present so the merge-view build effect has a
                  mount point as soon as the detail resolves. */}
              <div class="review-panel__merge" ref={(el) => (host = el)} />
            </div>

            <div class="review-panel__decision">
              <Show
                when={!isMerged(it().collabid)}
                fallback={
                  <div class="review-panel__merged collection-meta__hint">
                    Merged — keep editing this note as you like, then click End
                    Review Mode when you're done.
                  </div>
                }
              >
                <div class="review-panel__actions" role="group" aria-label="Decision">
                  <button
                    class="collection-table__toolbar-btn review-panel__accept-btn"
                    disabled={busy()}
                    onClick={() => decide("accept")}
                  >
                    Accept
                  </button>
                  <button
                    class="collection-table__toolbar-btn review-panel__reject-btn"
                    disabled={busy()}
                    onClick={() => decide("reject")}
                  >
                    Reject
                  </button>
                </div>
                <textarea
                  class="settings__text-input review-panel__reason"
                  rows={2}
                  value={comments()[it().collabid] ?? ""}
                  onInput={(e) => setComment(it().collabid, e.currentTarget.value)}
                  placeholder="Comment (optional — recorded in the review log; sent with your decision, or on its own)"
                />
                {/* Leave a comment without deciding — keeps the note pending. */}
                <button
                  class="collection-table__toolbar-btn review-panel__comment-btn"
                  disabled={busy() || !(comments()[it().collabid] ?? "").trim()}
                  onClick={() => addComment(it().collabid, titleFromPath(it().path))}
                >
                  Add Comment
                </button>
              </Show>

              <button class="collection-table__toolbar-btn review-panel__end-btn" onClick={endReview}>
                End Review Mode
              </button>
            </div>
          </>
        )}
      </Show>
    </div>
  );
};

export default ReviewPanel;
