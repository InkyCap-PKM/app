// ---------------------------------------------------------------------------
// Why link resolution lives in Rust, not Typst
// ---------------------------------------------------------------------------
//
// Per CLAUDE.md's Typst-first principle, we use `typst query` to *extract*
// outgoing wikilinks from each note (via `<inkycap-link>` metadata in the
// vault package — see `inkycap-vault/0.1.0/lib.typ`). What Typst cannot do
// is *resolve* a wikilink target string like `"Reading notes"` to an actual
// file path on disk: that resolution is vault-specific (filename matching,
// disambiguation, alias lookup) and Typst has no view of the vault as a
// whole, only the file currently being compiled.
//
// So the split is deliberate and idiomatic: extraction is native (Typst
// knows the source), resolution is Rust-side (Rust knows the vault).
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

        for (source, raw_links) in &self.forward_raw {
            let mut resolved = Vec::new();
            for link_target in raw_links {
                if let Some(target_path) = resolve_wikilink(link_target, all_paths) {
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
            let mut resolved = Vec::new();
            for link_target in raw_links {
                if let Some(target_path) = resolve_wikilink(link_target, all_paths) {
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

/// Resolve a wikilink target string to a file path.
/// Matches by filename stem, case-insensitive.
/// If there are multiple matches, prefer the shortest path.
fn resolve_wikilink(target: &str, all_paths: &[PathBuf]) -> Option<PathBuf> {
    // Strip heading/block references: note#heading or note::heading -> note
    let target_name = target.split("::").next().unwrap_or(target);
    let target_name = target_name.split('#').next().unwrap_or(target_name).trim();
    if target_name.is_empty() {
        return None;
    }

    let target_lower = target_name.to_lowercase();

    let mut matches: Vec<&PathBuf> = all_paths
        .iter()
        .filter(|p| {
            p.file_stem()
                .map(|s| s.to_string_lossy().to_lowercase() == target_lower)
                .unwrap_or(false)
        })
        .collect();

    if matches.is_empty() {
        return None;
    }

    // Shortest path wins (most specific match)
    matches.sort_by_key(|p| p.components().count());
    Some(matches[0].clone())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_resolve_wikilink_basic() {
        let paths = vec![
            PathBuf::from("/vault/notes/Hello.typ"),
            PathBuf::from("/vault/archive/Hello.typ"),
            PathBuf::from("/vault/notes/World.typ"),
        ];

        // Should find World.typ
        let result = resolve_wikilink("World", &paths);
        assert_eq!(result, Some(PathBuf::from("/vault/notes/World.typ")));

        // Case insensitive
        let result = resolve_wikilink("hello", &paths);
        assert!(result.is_some());
    }

    #[test]
    fn test_resolve_wikilink_with_heading() {
        let paths = vec![PathBuf::from("/vault/notes/Note.typ")];
        let result = resolve_wikilink("Note#heading", &paths);
        assert_eq!(result, Some(PathBuf::from("/vault/notes/Note.typ")));
    }

    #[test]
    fn test_resolve_wikilink_not_found() {
        let paths = vec![PathBuf::from("/vault/notes/Hello.typ")];
        let result = resolve_wikilink("Missing", &paths);
        assert_eq!(result, None);
    }
}
