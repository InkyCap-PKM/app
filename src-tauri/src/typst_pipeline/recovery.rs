//! Error-tolerant compilation for the on-screen reading surfaces.
//!
//! Typst's compiler is all-or-nothing: `typst::compile` yields either a
//! complete document or only diagnostics — never a partial document. For a
//! PKM tool that is the wrong default on screen, where a single stray token
//! (e.g. a literal `@2025-09-15` parsed as a cross-reference) would otherwise
//! blank the entire reading view.
//!
//! The recovery loop here keeps the user reading their content: on a failed
//! compile it drops the first errored span that lies in the main file,
//! substitutes a visible marker so the omission is honest, and recompiles —
//! repeating until the document builds or the pass budget is exhausted. The
//! *original* diagnostics are still surfaced to the user by the caller; this
//! module only salvages renderable output.
//!
//! Recovery is deliberately scoped to the reading view and Journal Scroll.
//! PDF/print export ([`compile_pdf`]) stays all-or-nothing so an exported
//! document is never silently incomplete.
//!
//! [`compile_pdf`]: super::compiler::TypstCompiler::compile_pdf

use std::ops::Range;
use std::path::Path;

use typst::diag::SourceDiagnostic;
use typst::syntax::{FileId, LinkedNode, Source, Span, SyntaxKind};
use typst::World;

use crate::typst_pipeline::world::NoteboxWorld;

/// Upper bound on recompiles. Each pass removes one error; errors can cascade
/// (a dropped span exposes or creates a neighbouring one), so a few passes are
/// expected, but an unbounded loop is not — past this budget we give up and
/// let the caller report the failure as before.
const MAX_RECOVERY_PASSES: usize = 8;

/// Visible placeholder injected where an errored span is removed. Valid Typst
/// markup that renders inline as a small red badge, so a reader (or someone
/// proofing a doc before export) can see exactly where content was dropped.
/// Glyph-only by design — no translatable text is injected into note source.
const MARKER: &str = "#box(fill: rgb(\"#fee2e2\"), outset: (y: 2pt), \
inset: (x: 3pt), radius: 2pt)[#text(fill: rgb(\"#b91c1c\"), weight: 700)[\u{26a0}]]";

/// Replace the first recoverable error with [`MARKER`] in the main file,
/// returning the patched source. `None` when no error can be neutralised in
/// the main file — recovery cannot make progress, so the caller should surface
/// the failure unchanged.
///
/// Two cases are recoverable:
/// - the error span lands directly in the main file (e.g. a stray
///   `@2025-09-15` parsed as a cross-reference) — drop that span;
/// - the error originates in a file pulled in by `#import` / `#include`. Typst
///   can't be patched in another file, but it records the offending statement
///   as a *trace span* in the main file ("error occurred while importing this
///   module"); we drop that whole import/include statement so the host still
///   renders, with a marker where the broken transclusion was.
///
/// Spanless errors, and errors whose only location is a third file with no
/// main-file trace, are skipped — there is nothing safe to neutralise here.
fn patch_first_recoverable(world: &NoteboxWorld, errors: &[SourceDiagnostic]) -> Option<String> {
    let main_id = world.main();
    for diag in errors {
        // Prefer the error's own span when it lands in the main file.
        if let Some(patched) = patch_main_for_span(world, main_id, diag.span) {
            return Some(patched);
        }
        // Otherwise the error is inside an imported/included module — follow
        // the trace back to the statement in the main file that pulled it in.
        for tp in &diag.trace {
            if let Some(patched) = patch_main_for_span(world, main_id, tp.span) {
                return Some(patched);
            }
        }
    }
    None
}

/// If `span` resolves into the main file, return the main source with
/// [`MARKER`] substituted over it. When the span sits inside an `#import` /
/// `#include` statement (the trace-span case), the whole statement is dropped
/// rather than just the span, so a failed transclusion doesn't leave a
/// dangling `#include <marker>` behind. `None` when the span is in another
/// file or has no location.
fn patch_main_for_span(world: &NoteboxWorld, main_id: FileId, span: Span) -> Option<String> {
    if span.id()? != main_id {
        return None;
    }
    let source = world.source(main_id).ok()?;
    let direct = source.range(span)?;
    // A trace span from a failed import points at the module-source *string*
    // (e.g. `"/broken.typ"`). Expand to the whole `#import` / `#include`
    // statement so the patch doesn't leave `#include <marker>` — itself a
    // fresh error — behind.
    let range = enclosing_import_range(&source, &direct).unwrap_or(direct);
    let text = source.text();
    let mut patched = String::with_capacity(text.len() + MARKER.len());
    patched.push_str(&text[..range.start]);
    patched.push_str(MARKER);
    patched.push_str(&text[range.end..]);
    Some(patched)
}

/// Range of the outermost `#import` / `#include` statement whose source range
/// contains `target`, if any. Range containment (rather than exact span match)
/// is used because the trace span points at the inner module-source string,
/// not the statement node.
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
            // In markup the leading `#` is a sibling `Hash` token, not part of
            // the import node's range. Extend the start over it so the patch
            // doesn't leave a stray `#` (which would itself be a fresh error).
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

/// Recompile the main document, recovering around localized errors.
///
/// Call this after an initial compile has already failed; pass the diagnostics
/// from that failure as `first_errors`. The world's main file must still hold
/// the source those diagnostics were produced against (the normal state right
/// after a `compile`). On return the world's main source has been replaced
/// with the patched variant — callers that need the original source in the
/// world afterwards must restore it via `set_main`.
///
/// Returns `Some(doc)` once a (possibly degraded) document builds, or `None`
/// if recovery could not make progress within [`MAX_RECOVERY_PASSES`].
pub fn recover<D: typst::Document>(
    world: &NoteboxWorld,
    main_path: &Path,
    first_errors: &[SourceDiagnostic],
) -> Option<D> {
    let mut errors: Vec<SourceDiagnostic> = first_errors.to_vec();
    for _ in 0..MAX_RECOVERY_PASSES {
        let patched = patch_first_recoverable(world, &errors)?;
        world.set_main(main_path, patched).ok()?;
        let warned = typst::compile::<D>(world);
        match warned.output {
            Ok(doc) => return Some(doc),
            Err(errs) => errors = errs.to_vec(),
        }
    }
    None
}
