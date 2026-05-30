//! Layered stopword system for the corpus statistics engine.
//!
//! Three layers:
//! 1. Built-in English + French natural-language stopwords (embedded consts).
//!    Markup keywords are NOT filtered here — see the note below build_stopwords.
//! 2. User custom stopwords (<notebox>/.inkycap/mycelial-stopwords.txt)
//! 3. User dictionary (<notebox>/.inkycap/dictionary.txt) — force-includes
//!
//! Source for EN/FR lists: stopwords-iso (MIT) — https://github.com/stopwords-iso

use std::collections::HashSet;
use std::path::Path;

use super::stopwords_data::{STOPWORDS_EN, STOPWORDS_FR};

// There is deliberately no built-in Typst-keyword denylist. Such a list once
// lived here ("set", "show", "page", "state", "table", "text", …) to suppress
// markup tokens, but the corpus is built from `search::text_projection`, which
// walks the parsed Typst AST and emits only `Text` leaves — `#set`, `#show`,
// `#state(...)` and friends never reach the token stream *as markup* in the
// first place. The denylist therefore only ever filtered the *prose* senses of
// those words ("the mental state", "body text", "the next page"), silently
// dropping legitimate concepts from the Mycelial View with no way for the user
// to tell. Trusting the parser we already run (Typst-first) is both simpler and
// correct; per-notebox over-filtering is still available via
// `mycelial-stopwords.txt`.

/// Build the complete stopword set from built-in lists + user files.
///
/// The user dictionary overrides stopwords — any word in the dictionary
/// is removed from the exclusion set even if it appears in a built-in list.
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

/// True when `word` is in one of the bundled built-in stopword lists (EN/FR).
/// Used to attribute a suppressed Mycelial term to the layer that filtered it:
/// a built-in stopword is rescued by force-including it via `dictionary.txt`,
/// whereas a user-added stopword is rescued by removing its line from
/// `mycelial-stopwords.txt`. `word` is expected pre-lowercased (corpus form).
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
