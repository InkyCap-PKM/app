//! Typst compile pipeline.
//!
//! Phase 1 surface: build a [`TypstCompiler`] per open vault, compile a `.typ`
//! file to per-page SVG for reading mode. Bibliography auto-prepend is wired
//! in but the rest of the layered features (query for metadata, PDF export,
//! incremental edits, package resolution, fonts beyond the embedded set) land
//! in later phases.
//!
//! See [TYPST_PIVOT.md](../../../TYPST_PIVOT.md) §6 for the design.

pub mod bibliography;
pub mod book_wrapper;
pub mod compiler;
pub mod diagnostic;
pub mod fonts;
pub mod note_rewriter;
pub mod query;
pub mod style_injection;
pub mod world;
pub mod zotero;

pub use compiler::{CompileError, TypstCompileResult, TypstCompiler, TypstFrame, TypstHtmlResult};
pub use diagnostic::TypstDiagnostic;
