//! Error-tolerant compiling for the reading surfaces.
//!
//! Typst produces either a whole document or only errors, so one stray token
//! (e.g. `@2025-09-15` read as a reference) would blank the reading view. On a
//! failed compile this drops the first errored span in the main file, puts a
//! visible marker in its place, and recompiles, until the document builds or
//! the pass limit is reached. The caller still reports the original errors.
//!
//! Two styles ([`RecoveryStyle`]): the reading view and Journal Scroll replace
//! each errored span with a warning marker. Exports don't recover by default,
//! so an export is never silently incomplete; when the user chooses to bypass
//! errors, the errored source is kept as plain text so nothing is lost.

use std::ops::Range;
use std::path::Path;

use typst::diag::SourceDiagnostic;
use typst::syntax::{DiagSpan, FileId, LinkedNode, Source, SyntaxKind};
use typst::World;

use crate::typst_pipeline::world::NoteboxWorld;

/// Maximum recompiles. Each pass removes one error, and errors can cascade, so
/// a few passes are normal; past this the caller reports the failure.
const MAX_RECOVERY_PASSES: usize = 8;

/// How an errored span is neutralised during recovery.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum RecoveryStyle {
    /// Replace the span with [`MARKER`], a small warning badge. Used on screen,
    /// where the reader should see that something was dropped.
    Marker,
    /// Replace the element holding the error with its own source as plain text.
    /// For exports that bypass errors: content is kept, only its styling or
    /// behaviour is lost.
    LiteralText,
}

/// Recompile limit for [`RecoveryStyle::LiteralText`], higher than on screen,
/// since an export is a one-off and a note with several mistakes should still
/// come out whole.
const MAX_LITERAL_PASSES: usize = 32;

/// Placeholder where an errored span was removed: valid markup rendering a
/// small red badge, so readers see where content was dropped. Only a glyph, so
/// no translatable text goes into the source.
const MARKER: &str = "#box(fill: rgb(\"#fee2e2\"), outset: (y: 2pt), \
inset: (x: 3pt), radius: 2pt)[#text(fill: rgb(\"#b91c1c\"), weight: 700)[\u{26a0}]]";

/// Replace the first recoverable error in the main file with [`MARKER`] and
/// return the patched source, or `None` if none can be, in which case the
/// caller reports the failure unchanged.
///
/// - An error in the main file (e.g. `@2025-09-15`): drop that span.
/// - An error in a file brought in by `#import` / `#include`: that file can't
///   be patched, but Typst records the statement as a trace span in the main
///   file, so drop the whole statement and leave a marker.
///
/// Errors without a span, or only in a third file with no trace in the main
/// file, are skipped.
fn patch_first_recoverable(
    world: &NoteboxWorld,
    errors: &[SourceDiagnostic],
    style: RecoveryStyle,
) -> Option<String> {
    let main_id = world.main();
    for diag in errors {
        // Prefer the error's own span when it lands in the main file.
        if let Some(patched) = patch_main_for_span(world, main_id, diag.span, style) {
            return Some(patched);
        }
        // Otherwise the error is inside an imported/included module — follow
        // the trace back to the statement in the main file that pulled it in.
        for tp in &diag.trace {
            // Trace-point spans are plain `Span`s; lift to `DiagSpan`.
            if let Some(patched) = patch_main_for_span(world, main_id, tp.span.into(), style) {
                return Some(patched);
            }
        }
    }
    None
}

/// If `span` is in the main file, the main source with the span neutralized per
/// `style`. A span inside an `#import` / `#include` drops the whole statement, so
/// no `#include <marker>` is left. `None` for spans in other files or without a
/// location.
fn patch_main_for_span(
    world: &NoteboxWorld,
    main_id: FileId,
    span: DiagSpan,
    style: RecoveryStyle,
) -> Option<String> {
    if span.id()? != main_id {
        return None;
    }
    let source = world.source(main_id).ok()?;
    let direct = super::diagnostic::diag_span_range(span, &source)?;
    // A failed import's trace span points at the module string
    // (`"/broken.typ"`); widen to the whole statement, since `#include
    // <marker>` would be a new error.
    let range = enclosing_import_range(&source, &direct).unwrap_or(direct);
    let text = source.text();
    let (range, replacement) = match style {
        RecoveryStyle::Marker => (range, MARKER.to_string()),
        RecoveryStyle::LiteralText => {
            // Widen to the whole markup element (e.g. the `#func(...)` call
            // around a bad argument) so the replacement is valid and shows the
            // source as written.
            let range = enclosing_markup_element(&source, &range).unwrap_or(range);
            let literal = typst_string_literal(&text[range.clone()]);
            (range, literal)
        }
    };
    let mut patched = String::with_capacity(text.len() + replacement.len());
    patched.push_str(&text[..range.start]);
    patched.push_str(&replacement);
    patched.push_str(&text[range.end..]);
    Some(patched)
}

/// The innermost element directly in markup that contains `target`, including a
/// leading `#` for embedded code. Replacing it with a string is always valid,
/// whereas replacing just a span inside code could leave the error. `None` if
/// no single element contains it.
fn enclosing_markup_element(source: &Source, target: &Range<usize>) -> Option<Range<usize>> {
    fn contains(node: &LinkedNode, target: &Range<usize>) -> bool {
        let r = node.range();
        r.start <= target.start && target.end <= r.end
    }
    let mut found = None;
    let mut node = LinkedNode::new(source.root());
    loop {
        let Some(child) = node.children().find(|c| contains(c, target)) else {
            return found;
        };
        if node.kind() == SyntaxKind::Markup {
            let start = match child.prev_sibling() {
                Some(prev) if prev.kind() == SyntaxKind::Hash => prev.range().start,
                _ => child.range().start,
            };
            found = Some(start..child.range().end);
        }
        node = child;
    }
}

/// `text` as a Typst string in markup (`#"...";`), shown as plain text. The `;`
/// ends the expression, so a following `(`, `[` or `.` stays text.
fn typst_string_literal(text: &str) -> String {
    let mut out = String::with_capacity(text.len() + 4);
    out.push_str("#\"");
    for c in text.chars() {
        match c {
            '\\' => out.push_str("\\\\"),
            '"' => out.push_str("\\\""),
            '\n' => out.push_str("\\n"),
            '\r' => out.push_str("\\r"),
            '\t' => out.push_str("\\t"),
            _ => out.push(c),
        }
    }
    out.push_str("\";");
    out
}

/// The outermost `#import` / `#include` statement containing `target`, if any.
/// By containment, since the trace span is the inner string.
fn enclosing_import_range(source: &Source, target: &Range<usize>) -> Option<Range<usize>> {
    fn search(node: &LinkedNode, target: &Range<usize>) -> Option<Range<usize>> {
        let r = node.range();
        if r.start > target.start || r.end < target.end {
            return None; // doesn't contain the target — neither will its children
        }
        if matches!(
            node.kind(),
            SyntaxKind::ModuleImport | SyntaxKind::ModuleInclude
        ) {
            // In markup the `#` is a separate `Hash` token; include it, or a
            // stray `#` would be a new error.
            let start = match node.prev_sibling() {
                Some(prev) if prev.kind() == SyntaxKind::Hash => prev.range().start,
                _ => r.start,
            };
            return Some(start..r.end);
        }
        node.children().find_map(|child| search(&child, target))
    }
    search(&LinkedNode::new(source.root()), target)
}

/// Recompile the main document around localized errors. Call after a failed
/// compile, passing its errors as `first_errors`; the world's main file must
/// still hold that source. Afterwards the world holds the patched source, so
/// callers needing the original must restore it with `set_main`.
///
/// `Some(doc)` once a (possibly degraded) document builds, `None` if recovery
/// can't make progress within the style's limit.
pub fn recover<D: typst::foundations::Output>(
    world: &NoteboxWorld,
    main_path: &Path,
    first_errors: &[SourceDiagnostic],
    style: RecoveryStyle,
) -> Option<D> {
    let passes = match style {
        RecoveryStyle::Marker => MAX_RECOVERY_PASSES,
        RecoveryStyle::LiteralText => MAX_LITERAL_PASSES,
    };
    let mut errors: Vec<SourceDiagnostic> = first_errors.to_vec();
    for _ in 0..passes {
        let patched = patch_first_recoverable(world, &errors, style)?;
        world.set_main(main_path, patched).ok()?;
        let warned = typst::compile::<D>(world);
        match warned.output {
            Ok(doc) => return Some(doc),
            Err(errs) => errors = errs.to_vec(),
        }
    }
    None
}
