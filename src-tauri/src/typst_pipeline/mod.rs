//! Typst compile pipeline: one [`TypstCompiler`] per open notebox, used for SVG
//! and HTML rendering, metadata queries and exports.

pub mod bibliography;
pub mod book_wrapper;
pub mod compiler;
pub mod contributors;
pub mod diagnostic;
pub mod fonts;
pub mod link_passages;
pub mod note_excerpt;
pub mod note_rewriter;
pub mod package_fetch;
pub mod package_vendor;
pub mod path_rebase;
pub mod plaintext;
pub mod query;
pub mod recovery;
pub mod review_markup;
pub mod source_lint;
pub mod source_structure;
pub mod style_injection;
pub mod suggestion;
pub mod syntax;
pub mod tag_rewrite;
pub mod template_setup;
pub mod world;
pub mod zotero;

pub use compiler::{
    CompileError, PdfStandardPreset, TypstCompileResult, TypstCompiler, TypstFrame, TypstHtmlResult,
};
pub use diagnostic::TypstDiagnostic;
