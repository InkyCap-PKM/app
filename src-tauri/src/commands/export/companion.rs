//! The files a note uses, as an export handles them: what its links to
//! notebox files become, and which files are copied into a folder beside the
//! exported file (`<export name>-files/`). Every export shares this, so a
//! single note, a batch, a book, a site and a Markdown export all treat files
//! the same way.
//!
//! Links are rewritten in the Typst source before it is compiled or
//! converted, through [`rewrite_file_links`]. Per CLAUDE.md's Typst-first
//! principle, a `show link` rule in the notebox package was considered: it
//! would cover the Typst-compiled formats, but the Markdown export converts
//! the source without running Typst, so a source rewrite on the Typst syntax
//! tree is the one place that serves every format.

use std::collections::{HashMap, HashSet};
use std::path::{Path, PathBuf};

use serde::Serialize;

use crate::errors::InkyCapError;
pub use crate::models::export::{FileLinkMode, LinkedFilesOptions};
use crate::storage::local::LocalNoteboxStorage;
use crate::storage::to_frontend_string;
use crate::typst_pipeline::path_rebase::{
    referenced_image_paths, rewrite_file_links, FileLinkExport,
};

/// What was copied beside an export, for the dialog's success message.
#[derive(Debug, Clone, Serialize)]
pub struct CompanionReport {
    /// The folder the files went into.
    pub folder: String,
    pub copied: usize,
}

/// Plans and copies the files of one export. Prepare each note's source with
/// [`Self::prepare`] before compiling it, then call [`Self::copy`] once the
/// export is written. Notes of one export share the folder, and a file used
/// by several notes is copied once.
pub(crate) struct CompanionFiles {
    options: LinkedFilesOptions,
    folder: PathBuf,
    folder_name: String,
    /// Notebox-relative path → name of its copy in the folder.
    names: HashMap<String, String>,
    /// Lower-cased copy names in use, so two files never share a name, even
    /// on a file system that ignores case.
    taken: HashSet<String>,
    /// Source file and copy name, in the order planned.
    copies: Vec<(PathBuf, String)>,
}

impl CompanionFiles {
    /// Files for an export written into `output_dir`, going into the folder
    /// `<base_name>-files` there.
    pub(crate) fn new(
        options: Option<LinkedFilesOptions>,
        output_dir: &Path,
        base_name: &str,
    ) -> Self {
        let folder_name = format!("{base_name}-files");
        Self {
            options: options.unwrap_or_default(),
            folder: output_dir.join(&folder_name),
            folder_name,
            names: HashMap::new(),
            taken: HashSet::new(),
            copies: Vec::new(),
        }
    }

    /// Files for an export written to the file `output_path`, going into
    /// `<file stem>-files` beside it.
    pub(crate) fn beside_file(options: Option<LinkedFilesOptions>, output_path: &Path) -> Self {
        let dir = output_path.parent().unwrap_or(Path::new(""));
        let stem = output_path
            .file_stem()
            .map(|s| s.to_string_lossy().into_owned())
            .unwrap_or_else(|| "export".to_string());
        Self::new(options, dir, &stem)
    }

    /// Files for an export of the collection at `collection_path` into the
    /// folder `output_dir` (a batch, a site), going into
    /// `<collection name>-files` there.
    pub(crate) fn for_collection(
        options: Option<LinkedFilesOptions>,
        output_dir: &Path,
        collection_path: &Path,
    ) -> Self {
        let name = collection_path
            .file_stem()
            .map(|s| s.to_string_lossy().into_owned())
            .unwrap_or_else(|| "collection".to_string());
        Self::new(options, output_dir, &name)
    }

    /// [`Self::prepare`] for the note at `note_path` (absolute or
    /// notebox-relative).
    pub(crate) fn prepare_note(
        &mut self,
        storage: &LocalNoteboxStorage,
        note_path: &Path,
        source: &str,
    ) -> String {
        let note_dir = crate::commands::file_ops::notebox_relative_path(note_path, storage)
            .parent()
            .map(Path::to_path_buf)
            .unwrap_or_default();
        self.prepare(storage, &note_dir, source)
    }

    /// `source`, with its links to notebox files rewritten as the options
    /// say, after noting the files it needs copied. `note_dir` is the note's
    /// folder relative to the notebox root, for relative image paths.
    pub(crate) fn prepare(
        &mut self,
        storage: &LocalNoteboxStorage,
        note_dir: &Path,
        source: &str,
    ) -> String {
        if self.options.copy_images {
            for rel in referenced_image_paths(source, note_dir) {
                self.plan(storage, &rel);
            }
        }
        match self.options.links {
            FileLinkMode::AsWritten => source.to_string(),
            FileLinkMode::FileName => rewrite_file_links(source, |_| FileLinkExport::PlainText),
            FileLinkMode::Copies => {
                rewrite_file_links(source, |rel| match self.plan(storage, rel) {
                    Some(name) => FileLinkExport::Retarget(format!(
                        "{}/{}",
                        encode_url_path(&self.folder_name),
                        encode_url_path(&name)
                    )),
                    // A missing file, or one outside the notebox, keeps its link.
                    None => FileLinkExport::Keep,
                })
            }
        }
    }

    /// Copy the planned files into the folder. `None` when nothing was to be
    /// copied.
    pub(crate) async fn copy(&self) -> Result<Option<CompanionReport>, InkyCapError> {
        if self.copies.is_empty() {
            return Ok(None);
        }
        tokio::fs::create_dir_all(&self.folder).await.map_err(|e| {
            InkyCapError::ExportFailed(format!("Failed to create {}: {e}", self.folder_name))
        })?;
        for (source, name) in &self.copies {
            tokio::fs::copy(source, self.folder.join(name))
                .await
                .map_err(|e| InkyCapError::ExportFailed(format!("Failed to copy {name}: {e}")))?;
        }
        Ok(Some(CompanionReport {
            folder: to_frontend_string(&self.folder),
            copied: self.copies.len(),
        }))
    }

    /// The copy name for the notebox file `rel`, planning its copy the first
    /// time. `None` when the file doesn't exist or lies outside the notebox.
    fn plan(&mut self, storage: &LocalNoteboxStorage, rel: &str) -> Option<String> {
        if let Some(name) = self.names.get(rel) {
            return Some(name.clone());
        }
        // Resolving through the storage keeps every copy inside the notebox,
        // whatever path a (possibly shared) note names.
        let source = storage.resolve_path(Path::new(rel)).ok()?;
        if !source.is_file() {
            return None;
        }
        let file_name = source.file_name()?.to_string_lossy().into_owned();
        let name = self.unique_name(&file_name);
        self.names.insert(rel.to_string(), name.clone());
        self.copies.push((source, name.clone()));
        Some(name)
    }

    /// `file_name`, or `stem-2.ext`, `stem-3.ext`, … when it is taken.
    fn unique_name(&mut self, file_name: &str) -> String {
        let (stem, ext) = match file_name.rfind('.') {
            Some(dot) if dot > 0 => (&file_name[..dot], &file_name[dot..]),
            _ => (file_name, ""),
        };
        let mut candidate = file_name.to_string();
        let mut n = 2;
        while !self.taken.insert(candidate.to_lowercase()) {
            candidate = format!("{stem}-{n}{ext}");
            n += 1;
        }
        candidate
    }
}

/// Percent-encode a relative path for use as a link target, keeping `/`.
/// PDF readers and browsers need spaces and non-ASCII letters encoded.
fn encode_url_path(path: &str) -> String {
    let mut out = String::with_capacity(path.len());
    for byte in path.bytes() {
        if byte.is_ascii_alphanumeric() || matches!(byte, b'-' | b'.' | b'_' | b'~' | b'/') {
            out.push(byte as char); // utf8-safe: only ASCII bytes reach this push
        } else {
            out.push_str(&format!("%{byte:02X}"));
        }
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    fn storage_with(files: &[&str]) -> (tempfile::TempDir, LocalNoteboxStorage) {
        let dir = tempfile::tempdir().unwrap();
        for f in files {
            let p = dir.path().join(f);
            std::fs::create_dir_all(p.parent().unwrap()).unwrap();
            std::fs::write(p, b"data").unwrap();
        }
        let storage = LocalNoteboxStorage::new(dir.path().to_path_buf()).unwrap();
        (dir, storage)
    }

    fn options(links: FileLinkMode, copy_images: bool) -> Option<LinkedFilesOptions> {
        Some(LinkedFilesOptions { links, copy_images })
    }

    #[test]
    fn absent_options_keep_links_and_copy_nothing() {
        let (_d, storage) = storage_with(&["Assets/a.pdf"]);
        let mut files = CompanionFiles::new(None, Path::new("/out"), "note");
        let src = "#link(\"/Assets/a.pdf\")[A] #image(\"/Assets/a.pdf\")";
        assert_eq!(files.prepare(&storage, Path::new(""), src), src);
        assert!(files.copies.is_empty());
    }

    #[test]
    fn copies_retarget_links_and_number_clashing_names() {
        let (_d, storage) = storage_with(&["A/x y.pdf", "B/X Y.pdf"]);
        let mut files = CompanionFiles::new(
            options(FileLinkMode::Copies, false),
            Path::new("/out"),
            "my note",
        );
        let out = files.prepare(
            &storage,
            Path::new(""),
            "#link(\"/A/x y.pdf\")[1] #link(\"/B/X Y.pdf\")[2] #link(\"/A/x y.pdf\")[3] #link(\"/missing.pdf\")[4]",
        );
        assert_eq!(
            out,
            "#link(\"my%20note-files/x%20y.pdf\")[1] #link(\"my%20note-files/X%20Y-2.pdf\")[2] \
             #link(\"my%20note-files/x%20y.pdf\")[3] #link(\"/missing.pdf\")[4]"
        );
        let names: Vec<&str> = files.copies.iter().map(|(_, n)| n.as_str()).collect();
        assert_eq!(names, vec!["x y.pdf", "X Y-2.pdf"]);
    }

    #[test]
    fn file_name_mode_and_image_copies() {
        let (_d, storage) = storage_with(&["notes/fig.png", "Assets/a.pdf"]);
        let mut files = CompanionFiles::new(
            options(FileLinkMode::FileName, true),
            Path::new("/out"),
            "n",
        );
        let out = files.prepare(
            &storage,
            Path::new("notes"),
            "#image(\"fig.png\") #link(\"/Assets/a.pdf\")",
        );
        assert_eq!(out, "#image(\"fig.png\") a.pdf");
        let names: Vec<&str> = files.copies.iter().map(|(_, n)| n.as_str()).collect();
        assert_eq!(names, vec!["fig.png"]);
    }

    #[test]
    fn paths_outside_the_notebox_are_never_planned() {
        let outer = tempfile::tempdir().unwrap();
        std::fs::write(outer.path().join("secret.txt"), b"x").unwrap();
        let (_d, storage) = storage_with(&[]);
        let mut files =
            CompanionFiles::new(options(FileLinkMode::Copies, true), Path::new("/out"), "n");
        let escape = format!(
            "/../{}/secret.txt",
            outer.path().file_name().unwrap().to_string_lossy()
        );
        files.prepare(
            &storage,
            Path::new(""),
            &format!("#image(\"{escape}\") #link(\"{escape}\")"),
        );
        assert!(files.copies.is_empty());
    }

    #[tokio::test]
    async fn copy_writes_the_folder_and_reports() {
        let (_d, storage) = storage_with(&["Assets/a.pdf"]);
        let out = tempfile::tempdir().unwrap();
        let mut files = CompanionFiles::beside_file(
            options(FileLinkMode::Copies, false),
            &out.path().join("paper.pdf"),
        );
        files.prepare(&storage, Path::new(""), "#link(\"/Assets/a.pdf\")");
        let report = files.copy().await.unwrap().expect("a report");
        assert_eq!(report.copied, 1);
        assert!(out.path().join("paper-files/a.pdf").is_file());
    }

    #[test]
    fn a_retargeted_link_compiles_into_the_pdf() {
        use crate::typst_pipeline::{PdfStandardPreset, TypstCompiler};
        let (dir, storage) = storage_with(&["Assets/a b.pdf"]);
        let root = storage.canonical_root().to_path_buf();
        let mut files = CompanionFiles::new(
            options(FileLinkMode::Copies, false),
            Path::new("/out"),
            "paper",
        );
        let source = files.prepare(
            &storage,
            Path::new(""),
            "#link(\"/Assets/a b.pdf\")[The paper]",
        );
        let mut compiler = TypstCompiler::new(root.clone());
        let pdf = compiler
            .compile_pdf(&root.join("note.typ"), source, PdfStandardPreset::Standard)
            .expect("compiles");
        let text = String::from_utf8_lossy(&pdf);
        assert!(
            text.contains("paper-files/a%20b.pdf"),
            "link target missing from PDF"
        );
        drop(dir);
    }
}
