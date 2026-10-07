//! Which notes reference which notebox files (images, PDFs, media, data
//! files), so an attachment can list the notes that use it.
//!
//! The references come from each note's source through
//! [`referenced_notebox_paths`], the same Typst-syntax reader that rename and
//! attachment-folder moves use to find the calls they rewrite. Reading the
//! source rather than recording what a compile loads keeps `#video` and
//! `#audio` (whose files Typst never opens) in the record, and works for
//! notes the index restores from its cache without compiling them.

use std::collections::HashMap;
use std::path::Path;

use crate::models::note::NoteId;
use crate::typst_pipeline::path_rebase::referenced_notebox_paths;

/// Calls whose first argument can name a notebox file. A note whose source
/// contains none of these is skipped without parsing it.
const PATH_CALL_MARKERS: &[&str] = &[
    "image(",
    "read(",
    "bibliography(",
    "video(",
    "audio(",
    "link(",
];

/// Note → the notebox files it references, as notebox-relative paths with
/// `/` separators and no leading slash (`Assets/fig.png`).
#[derive(Default)]
pub struct AttachmentRefs {
    by_note: HashMap<NoteId, Vec<String>>,
}

/// The notebox files `content` references, as notebox-relative paths.
/// `note_dir` is the note's folder relative to the notebox root, which
/// relative paths in its source are anchored to.
pub fn references_in(note_dir: &Path, content: &str) -> Vec<String> {
    if PATH_CALL_MARKERS.iter().any(|m| content.contains(m)) {
        referenced_notebox_paths(content, note_dir)
    } else {
        Vec::new()
    }
}

impl AttachmentRefs {
    /// Record the files `note` references, replacing what was recorded for it
    /// before. `note` is the note's absolute path inside `notebox_root`; its
    /// folder is what relative paths in its source are anchored to.
    pub fn record(&mut self, note: NoteId, notebox_root: &Path, content: &str) {
        let note_dir = note
            .strip_prefix(notebox_root)
            .ok()
            .and_then(Path::parent)
            .unwrap_or(Path::new(""));
        let refs = references_in(note_dir, content);
        self.set(note, refs);
    }

    /// Record `refs` (from [`references_in`], or the metadata cache) as the
    /// files `note` references, replacing what was recorded for it before.
    pub fn set(&mut self, note: NoteId, refs: Vec<String>) {
        if refs.is_empty() {
            self.by_note.remove(&note);
        } else {
            self.by_note.insert(note, refs);
        }
    }

    /// Forget everything recorded for `note`.
    pub fn remove_note(&mut self, note: &NoteId) {
        self.by_note.remove(note);
    }

    /// The notes that reference `rel_path` (notebox-relative, `/` separators,
    /// no leading slash), in no particular order.
    pub fn notes_referencing(&self, rel_path: &str) -> Vec<NoteId> {
        self.by_note
            .iter()
            .filter(|(_, refs)| refs.iter().any(|r| r == rel_path))
            .map(|(note, _)| note.clone())
            .collect()
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::path::PathBuf;

    #[test]
    fn records_and_finds_references() {
        let mut refs = AttachmentRefs::default();
        let a = PathBuf::from("/nb/notes/a.typ");
        let b = PathBuf::from("/nb/b.typ");
        refs.record(
            a.clone(),
            Path::new("/nb"),
            "#image(\"/Assets/x.png\")\n#read(\"d.csv\")",
        );
        refs.record(b.clone(), Path::new("/nb"), "#video(\"/Assets/x.png\")");

        let mut users = refs.notes_referencing("Assets/x.png");
        users.sort();
        assert_eq!(users, vec![b.clone(), a.clone()]);
        assert_eq!(refs.notes_referencing("notes/d.csv"), vec![a.clone()]);
        assert!(refs.notes_referencing("Assets/other.png").is_empty());
    }

    #[test]
    fn re_recording_replaces_and_remove_forgets() {
        let mut refs = AttachmentRefs::default();
        let a = PathBuf::from("/nb/a.typ");
        refs.record(a.clone(), Path::new("/nb"), "#image(\"/x.png\")");
        refs.record(a.clone(), Path::new("/nb"), "no references now");
        assert!(refs.notes_referencing("x.png").is_empty());

        refs.record(a.clone(), Path::new("/nb"), "#image(\"/x.png\")");
        refs.remove_note(&a);
        assert!(refs.notes_referencing("x.png").is_empty());
    }
}
