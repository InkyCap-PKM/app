//! Adding, moving and removing a note's package imports, for the Properties
//! pane's Packages section, the `/` menu and the fix offered by a name-clash
//! warning.
//!
//! Every note's header imports the notebox package, and a later `*` import
//! wins where two offer the same name (see [`super::package_imports`]). So
//! InkyCap writes a package's `*` import *above* the notebox import, where it
//! can't replace InkyCap's `note`, `task` and the rest. The user can't type
//! there in the editor (the notebox import is locked), which is why these edits
//! exist.
//!
//! Imports are found with Typst's parser ([`package_imports`]); the rest is
//! slicing the source at those ranges.

use std::collections::HashSet;
use std::ops::Range;

use crate::notebox_package::add_import_above_notebox_import;
use crate::typst_packages::PackageSpec;
use crate::typst_pipeline::package_imports::{package_imports, PackageImport};
use crate::typst_pipeline::template_setup::applied_rules;

fn canonical(spec: &str) -> Option<String> {
    PackageSpec::parse(spec).map(|p| p.canonical())
}

fn imports_of(source: &str, spec: &str) -> Vec<PackageImport> {
    let Some(wanted) = canonical(spec) else {
        return Vec::new();
    };
    package_imports(source)
        .into_iter()
        .filter(|i| canonical(&i.spec).as_deref() == Some(wanted.as_str()))
        .collect()
}

/// `source` importing everything from `spec`, above the notebox import. Unchanged
/// if it already imports `spec` in any form, or `spec` is malformed.
pub fn add_package(source: &str, spec: &str) -> String {
    let Some(spec) = canonical(spec) else {
        return source.to_string();
    };
    if !imports_of(source, &spec).is_empty() {
        return source.to_string();
    }
    add_import_above_notebox_import(source, &spec)
}

/// `source` with each `*` import of `spec` that replaces the notebox `names`
/// moved above the notebox import. Where it was, the clashing names are
/// imported under the package's name (`note as example-notes-note`), so they stay
/// usable without replacing InkyCap's.
pub fn fix_clashing_import(source: &str, spec: &str, names: &[String]) -> String {
    let Some(parsed) = PackageSpec::parse(spec) else {
        return source.to_string();
    };
    let spec = parsed.canonical();
    let Some(notebox_at) = notebox_import_start(source) else {
        return source.to_string();
    };
    let below: Vec<PackageImport> = imports_of(source, &spec)
        .into_iter()
        .filter(|i| i.wildcard && i.range.start > notebox_at)
        .collect();
    if below.is_empty() {
        return source.to_string();
    }

    let renamed = if names.is_empty() {
        None
    } else {
        let items = names
            .iter()
            .map(|n| format!("{n} as {}-{n}", parsed.name))
            .collect::<Vec<_>>()
            .join(", ");
        Some(format!("#import \"{spec}\": {items}"))
    };
    let mut out = String::with_capacity(source.len());
    let mut cursor = 0;
    for (index, import) in below.iter().enumerate() {
        match (&renamed, index) {
            (Some(line), 0) => {
                out.push_str(&source[cursor..import.range.start]);
                out.push_str(line);
                cursor = import.range.end;
            }
            _ => {
                let line = line_extent(source, import.range.clone());
                out.push_str(&source[cursor..line.start]);
                cursor = line.end;
            }
        }
    }
    out.push_str(&source[cursor..]);
    add_import_above_notebox_import(&out, &spec)
}

/// `source` without its imports of `spec`, and without the whole-document
/// `#show:` rules applying one of `names` (the package's exports), which would
/// fail once the import is gone. Lines left empty are removed.
pub fn remove_package(source: &str, spec: &str, names: &HashSet<String>) -> String {
    let mut ranges: Vec<Range<usize>> = imports_of(source, spec)
        .into_iter()
        .map(|i| line_extent(source, i.range))
        .collect();
    let mut bound: HashSet<String> = names.clone();
    for import in imports_of(source, spec) {
        bound.extend(import.bound);
    }
    ranges.extend(
        applied_rules(source)
            .into_iter()
            .filter(|r| bound.contains(&r.name))
            .map(|r| line_extent(source, r.range)),
    );
    if ranges.is_empty() {
        return source.to_string();
    }
    ranges.sort_by_key(|r| r.start);
    let mut out = String::with_capacity(source.len());
    let mut cursor = 0;
    for range in ranges {
        if range.start < cursor {
            continue;
        }
        out.push_str(&source[cursor..range.start]);
        cursor = range.end;
    }
    out.push_str(&source[cursor..]);
    out
}

/// `source` without any of its top-level package imports, lines left empty
/// removed. For merged documents, whose imports are gathered at the top.
pub fn without_package_imports(source: &str) -> String {
    let mut out = String::with_capacity(source.len());
    let mut cursor = 0;
    for import in package_imports(source) {
        let range = line_extent(source, import.range);
        if range.start < cursor {
            continue;
        }
        out.push_str(&source[cursor..range.start]);
        cursor = range.end;
    }
    out.push_str(&source[cursor..]);
    out
}

/// Where the notebox import starts, or `None` without one.
fn notebox_import_start(source: &str) -> Option<usize> {
    let mut offset = 0;
    for line in source.split_inclusive('\n') {
        if crate::notebox_package::is_notebox_import_line(line.trim_end_matches(['\n', '\r'])) {
            return Some(offset);
        }
        offset += line.len();
    }
    None
}

/// `range` widened to its whole lines, line break included, when nothing else
/// shares them; otherwise `range` itself.
fn line_extent(source: &str, range: Range<usize>) -> Range<usize> {
    let line_start = source[..range.start].rfind('\n').map_or(0, |i| i + 1);
    let rest = &source[range.end..];
    let line_end = rest.find('\n').map_or(source.len(), |i| range.end + i + 1);
    let before_blank = source[line_start..range.start].trim().is_empty();
    let after_blank = source[range.end..line_end].trim().is_empty();
    if before_blank && after_blank {
        line_start..line_end
    } else {
        range
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    const NOTEBOX: &str = "#import \"/.inkycap/notebox.typ\": *";

    #[test]
    fn adds_above_the_notebox_import_once() {
        let src = format!("{NOTEBOX}\n#note()\nBody\n");
        let added = add_package(&src, "@preview/example-drawing:1.0.0");
        assert_eq!(
            added,
            format!("#import \"@preview/example-drawing:1.0.0\": *\n{NOTEBOX}\n#note()\nBody\n")
        );
        assert_eq!(add_package(&added, "@preview/example-drawing:1.0.0"), added);
        let named = format!("{NOTEBOX}\n#import \"@preview/example-drawing:1.0.0\": part\n");
        assert_eq!(add_package(&named, "@preview/example-drawing:1.0.0"), named);
    }

    #[test]
    fn moves_a_clashing_import_up_and_keeps_its_names_under_new_ones() {
        let src = format!(
            "{NOTEBOX}\n#note()\nIntro\n#import \"@preview/example-notes:1.0.0\": *\nText #example-notes-note[x]\n"
        );
        let fixed = fix_clashing_import(&src, "@preview/example-notes:1.0.0", &["note".into()]);
        assert_eq!(
            fixed,
            format!(
                "#import \"@preview/example-notes:1.0.0\": *\n{NOTEBOX}\n#note()\nIntro\n\
                 #import \"@preview/example-notes:1.0.0\": note as example-notes-note\nText #example-notes-note[x]\n"
            )
        );
        assert_eq!(
            fix_clashing_import(&fixed, "@preview/example-notes:1.0.0", &["note".into()]),
            fixed,
            "nothing left below to move"
        );
    }

    #[test]
    fn removes_imports_and_the_rules_that_need_them() {
        let src = format!(
            "#import \"@preview/example-letter:1.0.0\": *\n{NOTEBOX}\n#show: letter.with(\n  title: [T],\n)\n\
             #note()\nBody #import \"@preview/example-letter:1.0.0\": sign\nEnd\n"
        );
        let names: HashSet<String> = ["letter".to_string()].into();
        let out = remove_package(&src, "@preview/example-letter:1.0.0", &names);
        assert_eq!(out, format!("{NOTEBOX}\n#note()\nBody \nEnd\n"));
    }

    #[test]
    fn leaves_other_packages_alone() {
        let src = format!("#import \"@preview/a:1.0.0\": *\n{NOTEBOX}\n#note()\n");
        assert_eq!(
            remove_package(&src, "@preview/b:1.0.0", &HashSet::new()),
            src
        );
    }
}
