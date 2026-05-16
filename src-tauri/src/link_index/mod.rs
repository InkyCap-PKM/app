// ---------------------------------------------------------------------------
// Why link resolution lives in Rust, not Typst
// ---------------------------------------------------------------------------
//
// Per CLAUDE.md's Typst-first principle, we use `typst query` to *extract*
// outgoing wikilinks from each note (via `<inkycap-link>` metadata in the
// notebox package — see `inkycap-notebox/0.1.0/lib.typ`). What Typst cannot do
// is *resolve* a wikilink target string like `"Reading notes"` to an actual
// file path on disk: that resolution is notebox-specific (filename matching,
// disambiguation, alias lookup) and Typst has no view of the notebox as a
// whole, only the file currently being compiled.
//
// So the split is deliberate and idiomatic: extraction is native (Typst
// knows the source), resolution is Rust-side (Rust knows the notebox).
// ---------------------------------------------------------------------------

use std::collections::HashMap;
use std::path::PathBuf;

use crate::models::note::NoteId;

/// Tracks forward (outgoing) and backward (incoming) links between notes.
pub struct LinkIndex {
    /// Note -> list of wikilink target strings (unresolved)
    forward_raw: HashMap<NoteId, Vec<String>>,
    /// Note -> list of resolved target note paths
    pub forward: HashMap<NoteId, Vec<NoteId>>,
    /// Note -> list of notes that link TO it
    pub backward: HashMap<NoteId, Vec<NoteId>>,
}

impl LinkIndex {
    pub fn new() -> Self {
        Self {
            forward_raw: HashMap::new(),
            forward: HashMap::new(),
            backward: HashMap::new(),
        }
    }

    /// Store the raw wikilink targets for a note.
    pub fn set_forward_links(&mut self, note: NoteId, links: Vec<String>) {
        self.forward_raw.insert(note, links);
    }

    /// Resolve raw link targets to actual note paths and build the backlink index.
    /// Link resolution: match by filename (case-insensitive), shortest unique match.
    pub fn resolve_and_build_backlinks(&mut self, all_paths: &[PathBuf]) {
        self.forward.clear();
        self.backward.clear();

        let stems = StemIndex::build(all_paths);
        for (source, raw_links) in &self.forward_raw {
            let mut resolved = Vec::new();
            for link_target in raw_links {
                if let Some(target_path) = stems.resolve(link_target) {
                    resolved.push(target_path.clone());
                    self.backward
                        .entry(target_path)
                        .or_default()
                        .push(source.clone());
                }
            }
            self.forward.insert(source.clone(), resolved);
        }
    }

    pub fn get_forward_links(&self, note: &NoteId) -> Vec<NoteId> {
        self.forward.get(note).cloned().unwrap_or_default()
    }

    pub fn get_backlinks(&self, note: &NoteId) -> Vec<NoteId> {
        self.backward.get(note).cloned().unwrap_or_default()
    }

    /// Remove a note and all its links from the index.
    pub fn remove_note(&mut self, note: &NoteId) {
        // Remove forward links and clean up corresponding backlinks
        if let Some(targets) = self.forward.remove(note) {
            for target in &targets {
                if let Some(backs) = self.backward.get_mut(target) {
                    backs.retain(|b| b != note);
                }
            }
        }
        self.forward_raw.remove(note);
        // Also remove any backlinks pointing TO this note
        self.backward.remove(note);
    }

    /// Add a single raw wikilink from source. Call resolve_and_build_backlinks
    /// after all links are added to resolve them.
    pub fn add_link(&mut self, source: NoteId, target: String) {
        self.forward_raw
            .entry(source)
            .or_default()
            .push(target);
    }

    /// Re-resolve links for a single note and rebuild its backlinks.
    /// Call after updating forward_raw for that note.
    pub fn resolve_note_links(&mut self, note: &NoteId, all_paths: &[PathBuf]) {
        // Clear old resolved forward links and backlinks from this note
        if let Some(old_targets) = self.forward.remove(note) {
            for target in &old_targets {
                if let Some(backs) = self.backward.get_mut(target) {
                    backs.retain(|b| b != note);
                }
            }
        }

        // Resolve new links
        if let Some(raw_links) = self.forward_raw.get(note) {
            let stems = StemIndex::build(all_paths);
            let mut resolved = Vec::new();
            for link_target in raw_links {
                if let Some(target_path) = stems.resolve(link_target) {
                    resolved.push(target_path.clone());
                    self.backward
                        .entry(target_path)
                        .or_default()
                        .push(note.clone());
                }
            }
            self.forward.insert(note.clone(), resolved);
        }
    }
}

/// Lowercase-stem → paths map, built once per resolution batch so that
/// resolving L wikilinks against N notebox paths is O(N + L) instead of O(L·N).
struct StemIndex<'a> {
    by_stem: HashMap<String, Vec<&'a PathBuf>>,
}

impl<'a> StemIndex<'a> {
    fn build(all_paths: &'a [PathBuf]) -> Self {
        let mut by_stem: HashMap<String, Vec<&'a PathBuf>> = HashMap::new();
        for p in all_paths {
            if let Some(stem) = p.file_stem() {
                let key = stem.to_string_lossy().to_lowercase();
                by_stem.entry(key).or_default().push(p);
            }
        }
        Self { by_stem }
    }

    fn resolve(&self, target: &str) -> Option<PathBuf> {
        let target_name = target.split("::").next().unwrap_or(target);
        let target_name = target_name.split('#').next().unwrap_or(target_name).trim();
        if target_name.is_empty() {
            return None;
        }
        let key = target_name.to_lowercase();
        let candidates = self.by_stem.get(&key)?;
        // Shortest path wins (most specific match).
        candidates
            .iter()
            .min_by_key(|p| p.components().count())
            .map(|p| (*p).clone())
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn resolve(target: &str, paths: &[PathBuf]) -> Option<PathBuf> {
        StemIndex::build(paths).resolve(target)
    }

    #[test]
    fn test_resolve_wikilink_basic() {
        let paths = vec![
            PathBuf::from("/notebox/notes/Hello.typ"),
            PathBuf::from("/notebox/archive/Hello.typ"),
            PathBuf::from("/notebox/notes/World.typ"),
        ];

        assert_eq!(
            resolve("World", &paths),
            Some(PathBuf::from("/notebox/notes/World.typ"))
        );
        assert!(resolve("hello", &paths).is_some());
    }

    #[test]
    fn test_resolve_wikilink_with_heading() {
        let paths = vec![PathBuf::from("/notebox/notes/Note.typ")];
        assert_eq!(
            resolve("Note#heading", &paths),
            Some(PathBuf::from("/notebox/notes/Note.typ"))
        );
        assert_eq!(
            resolve("Note::heading", &paths),
            Some(PathBuf::from("/notebox/notes/Note.typ"))
        );
    }

    #[test]
    fn test_resolve_wikilink_not_found() {
        let paths = vec![PathBuf::from("/notebox/notes/Hello.typ")];
        assert_eq!(resolve("Missing", &paths), None);
    }

    #[test]
    fn test_resolve_wikilink_shortest_path_wins() {
        let paths = vec![
            PathBuf::from("/notebox/a/b/c/Note.typ"),
            PathBuf::from("/notebox/Note.typ"),
            PathBuf::from("/notebox/x/Note.typ"),
        ];
        assert_eq!(
            resolve("Note", &paths),
            Some(PathBuf::from("/notebox/Note.typ"))
        );
    }
}
