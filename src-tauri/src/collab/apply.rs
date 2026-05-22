//! Pure helpers for the import-apply step.
//!
//! The async orchestration (reading staged files, writing through
//! `NoteboxStorage`, merging clocks) lives in `commands/collab.rs`; this
//! module holds the parts that are pure and worth unit-testing on their
//! own — chiefly *where an accepted note is written*.
//!
//! Placement is decoupled from the sender's tree: a note's location is
//! purely local, so we never replicate the sender's folder structure.
//! [`place_incoming`] writes an edit to the receiver's *existing* copy
//! (located by `collabid`, wherever they keep it) and only falls back to a
//! receiver-chosen import folder for notes genuinely new to this machine.

/// Decide the notebox-relative path an accepted incoming note is written to.
///
/// Identity, not location, drives this: `existing_local_path` is the path
/// of the receiver's own copy of this note, found by matching the incoming
/// `collabid` against the local `collabid` property index.
///
/// - **Update in place.** When the receiver already has the note, the edit
///   is written to *their* current path — wherever they have organized it.
///   This is the fix for the latent duplicate bug: a note the receiver
///   moved is updated, not re-created at the sender's path.
/// - **New note → import folder.** When the note is new to this machine,
///   it lands under the receiver-controlled `import_folder` using the
///   incoming filename. Only here can a filename collide with a *different*
///   local note, so the birth-author suffix rule
///   ([`resolve_destination`]) applies. An empty `import_folder` places the
///   note at the notebox root.
pub fn place_incoming(
    existing_local_path: Option<&str>,
    incoming_path: &str,
    import_folder: &str,
    birth_author: &str,
    is_taken: &dyn Fn(&str) -> bool,
) -> String {
    if let Some(p) = existing_local_path {
        return p.to_string();
    }
    let filename = incoming_path.rsplit('/').next().unwrap_or(incoming_path);
    let folder = import_folder.trim_matches('/');
    let target = if folder.is_empty() {
        filename.to_string()
    } else {
        format!("{folder}/{filename}")
    };
    resolve_destination(&target, birth_author, is_taken)
}

/// Choose a destination notebox-relative path for an incoming note so it
/// never clobbers a *different* local note.
///
/// Two collaborators can create notes in the same second and thus land on
/// the same filename, yet they are distinct notes (distinct collabids).
/// When the desired path is already taken by a different note, the
/// incoming note's birth-author handle is appended to the file stem
/// (`20260521.typ` → `20260521-bob.typ`); a further clash appends a
/// counter. `is_taken` reports whether a candidate relpath is occupied by
/// some *other* note.
pub fn resolve_destination(desired: &str, birth_author: &str, is_taken: &dyn Fn(&str) -> bool) -> String {
    if !is_taken(desired) {
        return desired.to_string();
    }
    let suffixed = insert_stem_suffix(desired, birth_author);
    if !is_taken(&suffixed) {
        return suffixed;
    }
    let mut n = 2u32;
    loop {
        let candidate = insert_stem_suffix(desired, &format!("{birth_author}-{n}"));
        if !is_taken(&candidate) {
            return candidate;
        }
        n += 1;
    }
}

/// Insert `-<suffix>` before the file extension of a forward-slash
/// relpath, preserving the directory and extension.
fn insert_stem_suffix(relpath: &str, suffix: &str) -> String {
    let (dir, file) = match relpath.rfind('/') {
        Some(i) => (&relpath[..=i], &relpath[i + 1..]),
        None => ("", relpath),
    };
    // A leading dot (dotfile) is not an extension separator.
    let (stem, ext) = match file.rfind('.') {
        Some(i) if i > 0 => (&file[..i], &file[i..]),
        _ => (file, ""),
    };
    format!("{dir}{stem}-{suffix}{ext}")
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::collections::HashSet;

    fn taken(set: &HashSet<String>) -> impl Fn(&str) -> bool + '_ {
        move |p: &str| set.contains(p)
    }

    #[test]
    fn returns_desired_when_free() {
        let set = HashSet::new();
        assert_eq!(resolve_destination("notes/a.typ", "bob", &taken(&set)), "notes/a.typ");
    }

    #[test]
    fn appends_birth_author_on_collision() {
        let mut set = HashSet::new();
        set.insert("notes/20260521.typ".to_string());
        assert_eq!(
            resolve_destination("notes/20260521.typ", "bob", &taken(&set)),
            "notes/20260521-bob.typ"
        );
    }

    #[test]
    fn appends_counter_on_double_collision() {
        let mut set = HashSet::new();
        set.insert("notes/a.typ".to_string());
        set.insert("notes/a-bob.typ".to_string());
        assert_eq!(
            resolve_destination("notes/a.typ", "bob", &taken(&set)),
            "notes/a-bob-2.typ"
        );
    }

    #[test]
    fn handles_no_extension_and_root_level() {
        let mut set = HashSet::new();
        set.insert("README".to_string());
        assert_eq!(resolve_destination("README", "bob", &taken(&set)), "README-bob");
    }

    #[test]
    fn preserves_nested_directory() {
        let mut set = HashSet::new();
        set.insert("a/b/c.typ".to_string());
        assert_eq!(
            resolve_destination("a/b/c.typ", "alice", &taken(&set)),
            "a/b/c-alice.typ"
        );
    }

    // -- place_incoming: location is local, identity is the collabid --

    #[test]
    fn updates_in_place_at_receivers_path_ignoring_sender_path() {
        // The receiver keeps this note under their own structure. An edit
        // arrives stamped with the sender's path; it must update the
        // receiver's copy, never re-create at the sender's path. This is
        // the latent duplicate-bug regression guard.
        let set = HashSet::new();
        let dest = place_incoming(
            Some("my/own/place.typ"),
            "sender/elsewhere.typ",
            "Collaboration/paper",
            "bob",
            &taken(&set),
        );
        assert_eq!(dest, "my/own/place.typ");
    }

    #[test]
    fn new_note_lands_in_import_folder_by_filename() {
        // Brand-new note (no local copy): the sender's directory is
        // discarded; only the filename is reused, under the import folder.
        let set = HashSet::new();
        let dest = place_incoming(
            None,
            "sender/deep/tree/intro.typ",
            "Collaboration/paper",
            "bob",
            &taken(&set),
        );
        assert_eq!(dest, "Collaboration/paper/intro.typ");
    }

    #[test]
    fn new_note_suffixes_only_on_collision_with_a_different_note() {
        let mut set = HashSet::new();
        set.insert("Collaboration/paper/20260521.typ".to_string());
        let dest = place_incoming(
            None,
            "x/20260521.typ",
            "Collaboration/paper",
            "bob",
            &taken(&set),
        );
        assert_eq!(dest, "Collaboration/paper/20260521-bob.typ");
    }

    #[test]
    fn empty_import_folder_places_new_note_at_root() {
        let set = HashSet::new();
        let dest = place_incoming(None, "sender/intro.typ", "", "bob", &taken(&set));
        assert_eq!(dest, "intro.typ");
    }
}
