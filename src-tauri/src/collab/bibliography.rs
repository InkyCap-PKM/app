//! Union-by-key merge of the shared `.bib` file.
//!
//! A collaborative collection has exactly one bibliography, a real `.bib`
//! that travels in the package. Merging two of them is a union keyed by
//! citation key: a key present on only one side is taken; a key on both
//! sides with identical content is kept once; a key on both sides whose
//! content diverged is a conflict the user resolves.
//!
//! Both sides are parsed and re-emitted through `biblatex`'s own
//! serializer (the parser the rest of the app already uses). Normalizing
//! through one serializer is deliberate: two entries that are
//! semantically identical but formatted differently produce the same
//! string and hash-match, so they don't surface as spurious conflicts.
//! InkyCap owns the formatting of this managed file, so the normalization
//! is acceptable.

use std::collections::{BTreeMap, HashMap};

use biblatex::Bibliography;

use super::content_hash;

/// One parsed entry: its canonical serialized form and a content hash.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct BibEntryRecord {
    pub serialized: String,
    pub hash: String,
}

/// Which side wins a per-key content conflict.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ConflictChoice {
    KeepLocal,
    TakeIncoming,
}

/// Result of merging two `.bib` files.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct MergedBib {
    /// The unified BibTeX text, entries sorted by key for determinism.
    pub bibtex: String,
    /// `citation key -> content hash` for every entry in the result, to
    /// refresh the sidecar's bibliography section.
    pub hashes: BTreeMap<String, String>,
    /// Keys that conflicted (present on both sides, content diverged).
    pub conflicts: Vec<String>,
    /// Keys newly contributed by the incoming side.
    pub added: Vec<String>,
}

/// Parse a `.bib` string into `citation key -> record`. All
/// syntactically-valid entries are retained — unlike the picker path,
/// nothing is dropped for failing a downstream semantic conversion, so a
/// merge never loses an entry. A malformed file errors rather than
/// silently merging partial data.
pub fn parse_entries(bibtex: &str) -> Result<BTreeMap<String, BibEntryRecord>, String> {
    let bib = Bibliography::parse(bibtex).map_err(|e| format!("BibTeX parse error: {e}"))?;
    let mut map = BTreeMap::new();
    for entry in bib.iter() {
        let serialized = entry.to_biblatex_string();
        let hash = content_hash(&serialized);
        map.insert(entry.key.clone(), BibEntryRecord { serialized, hash });
    }
    Ok(map)
}

/// Merge `incoming` into `local` by citation key.
///
/// `choices` resolves content conflicts; a key not present in `choices`
/// defaults to keeping the local version (the conservative choice — never
/// overwrite our content without an explicit decision). Conflicts are
/// reported regardless of how they were resolved so the caller can record
/// them.
pub fn merge_bibtex(
    local: &str,
    incoming: &str,
    choices: &HashMap<String, ConflictChoice>,
) -> Result<MergedBib, String> {
    let local_entries = parse_entries(local)?;
    let incoming_entries = parse_entries(incoming)?;

    let mut chosen = local_entries.clone();
    let mut conflicts = Vec::new();
    let mut added = Vec::new();

    for (key, inc) in incoming_entries {
        match local_entries.get(&key) {
            None => {
                added.push(key.clone());
                chosen.insert(key, inc);
            }
            Some(loc) if loc.hash != inc.hash => {
                conflicts.push(key.clone());
                if matches!(choices.get(&key), Some(ConflictChoice::TakeIncoming)) {
                    chosen.insert(key, inc);
                }
                // else keep local — already present in `chosen`.
            }
            Some(_) => { /* identical — keep the single copy already present */ }
        }
    }

    // BTreeMap iterates by key, so emission is deterministic.
    let body = chosen
        .values()
        .map(|e| e.serialized.as_str())
        .collect::<Vec<_>>()
        .join("\n\n");
    let bibtex = if body.is_empty() {
        String::new()
    } else {
        format!("{body}\n")
    };
    let hashes = chosen
        .into_iter()
        .map(|(k, e)| (k, e.hash))
        .collect();

    Ok(MergedBib { bibtex, hashes, conflicts, added })
}

#[cfg(test)]
mod tests {
    use super::*;

    const SMITH: &str = "@article{smith2020, title = {Alpha}, author = {Smith, J.}, year = {2020}}";
    const JONES: &str = "@book{jones2019, title = {Beta}, author = {Jones, K.}, year = {2019}}";
    // Same key as SMITH but a different year — a content conflict.
    const SMITH_ALT: &str = "@article{smith2020, title = {Alpha}, author = {Smith, J.}, year = {2021}}";

    fn keys(map: &BTreeMap<String, BibEntryRecord>) -> Vec<String> {
        map.keys().cloned().collect()
    }

    #[test]
    fn parse_entries_keys_and_stable_hash() {
        let m = parse_entries(SMITH).unwrap();
        assert_eq!(keys(&m), vec!["smith2020".to_string()]);
        let again = parse_entries(SMITH).unwrap();
        assert_eq!(m["smith2020"].hash, again["smith2020"].hash);
        assert!(m["smith2020"].hash.starts_with("sha256:"));
    }

    #[test]
    fn parse_empty_is_ok_and_empty() {
        assert!(parse_entries("").unwrap().is_empty());
    }

    #[test]
    fn merge_disjoint_unions_all() {
        let r = merge_bibtex(SMITH, JONES, &HashMap::new()).unwrap();
        assert_eq!(r.added, vec!["jones2019".to_string()]);
        assert!(r.conflicts.is_empty());
        // Result re-parses and contains both keys.
        let reparsed = parse_entries(&r.bibtex).unwrap();
        assert_eq!(keys(&reparsed), vec!["jones2019".to_string(), "smith2020".to_string()]);
    }

    #[test]
    fn merge_identical_key_no_conflict_single_copy() {
        let r = merge_bibtex(SMITH, SMITH, &HashMap::new()).unwrap();
        assert!(r.conflicts.is_empty());
        assert!(r.added.is_empty());
        let reparsed = parse_entries(&r.bibtex).unwrap();
        assert_eq!(reparsed.len(), 1);
    }

    /// Serialized form of `key` after a merge — compares structurally
    /// rather than by fragile substring (the key `smith2020` itself
    /// contains "2020").
    fn merged_entry(bibtex: &str, key: &str) -> String {
        parse_entries(bibtex).unwrap()[key].serialized.clone()
    }

    #[test]
    fn merge_conflict_defaults_to_local() {
        let r = merge_bibtex(SMITH, SMITH_ALT, &HashMap::new()).unwrap();
        assert_eq!(r.conflicts, vec!["smith2020".to_string()]);
        // The local version is retained verbatim.
        let local_form = parse_entries(SMITH).unwrap()["smith2020"].serialized.clone();
        assert_eq!(merged_entry(&r.bibtex, "smith2020"), local_form);
    }

    #[test]
    fn merge_conflict_take_incoming_when_chosen() {
        let mut choices = HashMap::new();
        choices.insert("smith2020".to_string(), ConflictChoice::TakeIncoming);
        let r = merge_bibtex(SMITH, SMITH_ALT, &choices).unwrap();
        assert_eq!(r.conflicts, vec!["smith2020".to_string()]);
        let incoming_form = parse_entries(SMITH_ALT).unwrap()["smith2020"].serialized.clone();
        assert_eq!(merged_entry(&r.bibtex, "smith2020"), incoming_form);
    }

    #[test]
    fn merge_into_empty_local_adds_everything() {
        let r = merge_bibtex("", SMITH, &HashMap::new()).unwrap();
        assert_eq!(r.added, vec!["smith2020".to_string()]);
        assert!(r.hashes.contains_key("smith2020"));
    }

    #[test]
    fn malformed_bib_errors() {
        assert!(merge_bibtex("@@@ not valid {", SMITH, &HashMap::new()).is_err());
    }
}
