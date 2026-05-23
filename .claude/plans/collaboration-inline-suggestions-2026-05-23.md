---
title: "Collaboration — Review Commentary + Inline Suggestions (idea capture)"
created: "2026-05-23"
status: "idea / not started — captured for a future session"
companion: ".claude/plans/collaboration-status-2026-05-21.md (the shipped package-handoff work)"
---
# Collaboration: Review Commentary + Inline `#suggestion` Pills

Two related ideas the user raised after committing the right-panel /
tri-state collaboration work. **Nothing built yet** — this is a resume doc.
They sit *on top of* whatever transport is chosen (package today; git/CRDT
debate is still open — see the companion status doc's "OPEN QUESTION"). Both
are largely transport-agnostic: a comment or a suggestion is just Typst
content that rides any delivery mechanism.

Context already in place to reuse:
- `#review(body, by:, on:)` and `#review-reject(target, reason, by:, on:)`
  primitives in `inkycap-notebox/<ver>/lib.typ` (+ `<inkycap-review>` /
  `<inkycap-review-reject>` query labels). `typst_pipeline/review.rs` builds
  the calls + the rejection-log note (`append_to_rejection_log`).
- The rejection log note (`<import_folder>/<name> — Rejected Changes.typ`),
  written by `collab_review_apply`'s Reject branch.
- Visual-editor pill system: `FuncPillWidget` + content-bracket functions
  (the `#review`/`callout`/`quote` pattern), `--popup-*` tokens for floating
  surfaces, context-menu infra.
- `note_rewriter` (AST source transforms; cf. `path_rebase.rs`) for
  accept/reject-as-source-edit.
- `@codemirror/merge` whole-file review (ReviewPanel) — the *current* review
  model these ideas would augment or partly supersede.

---

## Idea 1 — Commentary on ANY decision (not just rejection) — SMALL, do first

Today only **rejections** get a stored note (`#review-reject` → rejection
log). Expand so a reviewer can attach commentary on **accept** too — or leave
a bare comment without deciding.

**Why it's cheap:** `#review[...]` (standalone reviewer comment) already
exists and already travels back in the package. So this is mostly a
**UI-flow gap**, not a new primitive: the accept path needs an optional
comment field that, when filled, drops an attributed+dated `#review[...]`
(or appends to a log).

**Two shapes:**
- **Generalize the rejection log → a "review log"** recording
  accept-with-comment / reject-with-rationale / bare comment alike. (Typst-
  native cousin of the git plan's `decisions.yaml`.)
- Lighter: any decision optionally carries a comment, recorded as a
  `#review[...]` near the note or in the log.

**Verdict:** principled, low-cost, reuses everything. Ship regardless of
Idea 2's fate.

---

## Idea 2 — Inline `#suggestion` pills = Typst-native suggesting mode — BIG

Build change-tracking **into each note** as Typst markup instead of (or
alongside) the diff/merge-view. A new collaboration-mode primitive wraps a
span the author proposes; another user clicks the pill to see/add a threaded
message, or right-clicks for Accept / Reject. "Collaborating by indicating
intentions."

**Prior art / framing:** this is **CriticMarkup** (`{++ins++}`/`{--del--}`/
`{~~old~>new~~}`/`{>>comment<<}` — the academic-markdown convention) reborn as
Typst functions, ≈ Google Docs "Suggesting" / Word Track Changes, but stored
in the document rather than computed by diffing.

**Why it fits InkyCap unusually well:**
- Most Typst-first possible answer to "where do proposed changes live":
  `#suggestion[...]` content + `<inkycap-suggestion>` metadata — readable in
  any Typst tool, plain files, queryable.
- Slots into existing infra: content-bracket pill (`FuncPillWidget`), popup
  for the thread (`--popup-*`), right-click context menu, accept/reject as an
  AST source transform (`note_rewriter`).
- Captures **intent**, in the medium scholars actually collaborate in.

**Why it bears on the open direction debate:** the user's doubt was really
that whole-file *diff* review feels blunt / a poor cousin to git. Inline
suggestions reframe it — the distinctive thing isn't the transport, it's that
the **review model is inline intent, not whole-file diffs**. Neither raw git
nor a zip-diff gives that; it's more aligned with InkyCap's Typst-first
identity. So this may be the real resolution to the doubt (keep any transport
for delivery; make the review experience suggestion-based). It does NOT
discard the membership/identity/packaging work (still needed to move files +
know who's who) — it changes the *unit of review* from "this file diff" to
"this marked intent."

### Design decisions to settle (the hard parts)

1. **One pill isn't enough.** Need ~3 variants: **insert** (accept→unwrap to
   plain text, reject→delete span), **delete** (struck-through; accept→remove,
   reject→keep), **replace** (= delete+insert). Small family, not a single
   pill.

2. **Manual vs. automatic — the big fork.**
   - **Manual** (`/suggestion` palette entry / wrap a selection): deliberate
     "propose this specific change / comment here." Moderate cost, fits the
     pill system today. **Realistic v1.**
   - **Automatic "suggesting mode"** (editor intercepts every keystroke →
     suggestion, à la Google Docs): the wow version, but a substantial CM6
     feature with the full edge-case tax (deletions, overlapping/nested
     suggestions, two reviewers on one span, mode toggle). **Defer to a later
     phase.**

3. **Complements diff-review; doesn't fully replace it.** A `#suggestion`
   *is itself* a diff (added markup), so the existing import/diff sees it. The
   clean design has the review UI **recognize suggestion markup specially**
   (present as a resolvable in-context suggestion, not raw "added text" in a
   merge view). Still need diff+transport for edits made WITHOUT a suggestion
   wrapper → suggestions reduce but don't eliminate "what changed in this
   file." So: suggestions = intent/authoring layer; diff+transport = delivery
   + safety net.

4. **Thread storage = Typst-native, byte-fidelity round-trip.** Store the
   discussion in the function args, e.g.
   `#suggestion(kind:"insert", by:, on:, status:, thread:((by:,text:,on:),…))[content]`.
   The popup writes back into the `#suggestion(...)` args with the same
   byte-fidelity discipline as the `#note(...)` property round-trip — busier
   structure, same rule.

5. **Accept/reject = source transform** of the `.typ` (Rust `note_rewriter`):
   accept-insert→replace call with its content; reject-insert→remove; accept-
   delete→remove struck content; reject-delete→unwrap. Rejection note flows
   into the existing log (ties back to Idea 1's generalized review log).

6. **Rendering** lives in `lib.typ` (Typst-first): insert = underline/colour;
   delete = strike; replace = struck-old + colour-new. Reading view + visual
   pill mirror each other.

### Cons / risks
- Meaningful pivot of the just-committed whole-file diff review (merge-view
  becomes secondary/fallback).
- Overlapping/nested suggestions are where this feature class always gets
  fiddly.
- Thread-in-markup write-back must preserve untouched content byte-for-byte.

---

## Recommended sequencing
1. **Idea 1 first** (comment-on-any-decision) — small, independent, reuses
   `#review` + the rejection log; generalize the log into a review/decisions
   log.
2. **Idea 2 as manual suggestions** — `#suggestion-insert/-delete/-replace` +
   threaded popup (reuse `#review`-style attribution) + accept/reject-as-
   source-transform via `note_rewriter`. Reuses pill system, rejection log,
   note-rewriter; layers on any transport. **Defer automatic "suggesting
   mode."**

## OPEN QUESTION for the user to settle before building Idea 2
Do suggestions **replace** the whole-file diff review for prose, or **live
alongside** it? That decides whether the `@codemirror/merge` merge-view
becomes a fallback or stays a co-equal surface. (User's Word/Google-Docs
experience can settle this faster than analysis.)
