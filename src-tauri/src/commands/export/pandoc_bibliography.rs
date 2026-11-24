//! Bibliography layout in Word and ODT files made with Pandoc.
//!
//! Typst formats the entries; what Pandoc loses is their layout on the page. The
//! filter in `pandoc_bibliography.lua` puts each entry in a paragraph styled
//! "Bibliography", and [`BibliographyLayout`] gives that style its indent.
//!
//! Per CLAUDE.md's Typst-first principle: Typst's layout of a bibliography exists
//! only in its paged output, its HTML carries just a `hanging-indent` class, and
//! Pandoc reads no indents from HTML, so the indent has to be set in the
//! finished file.

use std::sync::LazyLock;

use regex::Regex;

/// Pandoc filter that lays out bibliography entries as paragraphs.
pub(super) const LUA_FILTER: &str = include_str!("pandoc_bibliography.lua");

/// Text size the indents are worked out for, in points: the default of Pandoc's
/// Word and ODT files.
const TEXT_SIZE: f32 = 12.0;
/// Hanging indent of unlabelled entries, as in Typst's PDF output.
const HANGING_INDENT_EM: f32 = 1.5;
/// Gap between an entry's label and its text, as in Typst's PDF output.
const LABEL_GAP_EM: f32 = 0.65;
/// Typical width of one label character (digits, brackets, full stop).
const LABEL_CHAR_EM: f32 = 0.5;

static SECTION: LazyLock<Regex> = LazyLock::new(|| {
    Regex::new(r#"(?s)<section role="doc-bibliography"([^>]*)>(.*?)</section>"#)
        .expect("static regex")
});
static LABEL: LazyLock<Regex> = LazyLock::new(|| {
    Regex::new(r#"(?s)<span class="prefix">(?:<a\b[^>]*>(.*?)</a>|(.*?)</span>)"#)
        .expect("static regex")
});
static TAG_OR_SPACE: LazyLock<Regex> =
    LazyLock::new(|| Regex::new(r"<[^>]*>|&#x20;|\s").expect("static regex"));
static ENTITY: LazyLock<Regex> = LazyLock::new(|| Regex::new(r"&[#\w]+;").expect("static regex"));
static DOCX_STYLE: LazyLock<Regex> = LazyLock::new(|| {
    Regex::new(r#"(?s)<w:style\b[^>]*\bw:styleId="Bibliography"[^>]*>.*?</w:style>"#)
        .expect("static regex")
});
static DOCX_PARAGRAPH_PROPERTIES: LazyLock<Regex> =
    LazyLock::new(|| Regex::new(r"(?s)<w:pPr\s*/>|<w:pPr>(.*?)</w:pPr>").expect("static regex"));
/// The paragraph properties Word requires to come after `w:ind`.
static DOCX_AFTER_INDENT: LazyLock<Regex> = LazyLock::new(|| {
    Regex::new(
        r"<w:(contextualSpacing|mirrorIndents|suppressOverlap|jc|textDirection|textAlignment|textboxTightWrap|outlineLvl|divId|cnfStyle|rPr|sectPr|pPrChange)\b",
    )
    .expect("static regex")
});

/// How far an entry's lines after the first are indented, in points; zero when
/// the citation style has neither labels nor a hanging indent.
#[derive(Debug, Clone, Copy, PartialEq)]
pub(super) struct BibliographyLayout {
    indent: f32,
}

impl BibliographyLayout {
    /// The layout of the bibliography in Typst's HTML, or `None` without one. A
    /// note with several bibliographies gets the widest indent among them, since
    /// they share the style.
    pub(super) fn from_html(html: &str) -> Option<Self> {
        SECTION
            .captures_iter(html)
            .map(|section| {
                let label_chars = LABEL
                    .captures_iter(&section[2])
                    .map(|label| {
                        let text = label.get(1).or(label.get(2));
                        label_length(text.map_or("", |m| m.as_str()))
                    })
                    .max();
                let em = match label_chars {
                    Some(chars) => chars as f32 * LABEL_CHAR_EM + LABEL_GAP_EM,
                    None if section[1].contains("hanging-indent") => HANGING_INDENT_EM,
                    None => 0.0,
                };
                em * TEXT_SIZE
            })
            .reduce(f32::max)
            .map(|indent| Self { indent })
    }

    /// Set the indent of the "Bibliography" style in a DOCX `word/styles.xml`.
    /// A style that already has an indent, which comes from the user's own Pandoc
    /// reference document, is left alone.
    pub(super) fn apply_to_docx_styles(self, xml: &str) -> String {
        let Some(style) = DOCX_STYLE.find(xml) else {
            return xml.to_string();
        };
        if self.indent == 0.0 || style.as_str().contains("<w:ind ") {
            return xml.to_string();
        }
        // Word measures in twentieths of a point.
        let twips = (self.indent * 20.0).round();
        let indent = format!(r#"<w:ind w:left="{twips}" w:hanging="{twips}" />"#);

        let edited = match DOCX_PARAGRAPH_PROPERTIES.captures(style.as_str()) {
            Some(found) => {
                let mut properties = found
                    .get(1)
                    .map(|m| m.as_str().to_string())
                    .unwrap_or_default();
                let at = DOCX_AFTER_INDENT
                    .find(&properties)
                    .map_or(properties.len(), |m| m.start());
                properties.insert_str(at, &indent);
                style
                    .as_str()
                    .replacen(&found[0], &format!("<w:pPr>{properties}</w:pPr>"), 1)
            }
            None => {
                // `w:pPr` comes before `w:rPr`, otherwise last.
                let text = style.as_str();
                let at = text
                    .find("<w:rPr")
                    .or_else(|| text.find("</w:style>"))
                    .unwrap_or(text.len());
                format!("{}<w:pPr>{indent}</w:pPr>{}", &text[..at], &text[at..])
            }
        };
        format!("{}{edited}{}", &xml[..style.start()], &xml[style.end()..])
    }

    /// Add the "Bibliography" style to an ODT `styles.xml`. One that is already
    /// there, from the user's own Pandoc reference document, is left alone.
    pub(super) fn apply_to_odt_styles(self, xml: &str) -> String {
        const CLOSING: &str = "</office:styles>";
        let Some(at) = xml.find(CLOSING) else {
            return xml.to_string();
        };
        if xml.contains(r#"style:name="Bibliography""#) {
            return xml.to_string();
        }
        let indent = self.indent;
        let style = format!(
            r#"<style:style style:name="Bibliography" style:family="paragraph" style:parent-style-name="Text_20_body" style:class="index"><style:paragraph-properties fo:margin-left="{indent:.1}pt" fo:margin-right="0pt" fo:text-indent="-{indent:.1}pt" style:auto-text-indent="false"><style:tab-stops /></style:paragraph-properties></style:style>"#
        );
        format!("{}{style}{}", &xml[..at], &xml[at..])
    }
}

/// How many characters a label shows, from its HTML.
fn label_length(html: &str) -> usize {
    let text = TAG_OR_SPACE.replace_all(html, "");
    ENTITY.replace_all(&text, "x").chars().count()
}

#[cfg(test)]
mod tests {
    use super::*;

    const HANGING: &str = r##"<section role="doc-bibliography" class="hanging-indent"><h2>References</h2><ul><li>Otlet, P.</li></ul></section>"##;
    const LABELLED: &str = r##"<section role="doc-bibliography"><ul><li><span class="prefix"><a href="#loc-1" role="doc-backlink">[10]<span style="white-space: pre-wrap">&#x20;</span></a></span> Otlet</li><li><span class="prefix">[9]</span> Bush</li></ul></section>"##;

    #[test]
    fn layout_follows_the_citation_style() {
        let indent = |html| BibliographyLayout::from_html(html).map(|l| l.indent);
        assert_eq!(indent("<p>No references</p>"), None);
        assert_eq!(indent(HANGING), Some(18.0));
        // Four label characters plus the gap.
        assert_eq!(indent(LABELLED), Some((4.0 * 0.5 + 0.65) * 12.0));
        assert_eq!(
            indent(r#"<section role="doc-bibliography"><ul><li>A</li></ul></section>"#),
            Some(0.0)
        );
    }

    #[test]
    fn labels_elsewhere_in_the_note_do_not_count() {
        let html = format!(r#"<nav><span class="prefix">1.2.3.4.5</span></nav>{HANGING}"#);
        assert_eq!(
            BibliographyLayout::from_html(&html),
            Some(BibliographyLayout { indent: 18.0 })
        );
    }

    #[test]
    fn a_label_is_measured_past_a_leading_space() {
        let html = r##"<section role="doc-bibliography"><ul><li><span class="prefix"><a href="#loc-1"><span style="white-space: pre-wrap">&#x20;</span>1945</a></span> Bush</li></ul></section>"##;
        assert_eq!(
            BibliographyLayout::from_html(html).map(|l| l.indent),
            Some((4.0 * 0.5 + 0.65) * 12.0)
        );
    }

    #[test]
    fn docx_style_gets_the_indent() {
        let layout = BibliographyLayout { indent: 18.0 };
        let style = |inner: &str| {
            format!(
                r#"<w:style w:styleId="Other"><w:pPr /></w:style><w:style w:type="paragraph" w:styleId="Bibliography">{inner}</w:style>"#
            )
        };
        let ind = r#"<w:ind w:left="360" w:hanging="360" />"#;
        for (before, after) in [
            (
                "<w:pPr /><w:rPr />",
                format!("<w:pPr>{ind}</w:pPr><w:rPr />"),
            ),
            (
                r#"<w:pPr><w:keepLines /><w:jc w:val="left" /></w:pPr>"#,
                format!(r#"<w:pPr><w:keepLines />{ind}<w:jc w:val="left" /></w:pPr>"#),
            ),
            ("<w:rPr />", format!("<w:pPr>{ind}</w:pPr><w:rPr />")),
            ("", format!("<w:pPr>{ind}</w:pPr>")),
        ] {
            assert_eq!(layout.apply_to_docx_styles(&style(before)), style(&after));
        }
        let own = style(r#"<w:pPr><w:ind w:left="720" w:hanging="720" /></w:pPr>"#);
        assert_eq!(layout.apply_to_docx_styles(&own), own);
        let none = BibliographyLayout { indent: 0.0 };
        assert_eq!(
            none.apply_to_docx_styles(&style("<w:pPr />")),
            style("<w:pPr />")
        );
    }

    #[test]
    fn odt_style_is_added_once() {
        let layout = BibliographyLayout { indent: 18.0 };
        let xml = layout.apply_to_odt_styles("<office:styles></office:styles>");
        assert!(xml.contains(r#"fo:margin-left="18.0pt""#), "{xml}");
        assert!(xml.contains(r#"fo:text-indent="-18.0pt""#), "{xml}");
        assert_eq!(layout.apply_to_odt_styles(&xml), xml);
    }
}
