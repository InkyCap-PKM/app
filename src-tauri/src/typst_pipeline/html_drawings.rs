//! Drawings from packages in the HTML reading view and Journal Scroll.
//!
//! Typst's HTML export leaves out what it can't express as HTML (a `layout`, a
//! `rect`, a drawing canvas), warning "… was ignored during HTML export". Packages
//! that draw (proof trees, diagrams, charts) then show
//! nothing. Typst's own answer is `html.frame`, which lays content out as on a
//! page and embeds it as an SVG image.
//!
//! When those warnings come from a package's files, InkyCap remembers the
//! package, and wraps each outermost call to a function from it (or from a
//! package that uses it) as
//!
//! ```typst
//! {let inkycap-drawn = drawing(…); if type(inkycap-drawn) == content
//!   { html.elem("span", attrs: (class: "inkycap-drawing"),
//!       html.frame(inkycap-drawn)) } else { inkycap-drawn }}
//! ```
//!
//! so content becomes an inline image (whose black the reading view draws in
//! the theme's text colour, through the `inkycap-drawing` class) and other
//! values (a `part(…)` that is only data, a function from `.with`) pass through
//! unchanged. Only the
//! outermost call is wrapped, so the parts a package builds a drawing from
//! reach it intact. This happens only in the compiled copy of an HTML compile:
//! notes are never changed, and PDF export lays drawings out natively.
//!
//! Per CLAUDE.md's Typst-first principle the calls are found with Typst's
//! parser and the drawing is done by `html.frame`; this module only decides
//! where to apply it. Text a call is written inside can't be wrapped without
//! changing the note's offsets, so [`Framed::remap`] moves diagnostics back to
//! positions in the unwrapped source.

use std::collections::HashSet;

use crate::typst_pipeline::compiler::TypstCompiler;
use crate::typst_pipeline::diagnostic::TypstDiagnostic;
use crate::typst_pipeline::package_imports::{package_facts, package_imports};
use crate::typst_pipeline::syntax::{ast, parse, LinkedNode, SyntaxKind};

/// The end of Typst's warning for content HTML export leaves out.
const IGNORED_IN_HTML: &str = "was ignored during HTML export";

const PREFIX: &str = "{let inkycap-drawn = ";
const SUFFIX: &str = "; if type(inkycap-drawn) == content { html.elem(\"span\", attrs: (class: \"inkycap-drawing\"), html.frame(inkycap-drawn)) } else { inkycap-drawn }}";

/// The packages whose files `diagnostics` report content left out of HTML,
/// without repeats.
pub fn packages_with_dropped_content(diagnostics: &[TypstDiagnostic]) -> Vec<String> {
    let mut specs: Vec<String> = Vec::new();
    for diag in diagnostics {
        if diag.severity != "warning" || !diag.message.ends_with(IGNORED_IN_HTML) {
            continue;
        }
        if let Some(spec) = diag.primary.as_ref().and_then(|p| p.package.as_ref()) {
            if !specs.contains(spec) {
                specs.push(spec.clone());
            }
        }
    }
    specs
}

/// Remember `specs` as packages whose content HTML export leaves out. True if
/// any wasn't known yet.
pub fn record_dropped(compiler: &mut TypstCompiler, specs: &[String]) -> bool {
    let mut learned = false;
    for spec in specs {
        learned |= compiler
            .package_facts_cache()
            .record_dropped_in_html(spec.clone());
    }
    learned
}

/// `source` with the outermost calls to drawing packages' functions wrapped
/// for HTML, and where text was inserted.
#[derive(Debug, PartialEq)]
pub struct Framed {
    pub source: String,
    /// Where each insertion went in the unwrapped source, and its length,
    /// in source order.
    insertions: Vec<(usize, usize)>,
}

impl Framed {
    fn unchanged(source: &str) -> Self {
        Framed {
            source: source.to_string(),
            insertions: Vec::new(),
        }
    }

    /// Move the main note's diagnostic spans from the wrapped source back to
    /// `original`, the source before wrapping, recomputing line and column.
    pub fn remap(&self, diagnostics: &mut [TypstDiagnostic], original: &str) {
        if self.insertions.is_empty() {
            return;
        }
        for span in diagnostics
            .iter_mut()
            .filter_map(|d| d.primary.as_mut())
            .filter(|p| p.is_main)
        {
            span.start = self.original_offset(span.start).min(original.len());
            span.end = self
                .original_offset(span.end)
                .max(span.start)
                .min(original.len());
            let before = original.get(..span.start).unwrap_or("");
            span.line = Some(before.matches('\n').count() + 1);
            span.column = Some(before.rsplit('\n').next().map_or(0, |l| l.chars().count()) + 1);
        }
    }

    /// The offset in the unwrapped source of `framed_offset`. An offset inside
    /// inserted text maps to where it was inserted.
    fn original_offset(&self, framed_offset: usize) -> usize {
        let mut shift = 0;
        for &(at, len) in &self.insertions {
            let framed_at = at + shift;
            if framed_offset < framed_at {
                break;
            }
            if framed_offset < framed_at + len {
                return at;
            }
            shift += len;
        }
        framed_offset - shift
    }
}

/// `source` with every outermost call to a function from a package known to
/// draw ([`record_dropped`]) wrapped in `html.frame`. Unchanged when the note
/// imports no such package.
pub fn frame_drawings(compiler: &mut TypstCompiler, source: &str) -> Framed {
    if compiler.package_facts_cache().dropped_in_html().is_empty() || !source.contains("\"@") {
        return Framed::unchanged(source);
    }
    let dropped = compiler.package_facts_cache().dropped_in_html().clone();
    let mut names: HashSet<String> = HashSet::new();
    for import in package_imports(source) {
        let Some(facts) = package_facts(compiler, &import.spec) else {
            continue;
        };
        let draws = dropped.contains(&import.spec)
            || facts.dependencies.iter().any(|d| dropped.contains(d));
        if !draws {
            continue;
        }
        if import.wildcard {
            names.extend(facts.exports.iter().cloned());
        }
        names.extend(import.bound.iter().cloned());
    }
    if names.is_empty() {
        return Framed::unchanged(source);
    }
    wrap_calls(source, &names)
}

/// Wrap each outermost call whose callee is, or is reached through, one of
/// `names` (`drawing(…)`, `example-drawing.drawing(…)`).
fn wrap_calls(source: &str, names: &HashSet<String>) -> Framed {
    let root = parse(source);
    let mut ranges = Vec::new();
    collect_calls(&LinkedNode::new(&root), names, &mut ranges);
    if ranges.is_empty() {
        return Framed::unchanged(source);
    }
    ranges.sort_by_key(|r: &std::ops::Range<usize>| r.start);

    let mut out =
        String::with_capacity(source.len() + ranges.len() * (PREFIX.len() + SUFFIX.len()));
    let mut insertions = Vec::with_capacity(ranges.len() * 2);
    let mut cursor = 0;
    for range in ranges {
        out.push_str(&source[cursor..range.start]);
        out.push_str(PREFIX);
        insertions.push((range.start, PREFIX.len()));
        out.push_str(&source[range.clone()]);
        out.push_str(SUFFIX);
        insertions.push((range.end, SUFFIX.len()));
        cursor = range.end;
    }
    out.push_str(&source[cursor..]);
    Framed {
        source: out,
        insertions,
    }
}

fn collect_calls(
    node: &LinkedNode,
    names: &HashSet<String>,
    out: &mut Vec<std::ops::Range<usize>>,
) {
    if node.kind() == SyntaxKind::FuncCall && can_wrap(node) {
        if let Some(call) = node.cast::<ast::FuncCall>() {
            if callee_root(call.callee()).is_some_and(|n| names.contains(&n)) {
                out.push(node.range());
                return;
            }
        }
    }
    for child in node.children() {
        collect_calls(&child, names, out);
    }
}

/// A call can take the wrapper where code is expected: inside code, or after
/// a `#` in markup or math. A bare call in math (`$ f(x) $`) is math syntax.
fn can_wrap(node: &LinkedNode) -> bool {
    match node.parent_kind() {
        Some(SyntaxKind::Markup | SyntaxKind::Math) => {
            node.prev_sibling_kind() == Some(SyntaxKind::Hash)
        }
        Some(_) => true,
        None => false,
    }
}

/// The name a callee starts from: `f` for `f`, `m.f` and `m.n.f`.
fn callee_root(expr: ast::Expr) -> Option<String> {
    match expr {
        ast::Expr::Ident(ident) => Some(ident.get().to_string()),
        ast::Expr::FieldAccess(access) => callee_root(access.target()),
        _ => None,
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::typst_pipeline::diagnostic::TypstSpan;

    fn names(list: &[&str]) -> HashSet<String> {
        list.iter().map(|s| s.to_string()).collect()
    }

    fn wrapped(call: &str) -> String {
        format!("{PREFIX}{call}{SUFFIX}")
    }

    #[test]
    fn wraps_outermost_calls_only() {
        let src = "Text #drawing(part([A], [B])) end.\n\
                   #figure(example-drawing.drawing(r), caption: [T])\n\
                   #let r = part([C])\n\
                   $ #drawing(r) + part(x) $\n\
                   #other(1)\n";
        let framed = wrap_calls(src, &names(&["drawing", "part", "example-drawing"]));
        let expected = format!(
            "Text #{} end.\n#figure({}, caption: [T])\n#let r = {}\n$ #{} + part(x) $\n#other(1)\n",
            wrapped("drawing(part([A], [B]))"),
            wrapped("example-drawing.drawing(r)"),
            wrapped("part([C])"),
            wrapped("drawing(r)"),
        );
        assert_eq!(framed.source, expected);
    }

    #[test]
    fn maps_diagnostics_back_to_the_unwrapped_source() {
        let src = "#drawing(x)\nNext é #drawing(y) #bad\n";
        let framed = wrap_calls(src, &names(&["drawing"]));
        let bad_framed = framed.source.find("#bad").unwrap();
        let mut diags = vec![TypstDiagnostic {
            severity: "error",
            message: "unknown variable".into(),
            primary: Some(TypstSpan {
                path: None,
                start: bad_framed,
                end: bad_framed + 4,
                line: None,
                column: None,
                is_main: true,
                package: None,
            }),
            trace: vec![],
            hints: vec![],
            code: None,
            params: Default::default(),
        }];
        framed.remap(&mut diags, src);
        let span = diags[0].primary.as_ref().unwrap();
        assert_eq!(&src[span.start..span.end], "#bad");
        assert_eq!((span.line, span.column), (Some(2), Some(20)));
    }

    #[test]
    fn an_offset_inside_inserted_text_maps_to_the_insertion_point() {
        let src = "#f(x)\n";
        let framed = wrap_calls(src, &names(&["f"]));
        assert_eq!(framed.original_offset(1 + 3), 1);
        assert_eq!(framed.original_offset(framed.source.len()), src.len());
    }

    #[test]
    fn a_drawing_left_out_of_html_comes_back_as_an_image() {
        use crate::storage::path::canonicalize_root;
        let dir = tempfile::tempdir().unwrap();
        let root = canonicalize_root(dir.path()).unwrap();
        crate::notebox_package::scaffold(&root);
        let pkg = root.join(".inkycap/packages/local/boxes/0.1.0");
        std::fs::create_dir_all(&pkg).unwrap();
        std::fs::write(
            pkg.join("typst.toml"),
            "[package]\nname = \"boxes\"\nversion = \"0.1.0\"\nentrypoint = \"lib.typ\"\n",
        )
        .unwrap();
        std::fs::write(
            pkg.join("lib.typ"),
            "#let boxed(body) = rect(width: 2cm, body)\n#let label = \"data\"\n",
        )
        .unwrap();
        let note = root.join("note.typ");
        let source = format!(
            "{}\n#import \"@local/boxes:0.1.0\": *\n#note()\nSee #boxed[A] and #label.\n",
            crate::notebox_package::import_line()
        );
        std::fs::write(&note, &source).unwrap();
        let mut compiler = TypstCompiler::new(root);

        let first = frame_drawings(&mut compiler, &source);
        assert_eq!(first.source, source, "nothing known to draw yet");
        let result = compiler.compile_html(&note, first.source.clone()).unwrap();
        assert!(!result.html.contains("<svg"));
        assert!(record_dropped(&mut compiler, &result.dropped_by_packages));

        let framed = frame_drawings(&mut compiler, &source);
        assert_ne!(framed.source, source);
        let result = compiler.compile_html(&note, framed.source.clone()).unwrap();
        assert!(result.ok, "{:?}", result.diagnostics);
        assert!(result.html.contains("<svg"), "{}", result.html);
        assert!(
            result.html.contains("data"),
            "values pass through: {}",
            result.html
        );
        assert!(
            !result
                .diagnostics
                .iter()
                .any(|d| d.message.ends_with(IGNORED_IN_HTML)),
            "{:?}",
            result.diagnostics
        );
    }

    #[test]
    fn finds_packages_that_drop_content() {
        let warn = |message: &str, package: Option<&str>| TypstDiagnostic {
            severity: "warning",
            message: message.into(),
            primary: Some(TypstSpan {
                path: None,
                start: 0,
                end: 0,
                line: None,
                column: None,
                is_main: false,
                package: package.map(String::from),
            }),
            trace: vec![],
            hints: vec![],
            code: None,
            params: Default::default(),
        };
        let diags = vec![
            warn(
                "layout was ignored during HTML export",
                Some("@preview/example-drawing:0.5.1"),
            ),
            warn("rect was ignored during HTML export", None),
            warn("something else", Some("@preview/other:1.0.0")),
            warn(
                "place was ignored during HTML export",
                Some("@preview/example-drawing:0.5.1"),
            ),
        ];
        assert_eq!(
            packages_with_dropped_content(&diags),
            vec!["@preview/example-drawing:0.5.1"]
        );

        let mut compiler = TypstCompiler::new(std::env::temp_dir());
        let specs = packages_with_dropped_content(&diags);
        assert!(record_dropped(&mut compiler, &specs));
        assert!(!record_dropped(&mut compiler, &specs), "already known");
    }
}
