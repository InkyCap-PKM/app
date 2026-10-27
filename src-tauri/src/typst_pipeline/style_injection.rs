//! Add style rules from the app's document defaults and a collection's overrides to Typst
//! source before compiling.
//!
//! Text, font, paragraph and heading settings go through `apply-notebox-defaults` /
//! `apply-collection-style` in `lib.typ` as `#show: fn.with(...)`. Page geometry is a direct
//! `#set page(...)`, since `set page` inside a show rule has no effect on the document's
//! layout.
//!
//! Order, after the notebox `#import` line:
//!
//! 1. App defaults: `#set page(...)` + `#show: apply-notebox-defaults.with(...)`
//! 2. Collection overrides: `#set page(...)` + `#show:
//!    apply-collection-style.with(...)`
//! 3. Template import, if any, whose rules override 1 and 2
//!
//! `#set` rules in the document come after all of these and win through the cascade.

use crate::font_resolver::{self, FontRole};
use crate::settings::{DocumentDefaults, UserSettings};

/// Escape a value for a Typst `"..."` literal (`\` → `\\`, `"` → `\"`), so
/// unusual font or paper names survive and can't inject code. Backslashes
/// first, so the quote escape isn't doubled.
pub fn sanitize_typst_string(s: &str) -> String {
    s.replace('\\', "\\\\").replace('"', "\\\"")
}

/// Add `default_unit` to a bare number; values with a unit ("12pt", "1.5em")
/// are unchanged.
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

/// Family names from a CSS font stack (e.g. `"Adwaita Mono", "Ubuntu Mono",
/// monospace`), in order, without CSS generic keywords (`monospace`,
/// `sans-serif`, …), so Typst's fallback matches the editor's.
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
            if GENERIC_KEYWORDS
                .iter()
                .any(|k| trimmed.eq_ignore_ascii_case(k))
            {
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

/// Style rules for the app's document defaults, or "" when none are set. Text
/// and fonts go in one `#show: apply-notebox-defaults.with(...)` (lib.typ
/// applies the `set` rules); page size is a direct `#set page(...)` so it is
/// fixed before any wrapper runs.
pub fn build_defaults_show_call(
    doc: &DocumentDefaults,
    text_font: Option<&str>,
    monospace_font: &str,
) -> String {
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
    if let Some(font) = text_font {
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
            "#show: apply-notebox-defaults.with({})",
            show_args.join(", ")
        ));
    }

    lines.join("\n")
}

/// Default rules from the user's `FontSettings` (resolved to text and monospace
/// families) and `DocumentDefaults` (text and page size). Use this in new code.
pub fn build_defaults_show_call_resolved(user: &UserSettings) -> String {
    let resolved_text = font_resolver::resolve_role(FontRole::Text, &user.fonts);
    let resolved_mono = font_resolver::resolve_role(FontRole::Monospace, &user.fonts);
    let mono_str = resolved_mono.unwrap_or_default();
    build_defaults_show_call(&user.document, resolved_text.as_deref(), &mono_str)
}

/// Insert style rules after the notebox import line (found with
/// [`crate::notebox_package::is_notebox_import_line`]), or at the top without one.
/// `defaults_rules` (from `build_defaults_rules()`) and `collection_rules` (from
/// `CollectionStyle::to_typst_show_call()`) are added only when non-empty.
pub fn inject_style_rules(
    source: &str,
    defaults_rules: Option<&str>,
    collection_rules: Option<&str>,
    custom_typst: Option<&str>,
) -> String {
    let injection = build_injection_block(defaults_rules, collection_rules, custom_typst);
    if injection.is_empty() {
        return source.to_string();
    }

    let mut out = String::with_capacity(source.len() + injection.len() + 4);
    let mut injected = false;

    for line in source.lines() {
        out.push_str(line);
        out.push('\n');

        if !injected && crate::notebox_package::is_notebox_import_line(line) {
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

/// Add a `show cite` rule that tags each citation with `data-cite-key` in HTML,
/// so the Journal Scroll's Scroll Context panel can find and highlight them.
/// HTML rendering only, in memory; notes, the package and PDF/SVG output are
/// unaffected. Placed after the notebox import (so `html` is in scope), or at
/// the top without one.
pub fn inject_cite_tagging(source: &str) -> String {
    // `it.key` is a label; `repr` renders it as `<key>`, so the slice strips
    // the angle brackets to leave the bare citation key.
    const RULE: &str = r#"#show cite: it => html.elem("span", attrs: ("data-cite-key": repr(it.key).slice(1, -1)), it)"#;

    let mut out = String::with_capacity(source.len() + RULE.len() + 2);
    let mut injected = false;
    for line in source.lines() {
        out.push_str(line);
        out.push('\n');
        if !injected && crate::notebox_package::is_notebox_import_line(line) {
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

/// Add `#show align: html-align` on the HTML path. typst-html has no output for
/// `align()`, so aligned blocks (notably images) would be dropped; `html-align`
/// in lib.typ re-emits them as `<div>`s. In memory, HTML only. Placed after the
/// notebox import so `html-align` is in scope; without the import (not an
/// InkyCap note) the source is left alone.
pub fn inject_html_align_shim(source: &str) -> String {
    const RULE: &str = "#show align: html-align";

    let mut out = String::with_capacity(source.len() + RULE.len() + 2);
    let mut injected = false;
    for line in source.lines() {
        out.push_str(line);
        out.push('\n');
        if !injected && crate::notebox_package::is_notebox_import_line(line) {
            out.push_str(RULE);
            out.push('\n');
            injected = true;
        }
    }
    if !injected {
        return source.to_string();
    }
    out
}

fn build_injection_block(
    defaults_rules: Option<&str>,
    collection_rules: Option<&str>,
    custom_typst: Option<&str>,
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
    // The collection's custom Typst comes last so it overrides the generated
    // rules. Templates are imported before this in the other export paths; the
    // book path adds custom Typst after its `#show: template` (see
    // book_wrapper::build_book_source).
    if let Some(custom) = custom_typst {
        if !custom.trim().is_empty() {
            parts.push(custom.to_string());
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
        let rules = build_defaults_show_call(&doc, None, "");
        assert!(rules.is_empty());
    }

    #[test]
    fn font_and_page_size_emit_hybrid_rules() {
        let doc = DocumentDefaults {
            text_size: Some(12.0),
            page_size: Some("us-letter".to_string()),
        };
        let rules = build_defaults_show_call(&doc, Some("Inter"), "");
        // Page geometry: direct #set rule
        assert!(rules.contains("#set page(paper: \"us-letter\")"));
        // Text settings: delegated to lib.typ
        assert!(rules.contains("#show: apply-notebox-defaults.with("));
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
            None,
            "\"Adwaita Mono\", \"Ubuntu Mono\", \"Fira Mono\", monospace",
        );
        assert!(
            rules.contains("monospace-font: (\"Adwaita Mono\", \"Ubuntu Mono\", \"Fira Mono\")")
        );
    }

    #[test]
    fn monospace_single_family_emits_string_arg() {
        let doc = DocumentDefaults::default();
        let rules = build_defaults_show_call(&doc, None, "Adwaita Mono");
        assert!(rules.contains("monospace-font: \"Adwaita Mono\""));
    }

    #[test]
    fn parse_font_stack_strips_generic_keywords() {
        let families = parse_font_stack("\"JetBrains Mono\", Consolas, monospace");
        assert_eq!(families, vec!["JetBrains Mono", "Consolas"]);
    }

    #[test]
    fn inject_after_import() {
        let source = r#"#import "/.inkycap/notebox.typ": *

= Hello
"#;
        let result = inject_style_rules(
            source,
            Some("#show: apply-notebox-defaults.with(text-font: \"Inter\")"),
            None,
            None,
        );
        let import_pos = result.find("/.inkycap/notebox.typ").unwrap();
        let show_pos = result.find("#show: apply-notebox-defaults").unwrap();
        assert!(show_pos > import_pos);
    }

    #[test]
    fn collection_overrides_after_defaults() {
        let source = "#import \"/.inkycap/notebox.typ\": *\n\n= Hello\n";
        let result = inject_style_rules(
            source,
            Some("#show: apply-notebox-defaults.with(page-paper: \"a4\")"),
            Some("#show: apply-collection-style.with(page-args: (paper: \"us-letter\"))"),
            None,
        );
        let defaults_pos = result.find("apply-notebox-defaults").unwrap();
        let collection_pos = result.find("apply-collection-style").unwrap();
        assert!(collection_pos > defaults_pos);
    }

    #[test]
    fn custom_typst_injected_after_collection_rules() {
        let source = "#import \"/.inkycap/notebox.typ\": *\n\n= Hello\n";
        let result = inject_style_rules(
            source,
            Some("#show: apply-notebox-defaults.with(page-paper: \"a4\")"),
            Some("#show: apply-collection-style.with(par-args: (justify: true))"),
            Some("#show heading.where(level: 1): set text(navy)"),
        );
        let collection_pos = result.find("apply-collection-style").unwrap();
        let custom_pos = result.find("set text(navy)").unwrap();
        // Custom Typst must come after the generated collection rules so it wins.
        assert!(custom_pos > collection_pos);
    }

    /// A note compiles with both `#set page(...)` and `#show:
    /// apply-notebox-defaults.with(...)` taking effect.
    #[test]
    fn hybrid_injection_changes_page_size_and_text() {
        use crate::storage::path::canonicalize_root;
        use crate::typst_pipeline::compiler::TypstCompiler;
        use std::fs;
        use tempfile::tempdir;

        let dir = tempdir().expect("tempdir");
        let root = canonicalize_root(dir.path()).expect("canonicalize");
        crate::notebox_package::scaffold(&root);
        let note_path = root.join("note.typ");

        let doc = DocumentDefaults {
            text_size: Some(12.0),
            page_size: Some("us-letter".to_string()),
        };
        let rules = build_defaults_show_call(&doc, Some("Linux Libertine"), "");

        let source = format!(
            "{}\n{}\n\n= Hello\n\nBody text.\n",
            crate::notebox_package::import_line(),
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
        // Page geometry: direct #set rule. Numbering patterns are quoted.
        assert!(rules.contains("#set page(paper: \"us-letter\", columns: 2, numbering: \"1\")"));
        // Text/par: delegated to lib.typ
        assert!(rules.contains("#show: apply-collection-style.with("));
        assert!(rules.contains(
            "text-args: (font: \"Times New Roman\", size: 12pt, lang: \"fr\", region: \"CA\")"
        ));
        assert!(rules.contains("par-args: (justify: true)"));
    }

    #[test]
    fn numbering_none_emits_bare_keyword() {
        // The "None" preset must suppress numbering via Typst's `none` keyword,
        // not the literal pattern string "none" (which would print the word).
        let style = CollectionStyle {
            page: Some(crate::collection_parser::model::PageStyle {
                paper: None,
                margin: None,
                columns: None,
                numbering: Some("none".to_string()),
            }),
            text: None,
            paragraph: None,
            heading: Some(crate::collection_parser::model::HeadingStyle {
                numbering: Some("none".to_string()),
            }),
        };
        let rules = style.to_typst_show_call();
        assert!(rules.contains("numbering: none"));
        assert!(!rules.contains("numbering: \"none\""));
        assert!(rules.contains("heading-args: (numbering: none)"));
    }
}
