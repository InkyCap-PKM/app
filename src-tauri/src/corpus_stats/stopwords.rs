//! Stopwords for corpus statistics, in three layers:
//!
//! 1. Built-in English and French stopwords. Markup keywords aren't filtered (see
//!    the note below).
//! 2. The user's stopwords (<notebox>/.inkycap/mycelial-stopwords.txt).
//! 3. The user dictionary (<notebox>/.inkycap/dictionary.txt), whose words are
//!    always included.
//!
//! EN/FR lists from stopwords-iso (MIT): https://github.com/stopwords-iso

use std::collections::HashSet;
use std::path::Path;

use super::stopwords_data::{STOPWORDS_EN, STOPWORDS_FR};

// There's no list of Typst keywords to filter: the corpus comes from
// `search::text_projection`, which emits only the text of the parsed note, so
// `#set`, `#show` and the like never appear as markup. Such a list would only
// drop the ordinary words ("the mental state", "body text"), and users can add
// their own in `mycelial-stopwords.txt`.

/// Build the full stopword set from the built-in lists and user files. Words in
/// the user dictionary are removed from it, even if in a built-in list.
pub fn build_stopwords(notebox_root: Option<&Path>) -> HashSet<String> {
    let mut set = HashSet::with_capacity(STOPWORDS_EN.len() + STOPWORDS_FR.len());

    for &w in STOPWORDS_EN {
        set.insert(w.to_owned());
    }
    for &w in STOPWORDS_FR {
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

/// Whether `word` (already lowercase) is in a built-in list (EN/FR). Used to
/// tell the user how to include a filtered Mycelial term: a built-in stopword
/// is added to `dictionary.txt`, a user stopword is removed from
/// `mycelial-stopwords.txt`.
pub fn is_builtin_stopword(word: &str) -> bool {
    STOPWORDS_EN.contains(&word) || STOPWORDS_FR.contains(&word)
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
