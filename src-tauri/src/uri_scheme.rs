//! Parsing `inkycap://` links into checked requests.
//!
//! Other apps, scripts and web pages can open a note in InkyCap with a link:
//!
//! ```text
//! inkycap://open?notebox=Professional&file=1%20Ephemera%2FTestpad.typ
//! inkycap://open?notebox=Professional&zid=20260916T0930&heading=Method
//! inkycap://search?notebox=Professional&query=hydrology
//! ```
//!
//! Anything on the machine can send one of these, so every part of the link is
//! treated as hostile. [`parse`] accepts only the two verbs below with their
//! required parameters, and rejects any `file` value that could point outside
//! the notebox (absolute paths, drive letters, `..` segments) or at anything
//! other than a note or a collection. A collection is named by its path inside
//! the notebox's collections folder (`.inkycap/collections/`), the one place
//! collections live, so `file=Reading%20list.collection` finds
//! `.inkycap/collections/Reading list.collection`. A rejected link yields `None`: it is
//! ignored without telling the user, since a malformed link is not theirs to
//! fix. Finding the notebox and the file on disk is the job of
//! [`crate::deep_link`], which works only from what this module returns.
//!
//! The link builder on the frontend is `src/lib/inkycap-url.ts`; the tests
//! at the bottom of both files use the same example links.

use tauri::Url;

/// The URL scheme InkyCap registers with the operating system. Also declared
/// under `plugins.deep-link.desktop.schemes` in `tauri.conf.json`.
pub const SCHEME: &str = "inkycap";

/// Longest link accepted, in bytes. Real links are a few hundred bytes.
const MAX_URL_LEN: usize = 8 * 1024;
const MAX_NOTEBOX_LEN: usize = 256;
const MAX_FILE_LEN: usize = 1024;
const MAX_ZID_LEN: usize = 128;
const MAX_HEADING_LEN: usize = 512;
const MAX_QUERY_LEN: usize = 1024;

/// Extension of a note, which a link names by its path from the notebox root.
const NOTE_EXTENSION: &str = "typ";
/// Extension of a collection, which a link names by its path inside the
/// collections folder.
const COLLECTION_EXTENSION: &str = "collection";

/// A checked request from an `inkycap://` link.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Request {
    /// Open a note or collection, optionally scrolled to a heading or label.
    Open {
        notebox: String,
        target: Target,
        heading: Option<String>,
    },
    /// Run a search in the notebox's search panel.
    Search { notebox: String, query: String },
}

impl Request {
    /// The notebox display name the link asks for.
    pub fn notebox(&self) -> &str {
        match self {
            Request::Open { notebox, .. } | Request::Search { notebox, .. } => notebox,
        }
    }
}

/// What an `open` link points at.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Target {
    /// A path relative to the notebox root, as checked segments.
    File(RelativePath),
    /// A note's `zid` property.
    Zid(String),
}

/// A notebox-relative path from a link, split into segments that are known
/// to be plain names: no empty, `.` or `..` segments, no separators, no drive
/// prefix. Joining them onto the notebox root cannot leave it except through a
/// symlink, which [`crate::deep_link`] checks after resolving.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct RelativePath {
    segments: Vec<String>,
}

impl RelativePath {
    /// The path's segments, in order.
    pub fn segments(&self) -> &[String] {
        &self.segments
    }

    /// The files this path may name, relative to the notebox root, in the
    /// order to try them: the note as written, or for a `.collection` name the
    /// collection in the collections folder, then the path with `.typ` added
    /// (so `file=Testpad` finds `Testpad.typ`). Nothing else is ever opened by
    /// a link: another kind of file would be handed to another program and
    /// could run something.
    pub fn candidates(&self) -> Vec<RelativePath> {
        let mut out = Vec::new();
        let name = self.segments.last().map(String::as_str).unwrap_or_default();
        if has_extension(name, NOTE_EXTENSION) {
            out.push(self.clone());
        } else if has_extension(name, COLLECTION_EXTENSION) {
            let segments = crate::notebox_package::collections_relpath()
                .split('/')
                .map(str::to_string)
                .chain(self.segments.iter().cloned())
                .collect();
            out.push(RelativePath { segments });
        }
        if !name.to_ascii_lowercase().ends_with(".typ") {
            let mut segments = self.segments.clone();
            if let Some(last) = segments.last_mut() {
                last.push_str(".typ");
            }
            out.push(RelativePath { segments });
        }
        out
    }
}

/// Whether a file name has a non-empty stem and the extension `wanted`.
fn has_extension(name: &str, wanted: &str) -> bool {
    name.rsplit_once('.')
        .is_some_and(|(stem, ext)| !stem.is_empty() && ext.eq_ignore_ascii_case(wanted))
}

/// Parse an `inkycap://` link. Returns `None` for anything that is not a
/// well-formed link this version understands.
pub fn parse(url: &str) -> Option<Request> {
    if url.len() > MAX_URL_LEN {
        return None;
    }
    let url = Url::parse(url.trim()).ok()?;
    if !url.scheme().eq_ignore_ascii_case(SCHEME) {
        return None;
    }
    // `inkycap://open?…` puts the verb where a host would be. A path, a port
    // or credentials mean the link was not built for this scheme.
    if !matches!(url.path(), "" | "/")
        || url.port().is_some()
        || !url.username().is_empty()
        || url.password().is_some()
    {
        return None;
    }
    let verb = url.host_str()?.to_ascii_lowercase();
    let params = Params::from_url(&url)?;

    let notebox = params.text("notebox", MAX_NOTEBOX_LEN)??;
    match verb.as_str() {
        "open" => {
            let heading = params.text("heading", MAX_HEADING_LEN)?;
            // `zid` wins when both are given: it survives renames and moves.
            let target = match params.text("zid", MAX_ZID_LEN)? {
                Some(zid) => Target::Zid(zid),
                None => {
                    let file = params.get("file")?;
                    Target::File(parse_relative_path(file?)?)
                }
            };
            Some(Request::Open {
                notebox,
                target,
                heading,
            })
        }
        "search" => {
            let query = params.text("query", MAX_QUERY_LEN)??;
            Some(Request::Search { notebox, query })
        }
        _ => None,
    }
}

/// A link's decoded query parameters. A name given twice makes the whole link
/// invalid, since the two values could disagree about what to open.
struct Params(Vec<(String, String)>);

impl Params {
    fn from_url(url: &Url) -> Option<Params> {
        let mut pairs: Vec<(String, String)> = Vec::new();
        for (name, value) in url.query_pairs() {
            if pairs.iter().any(|(seen, _)| *seen == name) {
                return None;
            }
            pairs.push((name.into_owned(), value.into_owned()));
        }
        Some(Params(pairs))
    }

    /// The raw value of `name`: `Some(None)` when absent, `None` when present
    /// but empty (an empty value is as good as a malformed one).
    fn get(&self, name: &str) -> Option<Option<&str>> {
        match self.0.iter().find(|(n, _)| n == name) {
            None => Some(None),
            Some((_, value)) if value.is_empty() => None,
            Some((_, value)) => Some(Some(value.as_str())),
        }
    }

    /// A trimmed, single-line text value of at most `max_len` bytes. Same
    /// `Option<Option<_>>` meaning as [`Params::get`].
    fn text(&self, name: &str, max_len: usize) -> Option<Option<String>> {
        let Some(value) = self.get(name)? else {
            return Some(None);
        };
        let value = value.trim();
        if value.is_empty() || value.len() > max_len || value.chars().any(char::is_control) {
            return None;
        }
        Some(Some(value.to_string()))
    }
}

/// Check a `file` value and split it into segments. The value must be a
/// relative, `/`-separated path inside the notebox; which files it may then
/// open is decided by [`RelativePath::candidates`].
fn parse_relative_path(file: &str) -> Option<RelativePath> {
    if file.len() > MAX_FILE_LEN || file.chars().any(char::is_control) {
        return None;
    }
    // Backslashes are separators on Windows, and a drive prefix (`C:`) makes a
    // path absolute there even without a leading separator.
    if file.contains('\\') || has_drive_prefix(file) {
        return None;
    }
    let mut segments = Vec::new();
    for segment in file.split('/') {
        // Also rejects a leading `/` (absolute), `//` (UNC), and a trailing `/`.
        if segment.is_empty() || segment == "." || segment == ".." {
            return None;
        }
        segments.push(segment.to_string());
    }
    // Nothing in the notebox's own configuration folder is named from the
    // root; collections there are named from the collections folder.
    if segments[0].eq_ignore_ascii_case(".inkycap") {
        return None;
    }
    Some(RelativePath { segments })
}

/// `C:` and the like at the start of a path.
fn has_drive_prefix(path: &str) -> bool {
    let mut chars = path.chars();
    matches!(
        (chars.next(), chars.next()),
        (Some(letter), Some(':')) if letter.is_ascii_alphabetic()
    )
}

#[cfg(test)]
mod tests {
    use super::*;

    fn file(path: &str) -> Target {
        Target::File(RelativePath {
            segments: path.split('/').map(str::to_string).collect(),
        })
    }

    fn open(notebox: &str, target: Target, heading: Option<&str>) -> Option<Request> {
        Some(Request::Open {
            notebox: notebox.into(),
            target,
            heading: heading.map(str::to_string),
        })
    }

    // The same links are produced by the builder tests in
    // src/lib/inkycap-url.test.ts, so a change to either side shows up here.

    #[test]
    fn opens_a_note_in_a_nested_folder() {
        assert_eq!(
            parse("inkycap://open?notebox=Professional&file=1%20Ephemera%2FTestpad.typ"),
            open("Professional", file("1 Ephemera/Testpad.typ"), None)
        );
    }

    #[test]
    fn opens_a_collection() {
        assert_eq!(
            parse("inkycap://open?notebox=Professional&file=Reading%20list.collection"),
            open("Professional", file("Reading list.collection"), None)
        );
    }

    #[test]
    fn opens_by_zid() {
        assert_eq!(
            parse("inkycap://open?notebox=Professional&zid=20260916T0930"),
            open("Professional", Target::Zid("20260916T0930".into()), None)
        );
    }

    #[test]
    fn carries_a_heading() {
        assert_eq!(
            parse("inkycap://open?notebox=Professional&file=Testpad.typ&heading=Method"),
            open("Professional", file("Testpad.typ"), Some("Method"))
        );
    }

    #[test]
    fn searches() {
        assert_eq!(
            parse("inkycap://search?notebox=Professional&query=hydrology"),
            Some(Request::Search {
                notebox: "Professional".into(),
                query: "hydrology".into(),
            })
        );
    }

    #[test]
    fn decodes_accents_and_reserved_characters() {
        assert_eq!(
            parse(
                "inkycap://open?notebox=Carnet%20d%E2%80%99%C3%A9t%C3%A9\
                 &file=R%C3%A9sum%C3%A9s%2FNotes%20%231%20%26%20100%25%20%2B%20plus.typ"
            ),
            open(
                "Carnet d’été",
                file("Résumés/Notes #1 & 100% + plus.typ"),
                None
            )
        );
    }

    #[test]
    fn zid_wins_over_file() {
        assert_eq!(
            parse("inkycap://open?notebox=N&file=Testpad.typ&zid=Z1"),
            open("N", Target::Zid("Z1".into()), None)
        );
    }

    #[test]
    fn accepts_a_name_without_extension() {
        assert_eq!(
            parse("inkycap://open?notebox=N&file=Testpad"),
            open("N", file("Testpad"), None)
        );
    }

    #[test]
    fn verb_and_scheme_are_case_insensitive() {
        assert_eq!(
            parse("InkyCap://OPEN?notebox=N&file=a.typ"),
            open("N", file("a.typ"), None)
        );
    }

    #[test]
    fn ignores_unknown_parameters() {
        assert_eq!(
            parse("inkycap://open?notebox=N&file=a.typ&future=1"),
            open("N", file("a.typ"), None)
        );
    }

    #[test]
    fn ignores_unknown_verbs_and_missing_parameters() {
        for url in [
            "inkycap://delete?notebox=N&file=a.typ",
            "inkycap://open?file=a.typ",
            "inkycap://open?notebox=N",
            "inkycap://open?notebox=&file=a.typ",
            "inkycap://open?notebox=N&file=",
            "inkycap://search?notebox=N",
            "inkycap://search?notebox=N&query=%20%20",
            "inkycap://?notebox=N&file=a.typ",
            "inkycap:open?notebox=N&file=a.typ",
            "https://open?notebox=N&file=a.typ",
            "not a url",
        ] {
            assert_eq!(parse(url), None, "{url}");
        }
    }

    #[test]
    fn rejects_paths_that_could_leave_the_notebox() {
        for value in [
            "..%2F..%2Fetc%2Fpasswd",
            "../../etc/passwd",
            "a%2F..%2F..%2Fb.typ",
            "%2Fetc%2Fpasswd.typ",
            "%2F%2Fserver%2Fshare%2Fa.typ",
            "C%3A%2FUsers%2Fa.typ",
            "C%3Aa.typ",
            "a%5C..%5Cb.typ",
            "%5C%5Cserver%5Cshare%5Ca.typ",
            ".%2Fa.typ",
            "a%2F%2Fb.typ",
            "folder%2F",
            ".inkycap%2Fsettings.typ",
            "a%00.typ",
            "a%0A.typ",
        ] {
            let url = format!("inkycap://open?notebox=N&file={value}");
            assert_eq!(parse(&url), None, "{url}");
        }
    }

    fn candidates(url: &str) -> Vec<String> {
        let Some(Request::Open {
            target: Target::File(path),
            ..
        }) = parse(url)
        else {
            panic!("expected a file link: {url}");
        };
        path.candidates()
            .iter()
            .map(|c| c.segments().join("/"))
            .collect()
    }

    #[test]
    fn a_note_or_collection_is_tried_as_written() {
        assert_eq!(
            candidates("inkycap://open?notebox=N&file=a%2Fb.typ"),
            ["a/b.typ"]
        );
        assert_eq!(candidates("inkycap://open?notebox=N&file=b.TYP"), ["b.TYP"]);
    }

    #[test]
    fn a_collection_is_looked_up_in_the_collections_folder() {
        assert_eq!(
            candidates("inkycap://open?notebox=N&file=b.collection"),
            [".inkycap/collections/b.collection", "b.collection.typ"]
        );
        assert_eq!(
            candidates("inkycap://open?notebox=N&file=Reading%2Fb.Collection"),
            [
                ".inkycap/collections/Reading/b.Collection",
                "Reading/b.Collection.typ"
            ]
        );
    }

    #[test]
    fn a_name_without_extension_is_tried_as_a_note() {
        assert_eq!(
            candidates("inkycap://open?notebox=N&file=a%2Fb"),
            ["a/b.typ"]
        );
        assert_eq!(
            candidates("inkycap://open?notebox=N&file=Dr.%20Smith"),
            ["Dr. Smith.typ"]
        );
    }

    #[test]
    fn other_files_are_never_candidates() {
        for (value, only) in [
            ("run.sh", "run.sh.typ"),
            ("setup.exe", "setup.exe.typ"),
            ("report.pdf", "report.pdf.typ"),
            (".collection", ".collection.typ"),
        ] {
            let url = format!("inkycap://open?notebox=N&file={value}");
            assert_eq!(candidates(&url), [only], "{url}");
        }
    }

    #[test]
    fn rejects_repeated_parameters() {
        assert_eq!(
            parse("inkycap://open?notebox=N&file=a.typ&file=b.typ"),
            None
        );
    }

    #[test]
    fn rejects_paths_ports_and_credentials() {
        for url in [
            "inkycap://open/extra?notebox=N&file=a.typ",
            "inkycap://open:80?notebox=N&file=a.typ",
            "inkycap://user@open?notebox=N&file=a.typ",
        ] {
            assert_eq!(parse(url), None, "{url}");
        }
    }

    #[test]
    fn rejects_control_characters_and_oversized_values() {
        assert_eq!(parse("inkycap://search?notebox=N&query=a%0Ab"), None);
        let long = "a".repeat(MAX_QUERY_LEN + 1);
        assert_eq!(
            parse(&format!("inkycap://search?notebox=N&query={long}")),
            None
        );
        let huge = "a".repeat(MAX_URL_LEN);
        assert_eq!(
            parse(&format!("inkycap://search?notebox=N&query={huge}")),
            None
        );
    }
}
