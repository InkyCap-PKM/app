//! Re-exports of the `typst` crate's syntax and value types for the few places
//! outside the compile pipeline that need them.
//!
//! Every `use typst::*` is kept inside `typst_pipeline/`, so a Typst upgrade's
//! breakage is in one folder. The search projector
//! ([`crate::search::text_projection`]) and the recurrence parser
//! ([`crate::models::recurrence`]) walk the same syntax tree as the compiler,
//! so they import the types from here instead of `typst::` directly.
//!
//! Plain re-exports, not wrappers. Making another type available elsewhere
//! means adding it here.

pub use typst::foundations::{Dict, Value};
pub use typst::syntax::{ast, parse, LinkedNode, Side, SyntaxKind};
