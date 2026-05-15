//! Build and inject style configuration calls from app-level document
//! defaults and collection-level overrides into Typst source before
//! compilation.
//!
//! Uses a hybrid approach: text/font/paragraph/heading settings are
//! delegated to `apply-vault-defaults` / `apply-collection-style` in
//! `lib.typ` via `#show: fn.with(...)`. Page geometry (`set page(...)`)
//! is emitted as a direct `#set` rule because `set page` inside a
//! show-rule wrapper is a no-op for document-level layout in Typst.
//!
//! Injection order (after the inkycap-vault `#import` line):
//!
//! 1. App document defaults — `#set page(...)` + `#show: apply-vault-defaults.with(...)`
//! 2. Collection style overrides — `#set page(...)` + `#show: apply-collection-style.with(...)`
//! 3. Template import (if any) — template's own rules override 1 & 2
//!
//! The user's own `#set` rules in the document body come after all
//! injections and naturally win via Typst's cascading semantics.

use crate::font_resolver::{self, FontRole};
use crate::settings::{DocumentDefaults, UserSettings};

/// Sanitize a string value for safe embedding in a Typst quoted string literal.
pub fn sanitize_typst_string(s: &str) -> String {
    s.replace('\\', "").replace('"', "")
}

/// Ensure a Typst length expression has a unit suffix. If the trimmed value
/// parses as a bare number (integer or float), append `default_unit`.
/// Values that already contain a unit (e.g. "12pt", "1.5em") pass through.
pub fn ensure_length_unit(value: &str, default_unit: &str) -> String {
    let trimmed = value.trim();
    if trimmed.is_empty() {
        return trimmed.to_string();
    }
    if trimmed.parse::<f64>().is_ok() {
        format!("{}{}", trimmed, default_unit)
    } else {
        trimmed.to_string()
    }
}

/// Parse a CSS-style font stack (e.g. `"Adwaita Mono", "Ubuntu Mono", monospace`)
/// into individual family names, dropping CSS generic keywords (`monospace`,
/// `sans-serif`, `serif`, `system-ui`, etc.) that Typst doesn't recognize.
/// Returns the families in the same order so Typst's own font fallback chain
/// mirrors what the user sees in the editor.
pub fn parse_font_stack(stack: &str) -> Vec<String> {
    const GENERIC_KEYWORDS: &[&str] = &[
        "monospace",
        "sans-serif",
        "serif",
        "system-ui",
        "-apple-system",
        "ui-monospace",
        "ui-sans-serif",
        "ui-serif",
        "cursive",
        "fantasy",
        "emoji",
        "math",
        "fangsong",
    ];

    stack
        .split(',')
        .filter_map(|raw| {
            let trimmed = raw.trim().trim_matches(|c| c == '"' || c == '\'').trim();
            if trimmed.is_empty() {
                return None;
            }
            if GENERIC_KEYWORDS.iter().any(|k| trimmed.eq_ignore_ascii_case(k)) {
                return None;
            }
            Some(trimmed.to_string())
        })
        .collect()
}

/// Format a list of font names as a Typst array literal, or a single quoted
/// string when there's only one. Returns `None` if the list is empty.
fn format_font_value(families: &[String]) -> Option<String> {
    match families.len() {
        0 => None,
        1 => Some(format!("\"{}\"", sanitize_typst_string(&families[0]))),
        _ => {
            let inner = families
                .iter()
                .map(|f| format!("\"{}\"", sanitize_typst_string(f)))
                .collect::<Vec<_>>()
                .join(", ");
            Some(format!("({})", inner))
        }
    }
}

/// Build style rules for app-level document defaults. Returns an empty
/// string when no defaults are set so the caller can skip injection.
///
/// Text/font/monospace settings are emitted as a single
/// `#show: apply-vault-defaults.with(...)` call (lib.typ handles the
/// actual `set` rules). Page geometry is emitted as a direct
/// `#set page(...)` because `set page` inside a show-rule wrapper is a
/// no-op for document-level layout in Typst.
pub fn build_defaults_show_call(doc: &DocumentDefaults, monospace_font: &str) -> String {
    let mut lines: Vec<String> = Vec::new();

    // Page geometry: direct #set rule (required for document-level effect)
    if let Some(ref paper) = doc.page_size {
        if !paper.is_empty() {
            lines.push(format!(
                "#set page(paper: \"{}\")",
                sanitize_typst_string(paper)
            ));
        }
    }

    // Text/font defaults: delegate to lib.typ via #show:
    let mut show_args: Vec<String> = Vec::new();
    if let Some(ref font) = doc.text_font {
        if !font.is_empty() {
            show_args.push(format!("text-font: \"{}\"", sanitize_typst_string(font)));
        }
    }
    if let Some(size) = doc.text_size {
        show_args.push(format!("text-size: {}pt", size));
    }
    let mono_families = parse_font_stack(monospace_font);
    if let Some(value) = format_font_value(&mono_families) {
        show_args.push(format!("monospace-font: {}", value));
    }
    if !show_args.is_empty() {
        lines.push(format!(
            "#show: apply-vault-defaults.with({})",
            show_args.join(", ")
        ));
    }

    lines.join("\n")
}

/// Build defaults rules by resolving the user's `FontSettings` to
/// concrete family names, then delegating to [`build_defaults_show_call`].
/// This is the entry point new code should use; callers pass the full
/// `UserSettings` and we resolve text + monospace internally.
pub fn build_defaults_show_call_resolved(settings: &UserSettings) -> String {
    let resolved_text = font_resolver::resolve_role(FontRole::Text, &settings.fonts);
    let resolved_mono = font_resolver::resolve_role(FontRole::Monospace, &settings.fonts);

    let doc = DocumentDefaults {
        text_font: resolved_text,
        text_size: settings.document.text_size,
        page_size: settings.document.page_size.clone(),
    };
    let mono_str = resolved_mono.unwrap_or_default();
    build_defaults_show_call(&doc, &mono_str)
}

/// Inject style rules into the source after the inkycap-vault import line.
///
/// `defaults_rules`: from `build_defaults_rules()` (app-level)
/// `collection_rules`: from `CollectionStyle::to_typst_show_call()` (collection-level)
///
/// Both are optional and only injected when non-empty. The injection point
/// is immediately after the inkycap-vault import line — recognized via
/// [`crate::vault_package::is_vault_import_line`], which accepts both the
/// canonical `/.inkycap/vault.typ` form and the legacy versioned package
/// path. If no such line is found, rules are prepended to the source.
pub fn inject_style_rules(
    source: &str,
    defaults_rules: Option<&str>,
    collection_rules: Option<&str>,
) -> String {
    let injection = build_injection_block(defaults_rules, collection_rules);
    if injection.is_empty() {
        return source.to_string();
    }

    let mut out = String::with_capacity(source.len() + injection.len() + 4);
    let mut injected = false;

    for line in source.lines() {
        out.push_str(line);
        out.push('\n');

        if !injected && crate::vault_package::is_vault_import_line(line) {
            out.push_str(&injection);
            out.push('\n');
            injected = true;
        }
    }

    if !injected {
        // Fallback: prepend to source
        let mut prepended = injection;
        prepended.push('\n');
        prepended.push_str(&out);
        return prepended;
    }

    out
}

/// Inject a `show cite` rule that tags every citation with a
/// `data-cite-key` attribute in the compiled HTML, so HTML surfaces (the
/// Journal Scroll's Scroll Context panel) can locate a given citation's
/// occurrences and highlight them.
///
/// This is injected in-memory on the HTML render path only. The on-disk
/// note, the `inkycap-vault` package, and the PDF/SVG export path are all
/// untouched — a user's documents and their own exports never carry this
/// wrapper. The rule is placed right after the inkycap-vault import line
/// (so `html` is in scope and it precedes document content); if there is no
/// import line it is prepended.
pub fn inject_cite_tagging(source: &str) -> String {
    // `it.key` is a label; `repr` renders it as `<key>`, so the slice strips
    // the angle brackets to leave the bare citation key.
    const RULE: &str = r#"#show cite: it => html.elem("span", attrs: ("data-cite-key": repr(it.key).slice(1, -1)), it)"#;

    let mut out = String::with_capacity(source.len() + RULE.len() + 2);
    let mut injected = false;
    for line in source.lines() {
        out.push_str(line);
        out.push('\n');
        if !injected && crate::vault_package::is_vault_import_line(line) {
            out.push_str(RULE);
            out.push('\n');
            injected = true;
        }
    }
    if !injected {
        let mut prepended = String::from(RULE);
        prepended.push('\n');
        prepended.push_str(&out);
        return prepended;
    }
    out
}

fn build_injection_block(
    defaults_rules: Option<&str>,
    collection_rules: Option<&str>,
) -> String {
    let mut parts = Vec::new();

    if let Some(defaults) = defaults_rules {
        if !defaults.is_empty() {
            parts.push(defaults.to_string());
        }
    }
    if let Some(collection) = collection_rules {
        if !collection.is_empty() {
            parts.push(collection.to_string());
        }
    }

    parts.join("\n")
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::collection_parser::model::CollectionStyle;

    #[test]
    fn empty_defaults_no_injection() {
        let doc = DocumentDefaults::default();
        let rules = build_defaults_show_call(&doc, "");
        assert!(rules.is_empty());
    }

    #[test]
    fn font_and_page_size_emit_hybrid_rules() {
        let doc = DocumentDefaults {
            text_font: Some("Inter".to_string()),
            text_size: Some(12.0),
            page_size: Some("us-letter".to_string()),
        };
        let rules = build_defaults_show_call(&doc, "");
        // Page geometry: direct #set rule
        assert!(rules.contains("#set page(paper: \"us-letter\")"));
        // Text settings: delegated to lib.typ
        assert!(rules.contains("#show: apply-vault-defaults.with("));
        assert!(rules.contains("text-font: \"Inter\""));
        assert!(rules.contains("text-size: 12pt"));
        // page-paper should NOT be in the show call
        assert!(!rules.contains("page-paper"));
    }

    #[test]
    fn monospace_stack_emits_array_arg() {
        let doc = DocumentDefaults::default();
        let rules = build_defaults_show_call(
            &doc,
            "\"Adwaita Mono\", \"Ubuntu Mono\", \"Fira Mono\", monospace",
        );
        assert!(rules.contains(
            "monospace-font: (\"Adwaita Mono\", \"Ubuntu Mono\", \"Fira Mono\")"
        ));
    }

    #[test]
    fn monospace_single_family_emits_string_arg() {
        let doc = DocumentDefaults::default();
        let rules = build_defaults_show_call(&doc, "Adwaita Mono");
        assert!(rules.contains("monospace-font: \"Adwaita Mono\""));
    }

    #[test]
    fn parse_font_stack_strips_generic_keywords() {
        let families = parse_font_stack("\"JetBrains Mono\", Consolas, monospace");
        assert_eq!(families, vec!["JetBrains Mono", "Consolas"]);
    }

    #[test]
    fn inject_after_import() {
        let source = r#"#import "/.inkycap/packages/inkycap-vault/0.1.0/lib.typ": *

= Hello
"#;
        let result = inject_style_rules(
            source,
            Some("#show: apply-vault-defaults.with(text-font: \"Inter\")"),
            None,
        );
        let import_pos = result.find("inkycap-vault").unwrap();
        let show_pos = result.find("#show: apply-vault-defaults").unwrap();
        assert!(show_pos > import_pos);
    }

    #[test]
    fn collection_overrides_after_defaults() {
        let source = "#import \"/.inkycap/packages/inkycap-vault/0.1.0/lib.typ\": *\n\n= Hello\n";
        let result = inject_style_rules(
            source,
            Some("#show: apply-vault-defaults.with(page-paper: \"a4\")"),
            Some("#show: apply-collection-style.with(page-args: (paper: \"us-letter\"))"),
        );
        let defaults_pos = result.find("apply-vault-defaults").unwrap();
        let collection_pos = result.find("apply-collection-style").unwrap();
        assert!(collection_pos > defaults_pos);
    }

    /// End-to-end: compile a note with the hybrid injection approach —
    /// direct `#set page(...)` for geometry + `#show: apply-vault-defaults.with(...)`
    /// for text — and verify both take effect.
    #[test]
    fn hybrid_injection_changes_page_size_and_text() {
        use crate::storage::path::canonicalize_root;
        use crate::typst_pipeline::compiler::TypstCompiler;
        use std::fs;
        use tempfile::tempdir;

        let dir = tempdir().expect("tempdir");
        let root = canonicalize_root(dir.path()).expect("canonicalize");
        crate::vault_package::scaffold(&root);
        let note_path = root.join("note.typ");

        let doc = DocumentDefaults {
            text_font: Some("Linux Libertine".to_string()),
            text_size: Some(12.0),
            page_size: Some("us-letter".to_string()),
        };
        let rules = build_defaults_show_call(&doc, "");

        let source = format!(
            "{}\n{}\n\n= Hello\n\nBody text.\n",
            crate::vault_package::import_line(),
            rules,
        );
        fs::write(&note_path, &source).expect("write note");

        let mut compiler = TypstCompiler::new(root);
        let result = compiler
            .compile_svg(&note_path, source)
            .expect("compile call");
        assert!(result.ok, "diagnostics: {:#?}", result.diagnostics);
        let width = result.frames[0].width_pt;
        assert!(
            (width - 612.0).abs() < 1.0,
            "expected US Letter (612pt), got {}pt — page set rule was not applied",
            width
        );
    }

    #[test]
    fn collection_style_emits_hybrid_rules() {
        let style = CollectionStyle {
            page: Some(crate::collection_parser::model::PageStyle {
                paper: Some("us-letter".to_string()),
                margin: None,
                columns: Some(2),
                numbering: Some("1".to_string()),
            }),
            text: Some(crate::collection_parser::model::TextStyle {
                font: Some("Times New Roman".to_string()),
                size: Some("12pt".to_string()),
                lang: Some("fr".to_string()),
                region: Some("CA".to_string()),
            }),
            paragraph: Some(crate::collection_parser::model::ParagraphStyle {
                leading: None,
                spacing: None,
                first_line_indent: None,
                justify: Some(true),
            }),
            heading: None,
        };
        let rules = style.to_typst_show_call();
        // Page geometry: direct #set rule
        assert!(rules.contains(
            "#set page(paper: \"us-letter\", columns: 2, numbering: \"1\")"
        ));
        // Text/par: delegated to lib.typ
        assert!(rules.contains("#show: apply-collection-style.with("));
        assert!(rules.contains(
            "text-args: (font: \"Times New Roman\", size: 12pt, lang: \"fr\", region: \"CA\")"
        ));
        assert!(rules.contains("par-args: (justify: true)"));
    }
}
