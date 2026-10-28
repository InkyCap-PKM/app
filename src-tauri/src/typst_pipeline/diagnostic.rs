//! Turn Typst's `SourceDiagnostic`s into a form the frontend can show:
//! severity, message, hints, and the span's file and byte range when known.

use std::collections::BTreeMap;
use std::ops::Range;

use serde::Serialize;
use typst::diag::{Severity, SourceDiagnostic};
use typst::syntax::{DiagSpan, DiagSpanKind, FileId, Source, VirtualRoot};
use typst::World;

#[derive(Debug, Clone, Serialize)]
pub struct TypstDiagnostic {
    /// `"error"` or `"warning"` — `"error"` blocks compile output, `"warning"`
    /// does not.
    pub severity: &'static str,
    pub message: String,
    /// Primary source span. `None` when the diagnostic isn't tied to a
    /// specific location (rare).
    pub primary: Option<TypstSpan>,
    /// Trace of secondary spans (Typst includes a call stack for errors that
    /// originate in nested function calls).
    pub trace: Vec<String>,
    pub hints: Vec<String>,
    /// Set on warnings InkyCap adds itself, so the frontend can show them in
    /// the reader's language (`diagnostic.<code>`, filled from `params`).
    /// `message` is the English text, for anywhere that isn't translated.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub code: Option<&'static str>,
    #[serde(skip_serializing_if = "BTreeMap::is_empty")]
    pub params: BTreeMap<&'static str, String>,
}

#[derive(Debug, Clone, Serialize)]
pub struct TypstSpan {
    /// Notebox-relative path of the span's file (e.g. `"notes/heidegger.typ"`).
    /// `None` if Typst couldn't resolve one, usually because the span is in
    /// generated source.
    pub path: Option<String>,
    /// Byte offsets into the file's UTF-8 source.
    pub start: usize,
    pub end: usize,
    /// 1-based line and column of `start`, which is more useful to a writer
    /// than a byte offset. `None` when it can't be mapped (e.g. generated
    /// source).
    ///
    /// These are positions in the compiled source. InkyCap adds style and
    /// notebox lines to the main note before compiling, so for the main file
    /// the command layer shifts `line` back to the file on disk
    /// (`remap_diagnostic_lines` in `commands/typst.rs`); `is_main` says which
    /// spans need it.
    pub line: Option<usize>,
    pub column: Option<usize>,
    /// True when this span points into the note being compiled (as opposed to
    /// an imported file). Only main-file line numbers need injection remapping.
    pub is_main: bool,
    /// The package the span's file belongs to (`@ns/name:version`), if any.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub package: Option<String>,
}

pub fn from_source(diag: &SourceDiagnostic, world: &dyn World) -> TypstDiagnostic {
    TypstDiagnostic {
        severity: severity_str(diag.severity),
        message: diag.message.to_string(),
        primary: resolve_span(diag.span, world),
        trace: diag.trace.iter().map(|t| t.v.to_string()).collect(),
        // 0.15: hints are now `Spanned<EcoString, DiagSpan>`; take the value.
        hints: diag.hints.iter().map(|h| h.v.to_string()).collect(),
        code: None,
        params: BTreeMap::new(),
    }
}

fn severity_str(severity: Severity) -> &'static str {
    match severity {
        Severity::Error => "error",
        Severity::Warning => "warning",
    }
}

/// A `DiagSpan`'s byte range in `source`. A span is detached, numbered (looked
/// up in the source tree) or a raw byte range (used as is). Shared by
/// `recovery` and `source_lint`.
pub(crate) fn diag_span_range(span: DiagSpan, source: &Source) -> Option<Range<usize>> {
    match span.get() {
        DiagSpanKind::Detached => None,
        DiagSpanKind::Number { num, sub_range, .. } => source.range(num, sub_range),
        DiagSpanKind::Range { range, .. } => Some(range),
    }
}

fn resolve_span(span: DiagSpan, world: &dyn World) -> Option<TypstSpan> {
    let id: FileId = span.id()?;
    let source = world.source(id).ok()?;
    let range = diag_span_range(span, &source)?;
    // `byte_to_line` / `byte_to_column` are 0-based; surface 1-based to match
    // how editors and the rest of the UI count.
    let lines = source.lines();
    let line = lines.byte_to_line(range.start).map(|l| l + 1);
    let column = lines.byte_to_column(range.start).map(|c| c + 1);
    Some(TypstSpan {
        path: Some(id.vpath().get_without_slash().to_string()),
        start: range.start,
        end: range.end,
        line,
        column,
        is_main: id == world.main(),
        package: match id.root() {
            VirtualRoot::Package(spec) => Some(spec.to_string()),
            _ => None,
        },
    })
}
