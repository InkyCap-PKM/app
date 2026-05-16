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
    /// Path of the file the span points into, notebox-rootless (e.g.
    /// `"notes/heidegger.typ"`). `None` if Typst could not resolve a file —
    /// usually because the span is in a synthesized synthetic source.
    pub path: Option<String>,
    /// Byte offsets into the file's UTF-8 source.
    pub start: usize,
    pub end: usize,
    /// 1-based line and column of `start`, resolved via the file's `Source`.
    /// Far more actionable for a writer than the raw byte offset; `None` when
    /// the offset couldn't be mapped (e.g. a synthesized source).
    ///
    /// NOTE: these are positions in the source as *compiled*. InkyCap injects
    /// style/notebox lines into the main note before compiling, so for the main
    /// file the command layer shifts `line` back to the user's on-disk file —
    /// see `remap_diagnostic_lines` in `commands/typst.rs`. `is_main` tells it
    /// which spans need that shift.
    pub line: Option<usize>,
    pub column: Option<usize>,
    /// True when this span points into the note being compiled (as opposed to
    /// an imported file). Only main-file line numbers need injection remapping.
    pub is_main: bool,
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
    // `byte_to_line` / `byte_to_column` are 0-based; surface 1-based to match
    // how editors and the rest of the UI count.
    let lines = source.lines();
    let line = lines.byte_to_line(range.start).map(|l| l + 1);
    let column = lines.byte_to_column(range.start).map(|c| c + 1);
    Some(TypstSpan {
        path: Some(id.vpath().as_rootless_path().to_string_lossy().into_owned()),
        start: range.start,
        end: range.end,
        line,
        column,
        is_main: id == world.main(),
    })
}
