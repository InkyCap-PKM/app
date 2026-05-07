//! Convert Typst's compile-time `SourceDiagnostic` values into a serializable
//! shape the frontend can render. We surface severity, message, hints, and a
//! source span resolved to (file, byte-range) when available.

use serde::Serialize;
use typst::diag::{Severity, SourceDiagnostic};
use typst::syntax::FileId;
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
}

#[derive(Debug, Clone, Serialize)]
pub struct TypstSpan {
    /// Path of the file the span points into, vault-rootless (e.g.
    /// `"notes/heidegger.typ"`). `None` if Typst could not resolve a file —
    /// usually because the span is in a synthesized synthetic source.
    pub path: Option<String>,
    /// Byte offsets into the file's UTF-8 source.
    pub start: usize,
    pub end: usize,
}

pub fn from_source(diag: &SourceDiagnostic, world: &dyn World) -> TypstDiagnostic {
    TypstDiagnostic {
        severity: severity_str(diag.severity),
        message: diag.message.to_string(),
        primary: resolve_span(diag.span, world),
        trace: diag.trace.iter().map(|t| t.v.to_string()).collect(),
        hints: diag.hints.iter().map(|h| h.to_string()).collect(),
    }
}

fn severity_str(severity: Severity) -> &'static str {
    match severity {
        Severity::Error => "error",
        Severity::Warning => "warning",
    }
}

fn resolve_span(span: typst::syntax::Span, world: &dyn World) -> Option<TypstSpan> {
    let id: FileId = span.id()?;
    let source = world.source(id).ok()?;
    let range = source.range(span)?;
    Some(TypstSpan {
        path: Some(id.vpath().as_rootless_path().to_string_lossy().into_owned()),
        start: range.start,
        end: range.end,
    })
}
