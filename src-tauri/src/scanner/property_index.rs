use std::collections::{HashMap, HashSet};
use std::path::PathBuf;

use crate::models::note::{NoteId, NoteMetadata, PropertyValue};

/// In-memory index of all note metadata, property keys, and tags.
pub struct PropertyIndex {
    pub notes: HashMap<NoteId, NoteMetadata>,
    pub property_keys: HashSet<String>,
    pub tags: HashMap<String, Vec<NoteId>>,
    /// Alias string → note paths that define it. Multiple notes may share
    /// an alias; the frontend disambiguates in the autocomplete UI.
    pub aliases: HashMap<String, Vec<NoteId>>,
}

impl PropertyIndex {
    pub fn new() -> Self {
        Self {
            notes: HashMap::new(),
            property_keys: HashSet::new(),
            tags: HashMap::new(),
            aliases: HashMap::new(),
        }
    }

    /// Build the index from a list of scanned notes.
    pub fn build(notes: Vec<NoteMetadata>) -> Self {
        let mut index = Self::new();

        for note in notes {
            let id: NoteId = note.path.clone();

            // Collect property keys
            for key in note.properties.keys() {
                if !key.starts_with("file.") {
                    index.property_keys.insert(key.clone());
                }
            }

            // Index tags
            for tag in &note.tags {
                index
                    .tags
                    .entry(tag.clone())
                    .or_default()
                    .push(id.clone());
            }

            // Index aliases
            for alias in Self::extract_aliases(&note) {
                index.aliases.entry(alias).or_default().push(id.clone());
            }

            index.notes.insert(id, note);
        }

        index
    }

    /// Update a single note in the index (for incremental re-indexing).
    pub fn update_note(&mut self, note: NoteMetadata) {
        let id: NoteId = note.path.clone();

        // Collect keys that the old version had but the new one doesn't —
        // these are candidates for removal from the global set.
        let mut lost_keys: Vec<String> = Vec::new();
        if let Some(old_note) = self.notes.get(&id) {
            for tag in &old_note.tags {
                if let Some(ids) = self.tags.get_mut(tag) {
                    ids.retain(|i| i != &id);
                }
            }
            // Remove old aliases
            for alias in Self::extract_aliases(old_note) {
                if let Some(ids) = self.aliases.get_mut(&alias) {
                    ids.retain(|i| i != &id);
                }
            }
            for key in old_note.properties.keys() {
                if !key.starts_with("file.") && !note.properties.contains_key(key) {
                    lost_keys.push(key.clone());
                }
            }
        }

        // Collect property keys
        for key in note.properties.keys() {
            if !key.starts_with("file.") {
                self.property_keys.insert(key.clone());
            }
        }

        // Re-index tags
        for tag in &note.tags {
            self.tags.entry(tag.clone()).or_default().push(id.clone());
        }

        // Re-index aliases
        for alias in Self::extract_aliases(&note) {
            self.aliases.entry(alias).or_default().push(id.clone());
        }

        self.notes.insert(id, note);

        self.tags.retain(|_, ids| !ids.is_empty());
        self.aliases.retain(|_, ids| !ids.is_empty());

        // Remove lost keys only if no other note still uses them
        for key in lost_keys {
            let still_used = self.notes.values().any(|n| n.properties.contains_key(&key));
            if !still_used {
                self.property_keys.remove(&key);
            }
        }
    }

    /// Remove a note from the index.
    pub fn remove_note(&mut self, path: &PathBuf) {
        if let Some(note) = self.notes.remove(path) {
            for tag in &note.tags {
                if let Some(ids) = self.tags.get_mut(tag) {
                    ids.retain(|i| i != path);
                }
            }
            for alias in Self::extract_aliases(&note) {
                if let Some(ids) = self.aliases.get_mut(&alias) {
                    ids.retain(|i| i != path);
                }
            }
            self.tags.retain(|_, ids| !ids.is_empty());
            self.aliases.retain(|_, ids| !ids.is_empty());

            for key in note.properties.keys() {
                if !key.starts_with("file.") {
                    let still_used = self.notes.values().any(|n| n.properties.contains_key(key));
                    if !still_used {
                        self.property_keys.remove(key);
                    }
                }
            }
        }
    }

    /// Extract alias strings from a note's `aliases` property.
    fn extract_aliases(note: &NoteMetadata) -> Vec<String> {
        let Some(val) = note.properties.get("aliases") else {
            return Vec::new();
        };
        match val {
            PropertyValue::List(items) => items
                .iter()
                .filter_map(|item| {
                    if let PropertyValue::String(s) = item {
                        if !s.is_empty() { Some(s.clone()) } else { None }
                    } else {
                        None
                    }
                })
                .collect(),
            PropertyValue::String(s) if !s.is_empty() => vec![s.clone()],
            _ => Vec::new(),
        }
    }

    /// Iterate aliases by reference so callers can serialize without
    /// first materializing a clone of the whole index.
    pub fn aliases_iter(&self) -> impl Iterator<Item = (&str, &[NoteId])> {
        self.aliases.iter().map(|(k, v)| (k.as_str(), v.as_slice()))
    }

    pub fn note_count(&self) -> usize {
        self.notes.len()
    }

    /// Get tags for a file (used by search engine for index updates).
    pub fn get_tags_for_file(&self, path: &std::path::Path) -> Vec<String> {
        self.notes
            .get(path)
            .map(|n| n.tags.clone())
            .unwrap_or_default()
    }

    /// Get the title property for a file (used by search engine for scoring).
    pub fn get_title_for_file(&self, path: &std::path::Path) -> Option<String> {
        self.notes.get(path).and_then(|n| {
            n.properties.get("title").and_then(|v| {
                if let crate::models::note::PropertyValue::String(s) = v {
                    Some(s.clone())
                } else {
                    None
                }
            })
        })
    }

    /// Get all tags with their counts (used by tag autocomplete).
    pub fn all_tags_sorted(&self) -> Vec<(String, usize)> {
        let mut tags: Vec<(String, usize)> = self
            .tags
            .iter()
            .map(|(tag, ids)| (tag.clone(), ids.len()))
            .collect();
        tags.sort_by(|a, b| b.1.cmp(&a.1).then(a.0.cmp(&b.0)));
        tags
    }
}
