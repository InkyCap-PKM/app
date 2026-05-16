//! Layered stopword system for the corpus statistics engine.
//!
//! Three layers:
//! 1. Built-in English + French + Typst structural (embedded const arrays)
//! 2. User custom stopwords (<notebox>/.inkycap/mycelial-stopwords.txt)
//! 3. User dictionary (<notebox>/.inkycap/dictionary.txt) — force-includes
//!
//! Source for EN/FR lists: stopwords-iso (MIT) — https://github.com/stopwords-iso

use std::collections::HashSet;
use std::path::Path;

use super::stopwords_data::{STOPWORDS_EN, STOPWORDS_FR};

const STOPWORDS_TYPST: &[&str] = &[
    "auto",
    "bibliography",
    "block",
    "body",
    "calc",
    "content",
    "context",
    "document",
    "figure",
    "heading",
    "import",
    "include",
    "let",
    "none",
    "outline",
    "page",
    "par",
    "set",
    "show",
    "state",
    "table",
    "text",
];

/// Build the complete stopword set from built-in lists + user files.
///
/// The user dictionary overrides stopwords — any word in the dictionary
/// is removed from the exclusion set even if it appears in a built-in list.
pub fn build_stopwords(notebox_root: Option<&Path>) -> HashSet<String> {
    let mut set =
        HashSet::with_capacity(STOPWORDS_EN.len() + STOPWORDS_FR.len() + STOPWORDS_TYPST.len());

    for &w in STOPWORDS_EN {
        set.insert(w.to_owned());
    }
    for &w in STOPWORDS_FR {
        set.insert(w.to_owned());
    }
    for &w in STOPWORDS_TYPST {
        set.insert(w.to_owned());
    }

    if let Some(root) = notebox_root {
        load_user_stopwords_into(&mut set, root);
        remove_dictionary_entries(&mut set, root);
    }

    set
}

fn load_user_stopwords_into(set: &mut HashSet<String>, notebox_root: &Path) {
    let path = notebox_root.join(".inkycap").join("mycelial-stopwords.txt");
    let Ok(contents) = std::fs::read_to_string(&path) else {
        return;
    };
    for line in contents.lines() {
        let trimmed = line.trim();
        if trimmed.is_empty() || trimmed.starts_with('#') {
            continue;
        }
        set.insert(trimmed.to_lowercase());
    }
}

fn remove_dictionary_entries(set: &mut HashSet<String>, notebox_root: &Path) {
    let path = notebox_root.join(".inkycap").join("dictionary.txt");
    let Ok(contents) = std::fs::read_to_string(&path) else {
        return;
    };
    for line in contents.lines() {
        let trimmed = line.trim();
        if trimmed.is_empty() || trimmed.starts_with('#') {
            continue;
        }
        set.remove(&trimmed.to_lowercase());
    }
}

/// Load only the user dictionary entries (for future spell-check use).
pub fn load_user_dictionary(notebox_root: &Path) -> HashSet<String> {
    let mut dict = HashSet::new();
    let path = notebox_root.join(".inkycap").join("dictionary.txt");
    let Ok(contents) = std::fs::read_to_string(&path) else {
        return dict;
    };
    for line in contents.lines() {
        let trimmed = line.trim();
        if trimmed.is_empty() || trimmed.starts_with('#') {
            continue;
        }
        dict.insert(trimmed.to_lowercase());
    }
    dict
}
