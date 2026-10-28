//! The Typst packages a note imports, and the two ways they can get in the way
//! of InkyCap on screen:
//!
//! - **Replaced names.** `#import "@preview/x:1.0.0": *` binds every name the
//!   package exports, and a later import wins. A package exporting `note` or
//!   `task` imported after the notebox package takes over InkyCap's function of
//!   that name, so `#note(...)` stops carrying the note's properties, or a
//!   `#task` no longer reaches the Agenda.
//!   [`collision_warnings`] reports such imports.
//! - **Templates.** A template's whole-document `#show:` rule lays the note out
//!   for print. Templates apply only where a note is exported to PDF, so
//!   [`without_template_rules`] leaves those rules out of the reading view,
//!   Journal Scroll and metadata compiles.
//!
//! What a package exports is asked of Typst itself: a small document imports
//! the package as a module and records `dictionary(module).keys()`, which
//! includes names the package passes on from its own imports. Per CLAUDE.md's
//! Typst-first principle, nothing here reads package source to guess at them.

use std::collections::{BTreeMap, HashMap, HashSet};
use std::ops::Range;
use std::path::{Path, PathBuf};
use std::sync::Arc;
use std::time::SystemTime;

use typst::foundations::{Label, Selector, Value};
use typst::introspection::{Introspector, MetadataElem};
use typst::syntax::package::PackageManifest;
use typst::utils::PicoStr;

use crate::typst_packages::{self, PackageSpec};
use crate::typst_pipeline::compiler::TypstCompiler;
use crate::typst_pipeline::diagnostic::{TypstDiagnostic, TypstSpan};
use crate::typst_pipeline::syntax::{ast, parse, SyntaxKind};
use crate::typst_pipeline::template_setup::{applied_rules, notebox_exports};

/// A top-level `#import` of a Typst package (`"@namespace/name:version"`).
#[derive(Debug, Clone, PartialEq)]
pub struct PackageImport {
    pub spec: String,
    /// From the `#` through the end of the import.
    pub range: Range<usize>,
    /// `: *`, which binds every name the package exports.
    pub wildcard: bool,
    /// The names it binds otherwise: listed items (after any `as`), and the
    /// module name (`as name`, or the package's name for a bare import).
    pub bound: Vec<String>,
}

/// Top-level package imports in `source`, in source order.
pub fn package_imports(source: &str) -> Vec<PackageImport> {
    let root = parse(source);
    let mut out = Vec::new();
    let mut offset = 0;
    let mut hash_at = None;
    for child in root.children() {
        match child.kind() {
            SyntaxKind::Hash => hash_at = Some(offset),
            SyntaxKind::ModuleImport => {
                if let (Some(start), Some(import)) = (hash_at, child.cast::<ast::ModuleImport>()) {
                    if let ast::Expr::Str(s) = import.source() {
                        let spec = s.get().to_string();
                        if spec.starts_with('@') {
                            let mut bound: Vec<String> = Vec::new();
                            let mut wildcard = false;
                            match import.imports() {
                                Some(ast::Imports::Wildcard) => wildcard = true,
                                Some(ast::Imports::Items(items)) => bound
                                    .extend(items.iter().map(|i| i.bound_name().get().to_string())),
                                None => {}
                            }
                            match import.new_name() {
                                Some(name) => bound.push(name.get().to_string()),
                                // A bare `#import "@ns/name:1.0.0"` binds the
                                // module as `name`.
                                None if import.imports().is_none() => {
                                    if let Some(parsed) = PackageSpec::parse(&spec) {
                                        bound.push(parsed.name);
                                    }
                                }
                                None => {}
                            }
                            out.push(PackageImport {
                                spec,
                                range: start..offset + child.len(),
                                wildcard,
                                bound,
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
    out
}

/// Where the notebox import starts, or `None` if the note has none.
fn notebox_import_start(source: &str) -> Option<usize> {
    let mut offset = 0;
    for line in source.split_inclusive('\n') {
        if crate::notebox_package::is_notebox_import_line(line.trim_end_matches(['\n', '\r'])) {
            return Some(
                offset + (line.len() - line.trim_start_matches('\u{feff}').trim_start().len()),
            );
        }
        offset += line.len();
    }
    None
}

/// What Typst reports about an installed package.
#[derive(Debug, PartialEq)]
pub struct PackageFacts {
    /// Its `typst.toml` declares `[template]`.
    pub is_template: bool,
    /// Every name `#import "<spec>": *` binds.
    pub exports: HashSet<String>,
    /// The packages it imports, directly or through others.
    pub dependencies: HashSet<String>,
}

/// [`PackageFacts`] by spec, kept until the package is installed, removed, or
/// its manifest or entrypoint file changes (an `@local` package being edited).
/// Packages that aren't installed or can't be imported are remembered too, so
/// indexing doesn't retry them for every note. Lives on the [`TypstCompiler`],
/// whose lock already serializes every compile.
#[derive(Default)]
pub struct PackageFactsCache {
    entries: HashMap<String, CacheEntry>,
    /// Packages whose output Typst's HTML export has left out (see
    /// [`crate::typst_pipeline::html_drawings`]).
    dropped_in_html: HashSet<String>,
}

impl PackageFactsCache {
    /// Remember that HTML export left out content from `spec`. True if it
    /// wasn't known yet.
    pub fn record_dropped_in_html(&mut self, spec: String) -> bool {
        self.dropped_in_html.insert(spec)
    }

    pub fn dropped_in_html(&self) -> &HashSet<String> {
        &self.dropped_in_html
    }
}

struct CacheEntry {
    /// Where the package was found, if anywhere.
    dir: Option<PathBuf>,
    entrypoint: Option<PathBuf>,
    stamp: FileStamp,
    facts: Option<Arc<PackageFacts>>,
}

/// Modification times of a package's `typst.toml` and entrypoint.
type FileStamp = (Option<SystemTime>, Option<SystemTime>);

fn modified(path: &Path) -> Option<SystemTime> {
    std::fs::metadata(path).and_then(|m| m.modified()).ok()
}

fn stamp_of(dir: Option<&Path>, entrypoint: Option<&Path>) -> FileStamp {
    (
        dir.and_then(|d| modified(&d.join("typst.toml"))),
        entrypoint.and_then(modified),
    )
}

/// Label of the probe document's metadata.
const EXPORTS_LABEL: &str = "inkycap-exports";

/// [`PackageFacts`] for `spec`, or `None` if it isn't installed locally, or
/// Typst can't import it.
pub fn package_facts(compiler: &mut TypstCompiler, spec: &str) -> Option<Arc<PackageFacts>> {
    let parsed = PackageSpec::parse(spec)?;
    let canonical = parsed.canonical();
    let dir = typst_packages::locate_package_dir(
        compiler.notebox_root(),
        &parsed.namespace,
        &parsed.name,
        &parsed.version,
    );

    if let Some(entry) = compiler.package_facts_cache().entries.get(&canonical) {
        if entry.dir == dir && entry.stamp == stamp_of(dir.as_deref(), entry.entrypoint.as_deref())
        {
            return entry.facts.clone();
        }
    }

    let manifest: Option<PackageManifest> = dir.as_ref().and_then(|d| {
        let text = std::fs::read_to_string(d.join("typst.toml")).ok()?;
        toml::from_str(&text).ok()
    });
    let entrypoint = dir.as_ref().zip(manifest.as_ref()).and_then(|(d, m)| {
        typst_packages::sanitize_relative(Path::new(m.package.entrypoint.as_str()))
            .map(|rel| d.join(rel))
    });
    let facts = match (&manifest, &dir) {
        (Some(m), Some(d)) => probe_exports(compiler, &canonical).map(|exports| {
            Arc::new(PackageFacts {
                is_template: m.template.is_some(),
                exports,
                dependencies: crate::typst_pipeline::package_vendor::package_dependencies(
                    compiler.notebox_root(),
                    d,
                ),
            })
        }),
        _ => None,
    };
    let stamp = stamp_of(dir.as_deref(), entrypoint.as_deref());
    compiler.package_facts_cache().entries.insert(
        canonical,
        CacheEntry {
            dir,
            entrypoint,
            stamp,
            facts: facts.clone(),
        },
    );
    facts
}

/// The names `spec` exports, from a document that imports it as a module. The
/// spec has passed [`PackageSpec::parse`], so it holds only name and version
/// characters and can't break out of the string.
fn probe_exports(compiler: &mut TypstCompiler, spec: &str) -> Option<HashSet<String>> {
    let probe = format!(
        "#import \"{spec}\" as inkycap-probed\n\
         #metadata(dictionary(inkycap-probed).keys()) <{EXPORTS_LABEL}>\n"
    );
    let path = compiler
        .notebox_root()
        .join(".inkycap")
        .join("package-exports-probe.typ");
    let document = compiler.compile_document(&path, probe)?;
    let label = Label::new(PicoStr::intern(EXPORTS_LABEL))?;
    let elements = document
        .introspector()
        .as_ref()
        .query(&Selector::Label(label));
    let meta = elements.first()?.to_packed::<MetadataElem>()?;
    let Value::Array(names) = &meta.value else {
        return None;
    };
    Some(
        names
            .iter()
            .filter_map(|v| match v {
                Value::Str(s) => Some(s.to_string()),
                _ => None,
            })
            .collect(),
    )
}

/// The notebox names `facts` would replace if imported with `*`, sorted.
/// Names starting with `_` are the notebox package's internals, which its own
/// functions keep using whatever a note imports, so they don't count.
pub fn replaced_notebox_names(facts: &PackageFacts) -> Vec<String> {
    let mut names: Vec<String> = facts
        .exports
        .iter()
        .filter(|n| !n.starts_with('_') && notebox_exports().contains(*n))
        .cloned()
        .collect();
    names.sort();
    names
}

/// The `*` package imports after the notebox import, each with the notebox
/// names it replaces. An import above the notebox import replaces nothing,
/// since the notebox import then wins.
pub fn colliding_imports(
    compiler: &mut TypstCompiler,
    source: &str,
) -> Vec<(PackageImport, Vec<String>)> {
    let Some(notebox_at) = notebox_import_start(source) else {
        return Vec::new();
    };
    package_imports(source)
        .into_iter()
        .filter(|import| import.wildcard && import.range.start > notebox_at)
        .filter_map(|import| {
            let facts = package_facts(compiler, &import.spec)?;
            let names = replaced_notebox_names(&facts);
            (!names.is_empty()).then_some((import, names))
        })
        .collect()
}

/// A warning for each import in [`colliding_imports`], placed on the import.
/// `rel_path` is the note's notebox-relative path, as Typst's own diagnostics
/// give it; spans are in `source` (the compiled source), like theirs.
pub fn collision_warnings(
    compiler: &mut TypstCompiler,
    source: &str,
    rel_path: &str,
) -> Vec<TypstDiagnostic> {
    colliding_imports(compiler, source)
        .into_iter()
        .map(|(import, names)| collision_warning(source, rel_path, &import, &names))
        .collect()
}

fn collision_warning(
    source: &str,
    rel_path: &str,
    import: &PackageImport,
    names: &[String],
) -> TypstDiagnostic {
    let before = &source[..import.range.start];
    let line = before.matches('\n').count() + 1;
    let column = before.rsplit('\n').next().map_or(0, |l| l.chars().count()) + 1;
    let joined = names
        .iter()
        .map(|n| format!("`{n}`"))
        .collect::<Vec<_>>()
        .join(", ");
    let example = names.first().cloned().unwrap_or_default();
    let package = PackageSpec::parse(&import.spec)
        .map(|p| p.name)
        .unwrap_or_else(|| "pkg".to_string());
    TypstDiagnostic {
        severity: "warning",
        message: format!(
            "Importing everything from {spec} here replaces InkyCap's {joined}, which this \
             note then can't use. Fix import moves it above InkyCap's own import, keeping the \
             package's version as `{package}-{example}`.",
            spec = import.spec
        ),
        primary: Some(TypstSpan {
            path: Some(rel_path.to_string()),
            start: import.range.start,
            end: import.range.end,
            line: Some(line),
            column: Some(column),
            is_main: true,
            package: None,
        }),
        trace: Vec::new(),
        hints: Vec::new(),
        code: Some("package-replaces-notebox-names"),
        params: BTreeMap::from([
            ("spec", import.spec.clone()),
            ("names", joined),
            ("example", example),
            ("package", package),
        ]),
    }
}

/// `source` with the whole-document `#show:` rules of the templates it imports
/// blanked out, for compiles other than PDF export. A rule counts when the
/// function it applies comes from an imported template package. Each rule is
/// replaced by spaces, keeping its line breaks, so every later byte offset,
/// line and column is unchanged and diagnostics still point at the right text.
pub fn without_template_rules(compiler: &mut TypstCompiler, source: &str) -> String {
    // Most notes import no package; skip parsing them.
    if !source.contains("\"@") {
        return source.to_string();
    }
    let imports = package_imports(source);
    if imports.is_empty() {
        return source.to_string();
    }
    let mut template_names: HashSet<String> = HashSet::new();
    for import in &imports {
        let Some(facts) = package_facts(compiler, &import.spec) else {
            continue;
        };
        if !facts.is_template {
            continue;
        }
        if import.wildcard {
            template_names.extend(facts.exports.iter().cloned());
        }
        template_names.extend(import.bound.iter().cloned());
    }
    blank_rules_applying(source, &template_names)
}

/// `source` with every top-level `#show: f` / `#show: f.with(…)` whose `f` is
/// in `names` replaced by spaces, line breaks kept.
fn blank_rules_applying(source: &str, names: &HashSet<String>) -> String {
    let rules: Vec<Range<usize>> = applied_rules(source)
        .into_iter()
        .filter(|r| names.contains(&r.name))
        .map(|r| r.range)
        .collect();
    if rules.is_empty() {
        return source.to_string();
    }
    let mut out = String::with_capacity(source.len());
    let mut cursor = 0;
    for range in rules {
        out.push_str(&source[cursor..range.start]);
        for c in source[range.clone()].chars() {
            if c == '\n' || c == '\r' {
                out.push(c);
            } else {
                out.extend(std::iter::repeat_n(' ', c.len_utf8()));
            }
        }
        cursor = range.end;
    }
    out.push_str(&source[cursor..]);
    out
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::storage::path::canonicalize_root;
    use std::fs;
    use tempfile::tempdir;

    const NOTEBOX_IMPORT: &str = "#import \"/.inkycap/notebox.typ\": *";

    /// A notebox with the notebox package and one `@local` package `name`
    /// whose `lib.typ` is `lib`; a template when `template` is set.
    fn notebox_with_package(
        name: &str,
        lib: &str,
        template: bool,
    ) -> (tempfile::TempDir, TypstCompiler) {
        let dir = tempdir().unwrap();
        let root = canonicalize_root(dir.path()).unwrap();
        crate::notebox_package::scaffold(&root);
        let pkg = root.join(format!(".inkycap/packages/local/{name}/0.1.0"));
        fs::create_dir_all(&pkg).unwrap();
        let mut manifest = format!(
            "[package]\nname = \"{name}\"\nversion = \"0.1.0\"\nentrypoint = \"lib.typ\"\n"
        );
        if template {
            manifest.push_str("\n[template]\npath = \"template\"\nentrypoint = \"main.typ\"\n");
        }
        fs::write(pkg.join("typst.toml"), manifest).unwrap();
        fs::write(pkg.join("lib.typ"), lib).unwrap();
        let compiler = TypstCompiler::new(root);
        (dir, compiler)
    }

    #[test]
    fn finds_package_imports_and_what_they_bind() {
        let src = format!(
            "{NOTEBOX_IMPORT}\n#import \"@preview/a:1.0.0\": *\n#import \"@preview/b:1.0.0\": x, y as z\n\
             #import \"@preview/c:1.0.0\" as c\n#import \"@preview/d:1.0.0\"\n#import \"/local.typ\": *\n"
        );
        let imports = package_imports(&src);
        assert_eq!(imports.len(), 4);
        assert!(imports[0].wildcard);
        assert_eq!(
            &src[imports[0].range.clone()],
            "#import \"@preview/a:1.0.0\": *"
        );
        assert_eq!(imports[1].bound, vec!["x", "z"]);
        assert_eq!(imports[2].bound, vec!["c"]);
        assert_eq!(imports[3].bound, vec!["d"]);
    }

    #[test]
    fn reports_exports_including_ones_passed_on() {
        let (_dir, mut compiler) = notebox_with_package(
            "margins",
            "#import \"inner.typ\": *\n#let side-note(body) = body\n",
            false,
        );
        let pkg = compiler
            .notebox_root()
            .join(".inkycap/packages/local/margins/0.1.0");
        fs::write(pkg.join("inner.typ"), "#let note(body) = body\n").unwrap();

        let facts = package_facts(&mut compiler, "@local/margins:0.1.0").unwrap();
        assert!(!facts.is_template);
        assert!(facts.exports.contains("note"), "{:?}", facts.exports);
        assert!(facts.exports.contains("side-note"));
        assert_eq!(replaced_notebox_names(&facts), vec!["note"]);
    }

    #[test]
    fn warns_only_about_wildcard_imports_after_the_notebox_import() {
        let (_dir, mut compiler) =
            notebox_with_package("margins", "#let note(body) = body\n#let task = 1\n", false);
        let after = format!("{NOTEBOX_IMPORT}\n#import \"@local/margins:0.1.0\": *\n#note()\n");
        let warnings = collision_warnings(&mut compiler, &after, "a.typ");
        assert_eq!(warnings.len(), 1);
        let w = &warnings[0];
        assert_eq!(w.code, Some("package-replaces-notebox-names"));
        assert_eq!(w.params["names"], "`note`, `task`");
        let span = w.primary.as_ref().unwrap();
        assert_eq!((span.line, span.column), (Some(2), Some(1)));

        let before = format!("#import \"@local/margins:0.1.0\": *\n{NOTEBOX_IMPORT}\n#note()\n");
        assert!(collision_warnings(&mut compiler, &before, "a.typ").is_empty());

        let items = format!("{NOTEBOX_IMPORT}\n#import \"@local/margins:0.1.0\": note as side\n");
        assert!(collision_warnings(&mut compiler, &items, "a.typ").is_empty());
    }

    #[test]
    fn blanks_template_rules_and_keeps_offsets() {
        let (_dir, mut compiler) = notebox_with_package(
            "letter",
            "#let letter(title: none, body) = body\n#let sign(name) = name\n",
            true,
        );
        let src = format!(
            "#import \"@local/letter:0.1.0\": *\n{NOTEBOX_IMPORT}\n\
             #show: letter.with(\n  title: [Café],\n)\n#show: it => it\n#note()\nBody #sign(\"A\")\n"
        );
        let out = without_template_rules(&mut compiler, &src);
        assert_eq!(out.len(), src.len());
        assert_eq!(out.lines().count(), src.lines().count());
        assert!(!out.contains("letter.with"));
        assert!(out.contains("#show: it => it"));
        assert!(out.contains("#sign(\"A\")"));
        let body = src.find("Body").unwrap();
        assert_eq!(&out[body..], &src[body..]);
    }

    #[test]
    fn keeps_rules_from_library_packages() {
        let (_dir, mut compiler) =
            notebox_with_package("codes", "#let codes-init(body) = body\n", false);
        let src =
            format!("{NOTEBOX_IMPORT}\n#import \"@local/codes:0.1.0\": *\n#show: codes-init\n");
        assert_eq!(without_template_rules(&mut compiler, &src), src);
    }
}
