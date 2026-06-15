//! Re-exports of the `typst` crate's public AST and value types for the few
//! call sites *outside* the compile pipeline that legitimately need them.
//!
//! Why this module exists (CLAUDE.md Typst-first / the typst-upgrade runbook):
//! a compiler bump's two real costs are finding which call sites broke and
//! confirming output didn't shift. We attack the first by confining every
//! `use typst::*` import to `typst_pipeline/`, so a bump's blast radius is one
//! directory. The search projector ([`crate::search::text_projection`]) and the
//! recurrence parser ([`crate::models::recurrence`]) need the real syntax/value
//! types — they parse and walk the same AST the compiler does — so they import
//! them from here rather than reaching for `typst::` directly.
//!
//! These are pure re-exports, not wrappers: the consumers need the genuine
//! types. Exposing a new symbol to the rest of the tree means adding it here,
//! which keeps the `use typst::` surface greppable and in one place.

pub use typst::foundations::{Dict, Value};
pub use typst::syntax::{ast, parse, LinkedNode, SyntaxKind};
