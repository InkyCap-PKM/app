// Collaboration review session — shared state between the Collaboration
// settings panel (CollabPanel) and the right-panel Review tab (ReviewPanel).
//
// A "review session" is one staged import for one collection. Reviewing is
// whole-file: for each note the user accepts (take the incoming version) or
// rejects (keep theirs) — applied immediately, one note at a time. The
// Collaboration settings panel keeps a deferred batch path too (per-row
// decisions + "Apply decisions").
//
// "Review mode" is a per-note display state: a note the user opened for
// review shows the diff in the right panel and a "Reviewing"/"Merged" badge
// in its editor header. It persists (reopening the note re-enters it) until
// the user clicks "End Review Mode" — closing the tab with ✕ does not end it.
// `reviewModeByPath` (note's local path → collabid) tracks which notes are in
// review mode; `currentReviewCollabid` is the one shown in the right panel.

import { createSignal } from "solid-js";
import type { ReviewResult, ReviewItem, DecisionAction, ReviewDecision, BibDecision } from "../lib/types";
import * as ipc from "../lib/ipc";
import { showToast } from "./toasts";
import { bumpPropertyVersion } from "./notebox";
import { normalizePath } from "../lib/paths";

/** Which collection's import is under review. Needed by the right-panel diff
 *  (it has no props) to call `collabReviewDetail` and by Apply. */
export interface ActiveReview {
  collectionPath: string;
  collectionName: string;
}

const [activeReview, setActiveReview] = createSignal<ActiveReview | null>(null);
const [review, setReview] = createSignal<ReviewResult | null>(null);
// Every note item from the import, keyed by collabid — kept even after a note
// is applied and removed from `review.note_items`, so the Review panel can
// still show the (now-merged) note's header/diff.
const [reviewItemsById, setReviewItemsById] = createSignal<Record<string, ReviewItem>>({});
const [decisions, setDecisions] = createSignal<Record<string, DecisionAction>>({});
const [reasons, setReasons] = createSignal<Record<string, string>>({});
// Per-key bibliography conflict choices: true ⇒ take incoming, false ⇒ keep
// local (the default).
const [bibChoices, setBibChoices] = createSignal<Record<string, boolean>>({});
const [currentReviewCollabid, setCurrentReviewCollabid] = createSignal<string | null>(null);
// Absolute path of the note currently in the diff (its local copy), or null
// for an Added note / no session. Drives the "Reviewing" badge in that note's
// editor header.
const [currentReviewPath, setCurrentReviewPath] = createSignal<string | null>(null);
// Notes in review-mode display: normalized local path → collabid. A note
// stays here (so reopening shows review mode) until End Review Mode.
const [reviewModeByPath, setReviewModeByPath] = createSignal<Record<string, string>>({});
// Collabids whose decision has been applied (Merged) this session — used for
// the "Merged" header badge while the note stays in review display.
const [mergedCollabids, setMergedCollabids] = createSignal<Record<string, true>>({});

export {
  activeReview,
  review,
  reviewItemsById,
  decisions,
  reasons,
  bibChoices,
  currentReviewCollabid,
  setCurrentReviewCollabid,
  currentReviewPath,
  setCurrentReviewPath,
  reviewModeByPath,
};

/** The review item for a collabid (from the full set, surviving apply). */
export function reviewItem(collabid: string): ReviewItem | null {
  return reviewItemsById()[collabid] ?? null;
}

/** Whether a review has anything for the batch Apply to act on. */
export function reviewHasContent(r: ReviewResult): boolean {
  return (
    r.note_items.length > 0 ||
    r.bib_conflicts.length > 0 ||
    r.bib_auto_merges.length > 0
  );
}

/** Load a staged review into the session, defaulting every note to accept and
 *  every bib conflict to keep-local. Replaces any prior session. */
export function loadReview(collectionPath: string, collectionName: string, r: ReviewResult) {
  setActiveReview({ collectionPath, collectionName });
  setReview(r);
  const byId: Record<string, ReviewItem> = {};
  for (const it of r.note_items) byId[it.collabid] = it;
  setReviewItemsById(byId);
  const d: Record<string, DecisionAction> = {};
  for (const it of r.note_items) d[it.collabid] = "accept";
  setDecisions(d);
  const bc: Record<string, boolean> = {};
  for (const key of r.bib_conflicts) bc[key] = false; // keep local by default
  setBibChoices(bc);
  setReasons({});
  setMergedCollabids({});
  // Note: review-mode set + currentReviewCollabid are left as-is here so a
  // re-classify (collab_pending_review) doesn't kick the user out of a note
  // they're actively reviewing.
}

/** End the whole session (e.g. on Cancel from settings). Clears everything,
 *  including review-mode display. */
export function clearReview() {
  setActiveReview(null);
  setReview(null);
  setReviewItemsById({});
  setDecisions({});
  setReasons({});
  setBibChoices({});
  setCurrentReviewCollabid(null);
  setCurrentReviewPath(null);
  setReviewModeByPath({});
  setMergedCollabids({});
}

export function setDecision(collabid: string, action: DecisionAction) {
  setDecisions((d) => ({ ...d, [collabid]: action }));
}

export function setReason(collabid: string, reason: string) {
  setReasons((m) => ({ ...m, [collabid]: reason }));
}

export function setBibChoice(key: string, takeIncoming: boolean) {
  setBibChoices((c) => ({ ...c, [key]: takeIncoming }));
}

/** Set every note item to one action (target state, not a toggle). */
export function setAllDecisions(action: DecisionAction) {
  const r = review();
  if (!r) return;
  const d: Record<string, DecisionAction> = {};
  for (const it of r.note_items) d[it.collabid] = action;
  setDecisions(d);
}

// ── Review-mode display (per note) ──────────────────────────────────────

/** Mark a note's local path as in review-mode display. */
export function enterReviewMode(localPath: string, collabid: string) {
  setReviewModeByPath((m) => ({ ...m, [normalizePath(localPath)]: collabid }));
}

/** The collabid in review mode for a note path, if any. */
export function reviewModeCollabidForPath(path: string | null | undefined): string | null {
  if (!path) return null;
  return reviewModeByPath()[normalizePath(path)] ?? null;
}

/** Whether a note's decision has been applied this session. */
export function isMerged(collabid: string | null): boolean {
  return !!collabid && !!mergedCollabids()[collabid];
}

/** End review-mode display for one note (its local path), and clear the panel
 *  pointer if it was the one showing. Does NOT touch the working files. */
export function endReviewModeFor(localPath: string | null, collabid: string | null) {
  if (localPath) {
    const key = normalizePath(localPath);
    setReviewModeByPath((m) => {
      const next = { ...m };
      delete next[key];
      return next;
    });
  }
  if (collabid && currentReviewCollabid() === collabid) {
    setCurrentReviewCollabid(null);
    setCurrentReviewPath(null);
  }
}

// ── Apply ───────────────────────────────────────────────────────────────

/** Apply ONE note's decision immediately (whole-file): accept takes the
 *  incoming version, reject keeps the local one (resolved so it won't
 *  re-offer; rationale logged). Removes it from the pending list but KEEPS it
 *  in review-mode display (marked Merged) so the user can keep the diff open
 *  and continue editing. Returns true on success. */
export async function applyNote(collabid: string, action: "accept" | "reject"): Promise<boolean> {
  const ar = activeReview();
  if (!ar) return false;
  const d: ReviewDecision = { collabid, action };
  if (action === "reject") {
    const reason = (reasons()[collabid] ?? "").trim();
    if (reason) d.reason = reason;
  }
  try {
    await ipc.collabReviewApply(ar.collectionPath, [d], []);
    bumpPropertyVersion();
    setMergedCollabids((m) => ({ ...m, [collabid]: true }));
    setDecisions((cur) => ({ ...cur, [collabid]: action }));
    // Drop from the pending list so the Collaboration panel no longer offers
    // it; the full item survives in `reviewItemsById` for the open diff.
    setReview((cur) =>
      cur ? { ...cur, note_items: cur.note_items.filter((it) => it.collabid !== collabid) } : cur,
    );
    return true;
  } catch (e) {
    showToast("error", "Couldn't apply", String(e));
    return false;
  }
}

/** Apply every pending decision in the session at once (the batch path used
 *  by the Collaboration settings panel), then end the session. Returns true
 *  on success. Surfaces its own toast; callers manage busy state / refreshes. */
export async function applyReview(): Promise<boolean> {
  const ar = activeReview();
  const r = review();
  if (!ar || !r) return false;

  const list: ReviewDecision[] = r.note_items.map((it) => {
    const action = decisions()[it.collabid] ?? "skip";
    const d: ReviewDecision = { collabid: it.collabid, action };
    if (action === "reject") {
      const reason = (reasons()[it.collabid] ?? "").trim();
      if (reason) d.reason = reason;
    }
    return d;
  });
  const bibList: BibDecision[] = r.bib_conflicts.map((key) => ({
    key,
    take_incoming: bibChoices()[key] ?? false,
  }));

  try {
    const rep = await ipc.collabReviewApply(ar.collectionPath, list, bibList);
    const bib =
      rep.bib_added > 0
        ? `, ${rep.bib_added} bib entr${rep.bib_added === 1 ? "y" : "ies"} merged`
        : "";
    showToast(
      "success",
      "Changes applied",
      `${rep.applied} written, ${rep.deleted} deleted, ${rep.rejected} rejected, ${rep.skipped} skipped${bib}.`,
    );
    bumpPropertyVersion();
    clearReview();
    return true;
  } catch (e) {
    showToast("error", "Apply failed", String(e));
    return false;
  }
}
