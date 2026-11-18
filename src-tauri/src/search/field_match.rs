// How the values of search filters (`tag:`, `file:`, `path:`, …) match. Each
// filter is a field search with the same rules as a plain search term: case is
// ignored, `*` stands for any run of characters, and nothing else is special.
// Names (a tag, a collection, a property key, a folder) match whole; text (a
// file name, a heading, a property value, an annotation) matches whole words,
// and several words match as a phrase.

use regex::Regex;

use crate::search::text_projection::{is_word_char, word_boundaries};

/// Compile a search pattern with a size limit, since patterns can come from
/// shared queries. The `regex` crate doesn't backtrack, so size is the only
/// risk. `None` for invalid or oversized patterns, which match nothing.
pub(crate) fn compile_bounded_regex(pattern: &str) -> Option<Regex> {
    const SIZE_LIMIT: usize = 1 << 20; // 1 MiB compiled program
    const DFA_SIZE_LIMIT: usize = 1 << 20; // 1 MiB lazy-DFA cache
    regex::RegexBuilder::new(pattern)
        .size_limit(SIZE_LIMIT)
        .dfa_size_limit(DFA_SIZE_LIMIT)
        .build()
        .ok()
}

/// A whole name, with `*` for any run of characters: `draft` matches only
/// `draft`; `draft*` also matches `drafts` and `draft_old`.
pub(crate) enum NameMatcher {
    Exact(String),
    Pattern(Regex),
    /// A pattern too large to compile matches nothing.
    Nothing,
}

impl NameMatcher {
    /// `value` must already be lowercased; names are compared lowercased.
    pub(crate) fn new(value: &str) -> Self {
        if !value.contains('*') {
            return Self::Exact(value.to_string());
        }
        // Escape everything but the `*`s, so a name such as `c++` or `v1.2`
        // matches literally.
        let pieces: Vec<String> = value.split('*').map(regex::escape).collect();
        match compile_bounded_regex(&format!("^{}$", pieces.join(".*"))) {
            Some(re) => Self::Pattern(re),
            None => Self::Nothing,
        }
    }

    /// `name` must already be lowercased.
    pub(crate) fn matches(&self, name: &str) -> bool {
        match self {
            Self::Exact(value) => name == value,
            Self::Pattern(re) => re.is_match(name),
            Self::Nothing => false,
        }
    }
}

/// Whole words of a text, using the body index's word rules: `meet` matches
/// "Meeting notes" only as `meet*`, and `research methods` matches those two
/// words side by side.
pub(crate) struct WordsMatcher {
    words: Vec<NameMatcher>,
}

impl WordsMatcher {
    /// `value` must already be lowercased. A value with no words in it (only
    /// punctuation) matches nothing.
    pub(crate) fn new(value: &str) -> Self {
        let words = value
            .split(|c: char| !(is_word_char(c) || c == '*'))
            .filter(|w| !w.is_empty())
            .map(NameMatcher::new)
            .collect();
        Self { words }
    }

    /// Whether the words occur, in order and side by side, in `text`.
    pub(crate) fn matches(&self, text: &str) -> bool {
        if self.words.is_empty() {
            return false;
        }
        let found: Vec<String> = word_boundaries(text)
            .into_iter()
            .map(|(_, word)| word.to_lowercase())
            .collect();
        found
            .windows(self.words.len())
            .any(|run| run.iter().zip(&self.words).all(|(word, m)| m.matches(word)))
    }
}

/// A chain of whole folder names, at any depth: `journal` matches a folder
/// named "Journal" anywhere, `reading notes/2026` that folder inside "Reading
/// Notes". A leading `/` anchors the chain at the notebox root, as `/` does in
/// a Typst path. A trailing `/` changes nothing. Either separator is accepted.
pub(crate) struct FolderMatcher {
    anchored: bool,
    folders: Vec<NameMatcher>,
}

impl FolderMatcher {
    /// `value` must already be lowercased.
    pub(crate) fn new(value: &str) -> Self {
        let value = value.replace('\\', "/");
        let anchored = value.starts_with('/');
        let folders = value
            .split('/')
            .map(str::trim)
            .filter(|f| !f.is_empty())
            .map(NameMatcher::new)
            .collect();
        Self { anchored, folders }
    }

    /// Whether the chain matches `folders`, a note's lowercased folder names
    /// from the notebox root down. `path:/` (no names) matches every note.
    pub(crate) fn matches(&self, folders: &[String]) -> bool {
        let n = self.folders.len();
        let chain_at =
            |start: &[String]| start.iter().zip(&self.folders).all(|(f, m)| m.matches(f));
        if self.anchored {
            folders.len() >= n && chain_at(&folders[..n])
        } else if n == 0 {
            true
        } else {
            folders.windows(n).any(chain_at)
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn folders(path: &str) -> Vec<String> {
        path.split('/').map(str::to_string).collect()
    }

    #[test]
    fn a_name_matches_whole_unless_given_a_wildcard() {
        assert!(NameMatcher::new("rwlgd").matches("rwlgd"));
        assert!(!NameMatcher::new("rwlgd").matches("rwlgd_source"));
        assert!(NameMatcher::new("rwlgd*").matches("rwlgd_source"));
        assert!(NameMatcher::new("*source").matches("rwlgd_source"));
        assert!(NameMatcher::new("r*d").matches("rwlgd"));
        // Only `*` is special.
        assert!(NameMatcher::new("v1.*").matches("v1.2"));
        assert!(!NameMatcher::new("v1.*").matches("v1x2"));
        assert!(NameMatcher::new("c++").matches("c++"));
    }

    #[test]
    fn text_matches_whole_words_and_phrases() {
        let heading = "research methods and sources";
        assert!(WordsMatcher::new("methods").matches(heading));
        assert!(!WordsMatcher::new("method").matches(heading));
        assert!(WordsMatcher::new("method*").matches(heading));
        assert!(WordsMatcher::new("research methods").matches(heading));
        assert!(!WordsMatcher::new("methods research").matches(heading));
        assert!(!WordsMatcher::new("research sources").matches(heading));
        // Hyphens join a word, as in body text.
        assert!(!WordsMatcher::new("2026").matches("2026-03-01 meeting"));
        assert!(WordsMatcher::new("2026*").matches("2026-03-01 meeting"));
        assert!(!WordsMatcher::new("&").matches("a & b"));
    }

    #[test]
    fn folders_match_as_a_chain_of_whole_names() {
        let note = folders("projects/reading notes/2026");
        assert!(FolderMatcher::new("reading notes").matches(&note));
        assert!(FolderMatcher::new("reading notes/2026/").matches(&note));
        assert!(!FolderMatcher::new("reading").matches(&note));
        assert!(FolderMatcher::new("read*").matches(&note));
        assert!(!FolderMatcher::new("projects/2026").matches(&note));
        assert!(FolderMatcher::new("\\projects\\reading notes").matches(&note));
        // A leading `/` anchors at the notebox root.
        assert!(FolderMatcher::new("/projects").matches(&note));
        assert!(!FolderMatcher::new("/reading notes").matches(&note));
        assert!(FolderMatcher::new("/").matches(&note));
        assert!(FolderMatcher::new("/").matches(&[]));
        assert!(!FolderMatcher::new("projects").matches(&[]));
    }
}
