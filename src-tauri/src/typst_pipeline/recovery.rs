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

use std::path::Path;

use typst::World;
use typst::diag::SourceDiagnostic;
use typst::syntax::Span;

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

/// Replace the first error span that resolves into the main file with
/// [`MARKER`], returning the patched source. `None` when no error has a
/// recoverable main-file span — recovery cannot make progress, so the caller
/// should surface the failure unchanged.
///
/// Errors in imported files, or errors with no span, are skipped: rewriting
/// another file to satisfy this note would be a surprising side effect, and a
/// spanless error has no location to neutralise.
fn patch_first_recoverable(world: &NoteboxWorld, errors: &[SourceDiagnostic]) -> Option<String> {
    let main_id = world.main();
    for diag in errors {
        let span: Span = diag.span;
        let Some(id) = span.id() else { continue };
        if id != main_id {
            continue;
        }
        let Ok(source) = world.source(id) else { continue };
        let Some(range) = source.range(span) else { continue };
        let text = source.text();
        let mut patched = String::with_capacity(text.len() + MARKER.len());
        patched.push_str(&text[..range.start]);
        patched.push_str(MARKER);
        patched.push_str(&text[range.end..]);
        return Some(patched);
    }
    None
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
