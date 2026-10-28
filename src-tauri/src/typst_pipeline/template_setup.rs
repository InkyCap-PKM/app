//! Finds the `#show:` rules in a collection's Custom Typst that apply its
//! template: to put a template's starter rule in, replacing the rule a
//! previously chosen template left there, and to leave them out of exports that
//! don't import the template.
//!
//! The collection's template setting adds `#import "<template>": *` to PDF
//! exports, and the Custom Typst applies it with `#show: <fn>.with(…)`. A rule
//! is treated as a template's when it applies a bare name (`#show: f` or
//! `#show: f.with(…)`) that the Custom Typst doesn't define or import itself and
//! the notebox package doesn't export: only the template import can supply such
//! a name. Without that import (after a switch to another template, or in the
//! static site export) the rule fails with "unknown variable". Per CLAUDE.md's
//! Typst-first principle the rules and bindings are found with Typst's own
//! parser.

use std::collections::HashSet;
use std::ops::Range;
use std::sync::OnceLock;

use crate::typst_pipeline::syntax::{ast, parse, SyntaxKind};

/// A whole-document `#show:` rule that applies a bare name.
pub(crate) struct AppliedRule {
    /// From the `#` through the end of the rule.
    pub(crate) range: Range<usize>,
    pub(crate) name: String,
}

/// What the Custom Typst defines for itself, at top level.
struct LocalBindings {
    names: HashSet<String>,
    /// A `#import "…": *` can bind any name, so no name can be attributed to
    /// the template.
    has_wildcard_import: bool,
}

/// `custom` with `starter` (a template's `#show: <fn>.with(…)` rule) applied:
///
/// - if a rule already applies the starter's function, it is kept as the user
///   filled it in;
/// - otherwise the first rule left by an earlier template is replaced by the
///   starter, or, with none, the starter goes at the top;
/// - every other rule left by an earlier template is removed.
///
/// Returns `custom` unchanged if `starter` doesn't parse as such a rule.
pub fn apply_template_starter(custom: &str, starter: &str) -> String {
    let Some(starter_name) = applied_rules(starter).into_iter().next().map(|r| r.name) else {
        return custom.to_string();
    };

    let already_applied = applied_rules(custom).iter().any(|r| r.name == starter_name);
    let stale: Vec<AppliedRule> = template_rules(custom)
        .into_iter()
        .filter(|r| r.name != starter_name)
        .collect();

    let mut out = String::with_capacity(custom.len() + starter.len());
    let mut cursor = 0;
    let mut placed = already_applied;
    for rule in &stale {
        out.push_str(&custom[cursor..rule.range.start]);
        if placed {
            cursor = removal_end(custom, rule.range.end);
        } else {
            out.push_str(starter);
            cursor = rule.range.end;
            placed = true;
        }
    }
    out.push_str(&custom[cursor..]);

    if placed {
        out
    } else if out.trim().is_empty() {
        format!("{starter}\n")
    } else {
        format!("{starter}\n\n{out}")
    }
}

/// `custom` without the rules that apply a template, for an export that
/// doesn't import the collection's template.
pub fn without_template_rules(custom: &str) -> String {
    without_stale_template_rules(custom, None)
}

/// The template rules in `custom` that the collection's template can't supply,
/// so they would fail as unknown names: every one when there is no template
/// (`provided` is `None`), else those applying a name not in `provided` (the
/// template's exports), left from a template chosen before. Names in source
/// order.
pub fn stale_template_rule_names(custom: &str, provided: Option<&HashSet<String>>) -> Vec<String> {
    stale_template_rules(custom, provided)
        .into_iter()
        .map(|r| r.name)
        .collect()
}

/// `custom` without the rules [`stale_template_rule_names`] finds.
pub fn without_stale_template_rules(custom: &str, provided: Option<&HashSet<String>>) -> String {
    let mut out = String::with_capacity(custom.len());
    let mut cursor = 0;
    for rule in stale_template_rules(custom, provided) {
        out.push_str(&custom[cursor..rule.range.start]);
        cursor = removal_end(custom, rule.range.end);
    }
    out.push_str(&custom[cursor..]);
    out
}

fn stale_template_rules(custom: &str, provided: Option<&HashSet<String>>) -> Vec<AppliedRule> {
    template_rules(custom)
        .into_iter()
        .filter(|r| provided.is_none_or(|names| !names.contains(&r.name)))
        .collect()
}

/// The rules in `source` that only a template import can resolve, in source
/// order. None when a wildcard import could be supplying the names.
fn template_rules(source: &str) -> Vec<AppliedRule> {
    let locals = local_bindings(source);
    if locals.has_wildcard_import {
        return Vec::new();
    }
    applied_rules(source)
        .into_iter()
        .filter(|r| !locals.names.contains(&r.name) && !notebox_exports().contains(&r.name))
        .collect()
}

/// Top-level `#show: f` and `#show: f.with(…)` rules, in source order.
pub(crate) fn applied_rules(source: &str) -> Vec<AppliedRule> {
    let root = parse(source);
    let mut rules = Vec::new();
    let mut offset = 0;
    let mut hash_at = None;
    for child in root.children() {
        match child.kind() {
            SyntaxKind::Hash => hash_at = Some(offset),
            SyntaxKind::ShowRule => {
                if let Some(rule) = child.cast::<ast::ShowRule>() {
                    if rule.selector().is_none() {
                        if let (Some(start), Some(name)) = (hash_at, applied_name(rule.transform()))
                        {
                            rules.push(AppliedRule {
                                range: start..offset + child.len(),
                                name,
                            });
                        }
                    }
                }
                hash_at = None;
            }
            _ => hash_at = None,
        }
        offset += child.len();
    }
    rules
}

/// `f` for a transform of `f` or `f.with(…)`.
fn applied_name(transform: ast::Expr) -> Option<String> {
    match transform {
        ast::Expr::Ident(ident) => Some(ident.get().to_string()),
        ast::Expr::FuncCall(call) => match call.callee() {
            ast::Expr::FieldAccess(access) if access.field().get() == "with" => {
                match access.target() {
                    ast::Expr::Ident(ident) => Some(ident.get().to_string()),
                    _ => None,
                }
            }
            _ => None,
        },
        _ => None,
    }
}

/// Names bound by top-level `#let`s and `#import`s.
fn local_bindings(source: &str) -> LocalBindings {
    let root = parse(source);
    let mut names = HashSet::new();
    let mut has_wildcard_import = false;
    for child in root.children() {
        if let Some(binding) = child.cast::<ast::LetBinding>() {
            names.extend(
                binding
                    .kind()
                    .bindings()
                    .iter()
                    .map(|i| i.get().to_string()),
            );
        } else if let Some(import) = child.cast::<ast::ModuleImport>() {
            if let Some(name) = import.new_name() {
                names.insert(name.get().to_string());
            }
            match import.imports() {
                Some(ast::Imports::Wildcard) => has_wildcard_import = true,
                Some(ast::Imports::Items(items)) => {
                    names.extend(items.iter().map(|i| i.bound_name().get().to_string()));
                }
                // A bare `#import "x.typ"` binds the module name, which a
                // rule can only use as `x.f`, never as a bare name.
                None => {}
            }
        }
    }
    LocalBindings {
        names,
        has_wildcard_import,
    }
}

/// Top-level names of the bundled `inkycap-notebox` package, which every note
/// imports.
pub(crate) fn notebox_exports() -> &'static HashSet<String> {
    static NAMES: OnceLock<HashSet<String>> = OnceLock::new();
    NAMES.get_or_init(|| {
        let lib = std::str::from_utf8(crate::notebox_package::LIB_TYP_BYTES).unwrap_or("");
        local_bindings(lib).names
    })
}

/// Where a removed rule's leftovers end: past trailing spaces, its line break,
/// and one blank line after it, so removal leaves no gap.
fn removal_end(source: &str, end: usize) -> usize {
    let bytes = source.as_bytes();
    let skip_line = |mut i: usize| -> Option<usize> {
        while i < bytes.len() && (bytes[i] == b' ' || bytes[i] == b'\t' || bytes[i] == b'\r') {
            i += 1;
        }
        match bytes.get(i) {
            Some(b'\n') => Some(i + 1),
            None => Some(i),
            _ => None,
        }
    };
    let Some(after_rule) = skip_line(end) else {
        return end;
    };
    skip_line(after_rule).unwrap_or(after_rule)
}

#[cfg(test)]
mod tests {
    use super::*;

    const IEEE: &str = "#show: ieee.with(\n  title: [A Paper],\n)";
    const ACM: &str = "#show: acmart.with(\n  title: [Title],\n)";

    #[test]
    fn finds_and_removes_rules_the_template_cannot_supply() {
        let custom = "#show: old-template.with(title: [T])\n\n#set text(red)\n";
        assert_eq!(
            stale_template_rule_names(custom, None),
            vec!["old-template"]
        );
        assert_eq!(
            without_stale_template_rules(custom, None),
            "#set text(red)\n"
        );

        let current: HashSet<String> = ["new-template".to_string()].into();
        assert_eq!(
            stale_template_rule_names(custom, Some(&current)),
            vec!["old-template"]
        );
        let own = "#show: new-template.with(title: [T])\n";
        assert!(stale_template_rule_names(own, Some(&current)).is_empty());
        assert_eq!(without_stale_template_rules(own, Some(&current)), own);
    }

    #[test]
    fn inserts_at_top_when_absent() {
        assert_eq!(apply_template_starter("", IEEE), format!("{IEEE}\n"));
        assert_eq!(
            apply_template_starter("#set text(red)\n", IEEE),
            format!("{IEEE}\n\n#set text(red)\n")
        );
    }

    #[test]
    fn keeps_filled_in_rule_for_same_template() {
        let custom = "#show: ieee.with(title: [My Real Title])\n#set text(red)\n";
        assert_eq!(apply_template_starter(custom, IEEE), custom);
    }

    #[test]
    fn replaces_previous_templates_rule_in_place() {
        let custom = "#set par(justify: true)\n\n#show: ieee.with(\n  title: [Mine],\n)\n\n#show heading: set text(navy)\n";
        assert_eq!(
            apply_template_starter(custom, ACM),
            format!("#set par(justify: true)\n\n{ACM}\n\n#show heading: set text(navy)\n")
        );
    }

    #[test]
    fn removes_rules_stacked_by_earlier_switches() {
        // What repeated switches used to leave: each new rule added on top.
        let custom = format!("{ACM}\n\n{IEEE}\n\n#show: charged.with(x: 1)\n\n#set text(red)\n");
        assert_eq!(
            apply_template_starter(&custom, ACM),
            format!("{ACM}\n\n#set text(red)\n")
        );
    }

    #[test]
    fn bare_form_counts_as_applied() {
        let custom = "#show: ieee\n";
        assert_eq!(
            apply_template_starter(custom, "#show: acmart"),
            "#show: acmart\n"
        );
    }

    #[test]
    fn leaves_rules_using_local_or_notebox_names() {
        let custom = "#let mine(body) = body\n#import \"/x.typ\": other as renamed\n#show: mine\n#show: renamed.with(a: 1)\n#show: apply-collection-style.with()\n#show: rest => columns(2, rest)\n";
        assert_eq!(
            apply_template_starter(custom, IEEE),
            format!("{IEEE}\n\n{custom}")
        );
    }

    #[test]
    fn wildcard_import_disables_replacement() {
        let custom = "#import \"/mine.typ\": *\n#show: ieee.with()\n";
        assert_eq!(
            apply_template_starter(custom, ACM),
            format!("{ACM}\n\n{custom}")
        );
    }

    #[test]
    fn selector_rules_and_comments_are_ignored() {
        let custom = "// #show: ieee.with()\n#show heading: ieee\n";
        assert_eq!(
            apply_template_starter(custom, ACM),
            format!("{ACM}\n\n{custom}")
        );
    }

    #[test]
    fn keeps_multibyte_text_intact() {
        let custom = "// Thèse — résumé\n#show: ieee.with(title: [Été])\n#set text(lang: \"fr\")\n";
        assert_eq!(
            apply_template_starter(custom, ACM),
            format!("// Thèse — résumé\n{ACM}\n#set text(lang: \"fr\")\n")
        );
    }

    #[test]
    fn unparseable_starter_changes_nothing() {
        assert_eq!(
            apply_template_starter("#set text(red)", "not a rule"),
            "#set text(red)"
        );
    }

    #[test]
    fn without_template_rules_keeps_everything_else() {
        let custom = format!(
            "#let mine(body) = body\n{IEEE}\n\n#show: mine\n#show heading: set text(navy)\n"
        );
        assert_eq!(
            without_template_rules(&custom),
            "#let mine(body) = body\n#show: mine\n#show heading: set text(navy)\n"
        );
        assert_eq!(without_template_rules(IEEE), "");
        let wildcard = format!("#import \"/mine.typ\": *\n{IEEE}\n");
        assert_eq!(without_template_rules(&wildcard), wildcard);
    }

    /// The whole setup flow against real packages: set up one template, switch
    /// to another and set up again, and the collection still exports.
    #[test]
    fn switching_templates_keeps_export_compiling() {
        use crate::typst_pipeline::compiler::{PdfStandardPreset, TypstCompiler};
        use std::fs;

        let dir = tempfile::tempdir().expect("tempdir");
        let root = crate::storage::path::canonicalize_root(dir.path()).expect("canonical root");
        for name in ["alpha", "beta"] {
            let pkg = root
                .join(".inkycap/packages/local")
                .join(name)
                .join("0.1.0");
            fs::create_dir_all(pkg.join("template")).unwrap();
            fs::write(
                pkg.join("typst.toml"),
                format!(
                    "[package]\nname = \"{name}\"\nversion = \"0.1.0\"\nentrypoint = \"lib.typ\"\n\n\
                     [template]\npath = \"template\"\nentrypoint = \"main.typ\"\n"
                ),
            )
            .unwrap();
            fs::write(
                pkg.join("lib.typ"),
                format!("#let {name}(title: none, body) = {{\n  [#title]\n  body\n}}\n"),
            )
            .unwrap();
            fs::write(
                pkg.join("template/main.typ"),
                format!(
                    "#import \"@local/{name}:0.1.0\": *\n#show: {name}.with(\n  title: [T],\n)\n\n= Intro\n"
                ),
            )
            .unwrap();
        }
        let note = root.join("note.typ");
        fs::write(&note, "").unwrap();
        let mut compiler = TypstCompiler::new(root.clone());
        let mut export = |custom: &str, template: &str| {
            compiler.compile_pdf_with_template(
                &note,
                format!("{custom}\n= Chapter\n\nBody.\n"),
                template,
                None,
                PdfStandardPreset::default(),
                false,
            )
        };

        let alpha = crate::typst_packages::template_starter_snippet(&root, "@local/alpha:0.1.0")
            .expect("alpha starter");
        let custom = apply_template_starter("#set text(lang: \"en\")\n", &alpha);
        export(&custom, "@local/alpha:0.1.0").expect("alpha exports");

        let beta = crate::typst_packages::template_starter_snippet(&root, "@local/beta:0.1.0")
            .expect("beta starter");
        // Stacking the new rule above the old one leaves `alpha` unresolved.
        assert!(export(&format!("{beta}\n\n{custom}"), "@local/beta:0.1.0").is_err());
        let custom = apply_template_starter(&custom, &beta);
        assert!(!custom.contains("alpha"), "{custom}");
        export(&custom, "@local/beta:0.1.0").expect("beta exports after the switch");

        // The static site compiles to HTML without the template import.
        let mut site = |custom: &str| {
            compiler
                .compile_html(&note, format!("{custom}\n= Chapter\n\nBody.\n"))
                .expect("html compile")
                .ok
        };
        assert!(!site(&custom), "the template rule alone can't resolve");
        assert!(site(&without_template_rules(&custom)));
    }
}
