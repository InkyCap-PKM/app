//! What the Templates panel shows about an installed package: the facts from
//! its `typst.toml`, read with Typst's own `PackageManifest`, and the files a
//! user reaches for to learn how to use it (README, a template's starter file
//! and thumbnail).
//!
//! Every path here comes from a manifest written by someone else, so each is
//! checked to stay inside the package folder before it is returned.

use std::fs;
use std::path::{Path, PathBuf};

use serde::Serialize;
use typst::syntax::package::PackageManifest;

use super::{sanitize_relative, PackageSpec};
use crate::storage::to_frontend_string;

/// An installed package's details. Paths are absolute in the frontend's form
/// (see [`to_frontend_string`]) unless noted.
#[derive(Debug, Serialize, PartialEq)]
pub struct PackageDetails {
    pub description: Option<String>,
    /// Author names, without the `<email or URL>` some manifests add.
    pub authors: Vec<String>,
    pub license: Option<String>,
    /// Only `http(s)` links are kept.
    pub homepage: Option<String>,
    /// Only `http(s)` links are kept.
    pub repository: Option<String>,
    pub categories: Vec<String>,
    /// The package's page on Typst Universe, for `@preview` packages only.
    pub universe_url: Option<String>,
    pub readme_path: Option<String>,
    /// A template's starter file (`[template].path` + `entrypoint`), the
    /// author's example of how to use it.
    pub starter_path: Option<String>,
    /// A template's preview image, notebox-root-absolute (`/.inkycap/…`) so the
    /// frontend can load it like any notebox image.
    pub thumbnail_path: Option<String>,
}

/// Details for the package installed at `dir` (its `<ns>/<name>/<version>`
/// folder in the notebox). `None` if `typst.toml` is missing or isn't a valid
/// manifest.
pub fn read_details(dir: &Path, spec: &PackageSpec) -> Option<PackageDetails> {
    let manifest_text = fs::read_to_string(dir.join("typst.toml")).ok()?;
    let manifest: PackageManifest = toml::from_str(&manifest_text).ok()?;
    let info = &manifest.package;

    let starter_path = manifest.template.as_ref().and_then(|tpl| {
        let rel = Path::new(tpl.path.as_str()).join(tpl.entrypoint.as_str());
        file_inside(dir, &rel).map(|p| to_frontend_string(&p))
    });
    let thumbnail_path = manifest
        .template
        .as_ref()
        .and_then(|tpl| tpl.thumbnail.as_ref())
        .and_then(|thumb| {
            let safe = sanitize_relative(Path::new(thumb.as_str()))?;
            dir.join(&safe).is_file().then(|| {
                let rel = safe.to_string_lossy().replace('\\', "/");
                format!(
                    "/.inkycap/packages/{}/{}/{}/{rel}",
                    spec.namespace, spec.name, spec.version
                )
            })
        });

    Some(PackageDetails {
        description: info.description.as_ref().map(|s| s.to_string()),
        authors: info.authors.iter().map(|a| author_name(a)).collect(),
        license: info.license.as_ref().map(|s| s.to_string()),
        homepage: info.homepage.as_deref().and_then(web_link),
        repository: info.repository.as_deref().and_then(web_link),
        categories: info.categories.iter().map(|c| c.to_string()).collect(),
        universe_url: (spec.namespace == "preview").then(|| {
            format!(
                "https://typst.app/universe/package/{}/{}",
                spec.name, spec.version
            )
        }),
        readme_path: find_readme(dir).map(|p| to_frontend_string(&p)),
        starter_path,
        thumbnail_path,
    })
}

/// `dir/rel` if `rel` stays inside `dir` and names a file.
fn file_inside(dir: &Path, rel: &Path) -> Option<PathBuf> {
    let path = dir.join(sanitize_relative(rel)?);
    path.is_file().then_some(path)
}

/// The package's `README.md`, matched without regard to case.
fn find_readme(dir: &Path) -> Option<PathBuf> {
    fs::read_dir(dir)
        .ok()?
        .flatten()
        .find(|e| {
            e.file_name()
                .to_string_lossy()
                .eq_ignore_ascii_case("readme.md")
                && e.path().is_file()
        })
        .map(|e| e.path())
}

/// `"Athena Otlet <athena@inkycap.org>"` → `"Athena Otlet"`.
fn author_name(author: &str) -> String {
    match author.find('<') {
        Some(i) if author.trim_end().ends_with('>') => author[..i].trim().to_string(),
        _ => author.trim().to_string(),
    }
}

/// `url` if it is an `http(s)` link, the only kind a manifest has reason to
/// give.
fn web_link(url: &str) -> Option<String> {
    let url = url.trim();
    let lower = url.to_ascii_lowercase();
    (lower.starts_with("https://") || lower.starts_with("http://")).then(|| url.to_string())
}

#[cfg(test)]
mod tests {
    use super::*;
    use tempfile::tempdir;

    fn spec(namespace: &str) -> PackageSpec {
        PackageSpec {
            namespace: namespace.into(),
            name: "letter".into(),
            version: "0.1.0".into(),
        }
    }

    const TEMPLATE_MANIFEST: &str = r#"
[package]
name = "letter"
version = "0.1.0"
entrypoint = "lib.typ"
authors = ["Athena Otlet <athena@inkycap.org>", "Second Author"]
license = "MIT"
description = "A letter layout."
repository = "https://codeberg.org/athena-otlet/letter"
homepage = "javascript:alert(1)"
categories = ["office"]

[template]
path = "template"
entrypoint = "main.typ"
thumbnail = "thumb.png"
"#;

    #[test]
    fn reads_a_template_package() {
        let dir = tempdir().unwrap();
        fs::write(dir.path().join("typst.toml"), TEMPLATE_MANIFEST).unwrap();
        fs::write(dir.path().join("Readme.md"), "# Letter").unwrap();
        fs::create_dir(dir.path().join("template")).unwrap();
        fs::write(dir.path().join("template/main.typ"), "#show: letter").unwrap();
        fs::write(dir.path().join("thumb.png"), b"png").unwrap();

        let d = read_details(dir.path(), &spec("preview")).unwrap();
        assert_eq!(d.description.as_deref(), Some("A letter layout."));
        assert_eq!(d.authors, vec!["Athena Otlet", "Second Author"]);
        assert_eq!(d.license.as_deref(), Some("MIT"));
        assert_eq!(
            d.repository.as_deref(),
            Some("https://codeberg.org/athena-otlet/letter")
        );
        assert_eq!(d.homepage, None, "non-web links are dropped");
        assert_eq!(d.categories, vec!["office"]);
        assert_eq!(
            d.universe_url.as_deref(),
            Some("https://typst.app/universe/package/letter/0.1.0")
        );
        assert!(d.readme_path.unwrap().ends_with("/Readme.md"));
        assert!(d.starter_path.unwrap().ends_with("/template/main.typ"));
        assert_eq!(
            d.thumbnail_path.as_deref(),
            Some("/.inkycap/packages/preview/letter/0.1.0/thumb.png")
        );
    }

    #[test]
    fn local_packages_have_no_universe_page() {
        let dir = tempdir().unwrap();
        fs::write(
            dir.path().join("typst.toml"),
            "[package]\nname = \"letter\"\nversion = \"0.1.0\"\nentrypoint = \"lib.typ\"\n",
        )
        .unwrap();
        let d = read_details(dir.path(), &spec("local")).unwrap();
        assert_eq!(d.universe_url, None);
        assert_eq!(d.readme_path, None);
        assert_eq!(d.starter_path, None);
    }

    #[test]
    fn refuses_manifest_paths_that_leave_the_package() {
        let root = tempdir().unwrap();
        let dir = root.path().join("pkg");
        fs::create_dir(&dir).unwrap();
        fs::write(root.path().join("secret.typ"), "").unwrap();
        fs::write(root.path().join("secret.png"), "").unwrap();
        fs::write(
            dir.join("typst.toml"),
            "[package]\nname = \"letter\"\nversion = \"0.1.0\"\nentrypoint = \"lib.typ\"\n\n\
             [template]\npath = \"..\"\nentrypoint = \"secret.typ\"\nthumbnail = \"../secret.png\"\n",
        )
        .unwrap();
        let d = read_details(&dir, &spec("preview")).unwrap();
        assert_eq!(d.starter_path, None);
        assert_eq!(d.thumbnail_path, None);
    }

    #[test]
    fn an_invalid_manifest_gives_no_details() {
        let dir = tempdir().unwrap();
        fs::write(dir.path().join("typst.toml"), "[package]\nname = 3\n").unwrap();
        assert_eq!(read_details(dir.path(), &spec("preview")), None);
    }
}
