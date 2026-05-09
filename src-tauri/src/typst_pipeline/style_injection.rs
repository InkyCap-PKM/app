//! Build and inject `#set` rules from app-level document defaults and
//! collection-level style overrides into Typst source before compilation.
//!
//! Injection order (after the inkycap-vault `#import` line):
//!
//! 1. App document defaults (`#set text(...)`, `#set page(...)`)
//! 2. Collection style overrides (full set of `#set` rules)
//! 3. Template import (if any) — template's own `#set` rules override 1 & 2
//!
//! The user's own `#set` rules in the document body come after all injections
//! and naturally win via Typst's cascading semantics.

use crate::settings::DocumentDefaults;

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

/// Build `#set` rules from the app-level document defaults.
///
/// `monospace_font` is the user's editor monospace stack (from
/// `appearance.monospace_font`); when non-empty it becomes the default font
/// for `#raw` (code) elements so reading mode mirrors what the user sees in
/// the visual editor. Per-collection or per-note `#show raw: set text(...)`
/// rules later in the document still win via Typst's cascade.
pub fn build_defaults_rules(doc: &DocumentDefaults, monospace_font: &str) -> String {
    let mut rules = Vec::new();

    let mut text_args = Vec::new();
    if let Some(ref font) = doc.text_font {
        if !font.is_empty() {
            text_args.push(format!("font: \"{}\"", sanitize_typst_string(font)));
        }
    }
    if let Some(size) = doc.text_size {
        text_args.push(format!("size: {}pt", size));
    }
    if !text_args.is_empty() {
        rules.push(format!("#set text({})", text_args.join(", ")));
    }

    if let Some(ref paper) = doc.page_size {
        if !paper.is_empty() {
            rules.push(format!("#set page(paper: \"{}\")", sanitize_typst_string(paper)));
        }
    }

    let mono_families = parse_font_stack(monospace_font);
    if let Some(value) = format_font_value(&mono_families) {
        rules.push(format!("#show raw: set text(font: {})", value));
    }

    rules.join("\n")
}

/// Inject style rules into the source after the inkycap-vault import line.
///
/// `defaults_rules`: from `build_defaults_rules()` (app-level)
/// `collection_rules`: from `CollectionStyle::to_typst_set_rules()` (collection-level)
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
        let rules = build_defaults_rules(&doc, "");
        assert!(rules.is_empty());
    }

    #[test]
    fn font_and_page_size_rules() {
        let doc = DocumentDefaults {
            text_font: Some("Inter".to_string()),
            text_size: Some(12.0),
            page_size: Some("us-letter".to_string()),
        };
        let rules = build_defaults_rules(&doc, "");
        assert!(rules.contains("#set text(font: \"Inter\", size: 12pt)"));
        assert!(rules.contains("#set page(paper: \"us-letter\")"));
    }

    #[test]
    fn monospace_stack_emits_show_raw_rule() {
        let doc = DocumentDefaults::default();
        let rules = build_defaults_rules(
            &doc,
            "\"Adwaita Mono\", \"Ubuntu Mono\", \"Fira Mono\", monospace",
        );
        assert!(rules.contains(
            "#show raw: set text(font: (\"Adwaita Mono\", \"Ubuntu Mono\", \"Fira Mono\"))"
        ));
    }

    #[test]
    fn monospace_single_family_emits_string_value() {
        let doc = DocumentDefaults::default();
        let rules = build_defaults_rules(&doc, "Adwaita Mono");
        assert!(rules.contains("#show raw: set text(font: \"Adwaita Mono\")"));
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
            Some("#set text(font: \"Inter\")"),
            None,
        );
        assert!(result.contains("inkycap-vault"));
        let import_pos = result.find("inkycap-vault").unwrap();
        let set_pos = result.find("#set text(font: \"Inter\")").unwrap();
        assert!(set_pos > import_pos);
    }

    #[test]
    fn collection_overrides_after_defaults() {
        let source = "#import \"/.inkycap/packages/inkycap-vault/0.1.0/lib.typ\": *\n\n= Hello\n";
        let result = inject_style_rules(
            source,
            Some("#set page(paper: \"a4\")"),
            Some("#set page(paper: \"us-letter\")\n#set par(justify: true)"),
        );
        let defaults_pos = result.find("#set page(paper: \"a4\")").unwrap();
        let collection_pos = result.find("#set page(paper: \"us-letter\")").unwrap();
        assert!(collection_pos > defaults_pos);
    }

    #[test]
    fn collection_style_to_rules() {
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
        let rules = style.to_typst_set_rules();
        assert!(rules.contains("#set page(paper: \"us-letter\", columns: 2, numbering: \"1\")"));
        assert!(rules.contains("#set text(font: \"Times New Roman\", size: 12pt, lang: \"fr\", region: \"CA\")"));
        assert!(rules.contains("#set par(justify: true)"));
    }
}
