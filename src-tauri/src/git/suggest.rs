//! Diff → inline `#suggestion` rendering — the core R&D piece.
//!
//! **Not built yet — Phase 2.** This is the novel, highest-risk component: it
//! maps a **3-way text diff** (merge-base ▸ theirs ▸ mine) onto well-formed
//! `#suggestion` Typst markup in a staged copy, such that resolving every
//! suggestion yields exactly the intended merged source. Hard requirements
//! (specified in full in the Phase 2 plan):
//!
//! - **Round-trips** — the staged copy is valid Typst; the markup never splits
//!   a `#func[...]` call, a math block, or a multi-byte character (UTF-8
//!   discipline per CLAUDE.md: char boundaries / slice copies, never `as char`).
//! - **Passes through** hunks that already *are* `#suggestion`/`#annotation`
//!   markup verbatim — no "suggestion of a suggestion".
//! - **3-way:** one-sided hunks become bulk-acceptable suggestions; hunks both
//!   sides touched become conflict suggestions requiring a choice; local edits
//!   are never lost. No merge base ⇒ fall back to 2-way.
//! - **Per-note fallback:** a note whose diff can't be cleanly suggestion-ized
//!   falls back to the raw `@codemirror/merge` view for that note only.
//!   Correctness over coverage.
//!
//! It sits here in Phase 1 only to fix the module boundary.
