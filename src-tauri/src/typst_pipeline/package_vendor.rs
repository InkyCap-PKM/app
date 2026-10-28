//! Copy the Typst packages a notebox uses into `<notebox>/.inkycap/packages/`,
//! so the notebox is self-contained when shared (collaboration export).
//!
//! Packages normally live in the shared Typst cache (`@preview`) or the user's
//! data folder (`@local`), neither of which travels with the notebox. With
//! "include packages" chosen on export, every package the notebox imports, with
//! its dependencies, is copied into the notebox's own package folder, which the
//! resolver checks first. Recipients then compile the same way, and for
//! `@local` packages, which can't be downloaded, it's the only way. The default
//! remains downloading into the shared cache on demand (see
//! [`super::package_fetch`]).
//!
//! Imports are found by parsing `#import "@ns/name:ver"` with Typst's syntax
//! tree, not by compiling, so notes with unrelated compile errors don't matter.
//! Each copied package is scanned in turn, so dependencies of dependencies are
//! included.

use std::collections::HashSet;
use std::path::Path;

use typst::syntax::package::PackageSpec;
use typst::syntax::{ast, parse, LinkedNode, SyntaxKind};
use walkdir::WalkDir;

use crate::errors::{InkyCapError, Result};
use crate::typst_packages::{copy_dir_all, locate_package_dir};

/// What [`vendor_notebox_packages`] did, for surfacing in the export UI.
#[derive(Debug, Default, Clone)]
pub struct VendorReport {
    /// Canonical specs (`@ns/name:ver`) newly copied into the notebox.
    pub vendored: Vec<String>,
    /// Imported specs not found locally (notebox, Typst data folder or cache),
    /// e.g. an uninstalled `@local` package. The export dialog warns that
    /// recipients may not be able to compile.
    pub unresolved: Vec<String>,
}

/// The package specs imported by one Typst source. Path imports (`#import
/// "/.inkycap/notebox.typ"`) aren't package specs and are skipped.
pub fn collect_package_imports(source: &str) -> HashSet<PackageSpec> {
    let root = parse(source);
    let mut out = HashSet::new();
    collect_from_node(&LinkedNode::new(&root), &mut out);
    out
}

fn collect_from_node(node: &LinkedNode, out: &mut HashSet<PackageSpec>) {
    if node.kind() == SyntaxKind::ModuleImport {
        // The import source is the first string literal under the node; parse
        // it here so the borrow stays local.
        for child in node.children() {
            if let Some(s) = child.cast::<ast::Str>() {
                if let Ok(spec) = s.get().parse::<PackageSpec>() {
                    out.insert(spec);
                }
                break;
            }
        }
    }
    for child in node.children() {
        collect_from_node(&child, out);
    }
}

/// Notebox-relative paths of the notes importing `canonical_spec`
/// (`@ns/name:version`, exact version: `:0.2.0` doesn't match `:0.3.0`). Uses
/// the same syntax-tree import detection as vendoring, so commented-out or
/// quoted mentions don't count. The package uninstall confirmation uses it to
/// list notes that would stop compiling.
pub fn notes_importing(notebox_root: &Path, canonical_spec: &str) -> Vec<String> {
    notebox_typ_files(notebox_root)
        .into_iter()
        .filter_map(|p| {
            let src = std::fs::read_to_string(&p).ok()?;
            if collect_package_imports(&src)
                .iter()
                .any(|s| s.to_string() == canonical_spec)
            {
                let rel = p.strip_prefix(notebox_root).unwrap_or(&p);
                Some(crate::storage::to_frontend_string(rel))
            } else {
                None
            }
        })
        .collect()
}

/// Copy every package the notebox imports, with dependencies, into
/// `<notebox>/.inkycap/packages/`. A package already there is left as is (but
/// still scanned for dependencies). Returns what was copied and what couldn't
/// be found.
pub fn vendor_notebox_packages(notebox_root: &Path) -> Result<VendorReport> {
    let mut report = VendorReport::default();
    let mut seen: HashSet<PackageSpec> = HashSet::new();
    let mut queue: Vec<PackageSpec> = Vec::new();

    // Start from every note. `.inkycap/` is skipped: `notebox.typ` imports
    // nothing external, and copied packages are reached through the dependency
    // scan.
    for typ in notebox_typ_files(notebox_root) {
        if let Ok(src) = std::fs::read_to_string(&typ) {
            enqueue_new(collect_package_imports(&src), &mut seen, &mut queue);
        }
    }

    while let Some(spec) = queue.pop() {
        let dest = notebox_root
            .join(".inkycap")
            .join("packages")
            .join(spec.namespace.as_str())
            .join(spec.name.as_str())
            .join(spec.version.to_string());

        // Determine the directory whose sources we'll scan for transitive
        // deps: the existing vendored copy, or a freshly-copied one.
        let scan_dir = if dest.is_dir() {
            dest
        } else {
            match locate_package_dir(
                notebox_root,
                spec.namespace.as_str(),
                spec.name.as_str(),
                &spec.version.to_string(),
            ) {
                Some(src_dir) => {
                    copy_dir_all(&src_dir, &dest).map_err(InkyCapError::Io)?;
                    report.vendored.push(spec.to_string());
                    dest
                }
                None => {
                    report.unresolved.push(spec.to_string());
                    continue;
                }
            }
        };

        // Pull in the package's own package dependencies.
        for typ in package_typ_files(&scan_dir) {
            if let Ok(src) = std::fs::read_to_string(&typ) {
                enqueue_new(collect_package_imports(&src), &mut seen, &mut queue);
            }
        }
    }

    Ok(report)
}

/// The packages the package in `pkg_dir` imports, directly or through other
/// packages, as canonical specs (`@ns/name:version`). A dependency that isn't
/// available locally is listed, but its own imports can't be followed.
pub fn package_dependencies(notebox_root: &Path, pkg_dir: &Path) -> HashSet<String> {
    let mut seen: HashSet<PackageSpec> = HashSet::new();
    let mut queue: Vec<PackageSpec> = Vec::new();
    for typ in package_typ_files(pkg_dir) {
        if let Ok(src) = std::fs::read_to_string(&typ) {
            enqueue_new(collect_package_imports(&src), &mut seen, &mut queue);
        }
    }
    while let Some(spec) = queue.pop() {
        let Some(dir) = locate_package_dir(
            notebox_root,
            spec.namespace.as_str(),
            spec.name.as_str(),
            &spec.version.to_string(),
        ) else {
            continue;
        };
        for typ in package_typ_files(&dir) {
            if let Ok(src) = std::fs::read_to_string(&typ) {
                enqueue_new(collect_package_imports(&src), &mut seen, &mut queue);
            }
        }
    }
    seen.iter().map(|s| s.to_string()).collect()
}

fn enqueue_new(
    specs: HashSet<PackageSpec>,
    seen: &mut HashSet<PackageSpec>,
    queue: &mut Vec<PackageSpec>,
) {
    for spec in specs {
        if seen.insert(spec.clone()) {
            queue.push(spec);
        }
    }
}

/// All `.typ` notes in the notebox, excluding the reserved `.inkycap/` tree.
fn notebox_typ_files(notebox_root: &Path) -> Vec<std::path::PathBuf> {
    WalkDir::new(notebox_root)
        .into_iter()
        .filter_entry(|e| e.file_name() != ".inkycap")
        .filter_map(|e| e.ok())
        .filter(|e| e.file_type().is_file() && has_typ_ext(e.path()))
        .map(|e| e.into_path())
        .collect()
}

/// All `.typ` files within a single package directory.
fn package_typ_files(pkg_dir: &Path) -> Vec<std::path::PathBuf> {
    WalkDir::new(pkg_dir)
        .into_iter()
        .filter_map(|e| e.ok())
        .filter(|e| e.file_type().is_file() && has_typ_ext(e.path()))
        .map(|e| e.into_path())
        .collect()
}

fn has_typ_ext(path: &Path) -> bool {
    path.extension()
        .is_some_and(|ext| ext.eq_ignore_ascii_case("typ"))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn notes_importing_matches_exact_version_only() {
        let tmp = tempfile::tempdir().unwrap();
        let root = tmp.path();
        std::fs::write(
            root.join("uses-cetz.typ"),
            "#import \"@preview/cetz:0.2.0\": *\n= Diagram",
        )
        .unwrap();
        // Different version of the same package — must NOT match.
        std::fs::write(
            root.join("uses-other-version.typ"),
            "#import \"@preview/cetz:0.3.0\": *\n= Other",
        )
        .unwrap();
        std::fs::write(root.join("plain.typ"), "= No imports").unwrap();
        // Reserved tree is skipped, so a vendored copy of the package doesn't
        // count as a dependent note.
        let vendored = root.join(".inkycap/packages/preview/cetz/0.2.0");
        std::fs::create_dir_all(&vendored).unwrap();
        std::fs::write(
            vendored.join("lib.typ"),
            "#import \"@preview/cetz:0.2.0\": *",
        )
        .unwrap();

        let deps = notes_importing(root, "@preview/cetz:0.2.0");
        assert_eq!(deps.len(), 1, "got {deps:?}");
        assert!(deps[0].ends_with("uses-cetz.typ"), "got {deps:?}");
    }

    #[test]
    fn collects_package_imports_and_ignores_relative() {
        let src = r#"#import "/.inkycap/notebox.typ": *
#import "@preview/lilaq:0.6.0" as lq
#import "@local/mylib:0.1.0"
#import "./relative.typ": x
= Heading"#;
        let specs: Vec<String> = collect_package_imports(src)
            .into_iter()
            .map(|s| s.to_string())
            .collect();
        assert!(specs.contains(&"@preview/lilaq:0.6.0".to_string()));
        assert!(specs.contains(&"@local/mylib:0.1.0".to_string()));
        // Notebox + relative imports are not package specs.
        assert_eq!(specs.len(), 2, "got {specs:?}");
    }

    #[test]
    fn vendors_used_package_into_notebox() {
        let tmp = tempfile::tempdir().unwrap();
        let root = tmp.path();
        // A note that imports a package.
        std::fs::write(
            root.join("note.typ"),
            "#import \"@preview/foo:1.0.0\": *\n= Hi",
        )
        .unwrap();
        // Place the package where a previous vendoring would have put it, and
        // check it's left alone.
        let existing = root.join(".inkycap/packages/preview/foo/1.0.0");
        std::fs::create_dir_all(&existing).unwrap();
        std::fs::write(existing.join("lib.typ"), "#let foo = 1").unwrap();

        let report = vendor_notebox_packages(root).unwrap();
        // Already in the notebox → not re-copied, not unresolved.
        assert!(report.vendored.is_empty());
        assert!(report.unresolved.is_empty());
    }

    #[test]
    fn reports_unresolved_when_package_absent() {
        let tmp = tempfile::tempdir().unwrap();
        let root = tmp.path();
        std::fs::write(
            root.join("note.typ"),
            "#import \"@local/never-installed:2.0.0\": *\n= Hi",
        )
        .unwrap();

        let report = vendor_notebox_packages(root).unwrap();
        assert!(report.vendored.is_empty());
        assert_eq!(report.unresolved, vec!["@local/never-installed:2.0.0"]);
    }
}
