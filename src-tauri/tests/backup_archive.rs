//! End-to-end smoke test for the notebox backup archive writer.
//!
//! Exercises both the unencrypted and AES-256 paths against a temp
//! notebox tree, verifies the resulting zip is readable, that interior
//! paths use forward slashes (the zip-spec convention CLAUDE.md calls
//! out for cross-platform restore), and that the encrypted variant
//! refuses to extract without the password.

use std::fs;
use std::io::Read;

use inkycap_lib::backup::archive;

fn make_fixture(dir: &std::path::Path) {
    fs::create_dir_all(dir.join("subdir")).unwrap();
    fs::write(dir.join("note one.typ"), "= Note One\n").unwrap();
    fs::write(dir.join("subdir").join("nested.typ"), "= Nested\n").unwrap();
    fs::create_dir_all(dir.join(".git")).unwrap();
    fs::write(dir.join(".git").join("HEAD"), b"ref: refs/heads/main\n").unwrap();
    fs::write(dir.join(".DS_Store"), b"junk").unwrap();
}

#[test]
fn writes_plain_archive_with_forward_slashes() {
    let tmp_notebox = tempfile::tempdir().unwrap();
    let tmp_dest = tempfile::tempdir().unwrap();
    make_fixture(tmp_notebox.path());

    let dest = tmp_dest.path().join("snapshot.zip");
    let summary = archive::write(archive::ArchiveJob {
        notebox_root: tmp_notebox.path(),
        destination: &dest,
        user_config_root: None,
        password: None,
        cancel: std::sync::Arc::new(std::sync::atomic::AtomicBool::new(false)),
    })
    .unwrap();

    assert!(
        summary.file_count >= 2,
        "expected at least the two .typ files"
    );
    assert!(dest.exists(), "archive file should exist");

    let file = fs::File::open(&dest).unwrap();
    let mut zip = zip::ZipArchive::new(file).unwrap();

    let mut names: Vec<String> = (0..zip.len())
        .map(|i| zip.by_index(i).unwrap().name().to_string())
        .collect();
    names.sort();

    // Excludes hold.
    assert!(
        !names.iter().any(|n| n.contains(".git/")),
        ".git/ should be excluded but found in: {names:?}"
    );
    assert!(
        !names.iter().any(|n| n.ends_with(".DS_Store")),
        ".DS_Store should be excluded but found in: {names:?}"
    );

    // Forward slashes inside the archive, regardless of host OS.
    for n in &names {
        assert!(
            !n.contains('\\'),
            "interior path uses backslash, should be forward-only: {n}"
        );
    }

    // Notebox prefix is applied.
    assert!(
        names.iter().any(|n| n.starts_with("notebox/")),
        "entries should be under `notebox/` prefix: {names:?}"
    );

    // Content round-trips.
    let mut content = String::new();
    zip.by_name("notebox/note one.typ")
        .unwrap()
        .read_to_string(&mut content)
        .unwrap();
    assert_eq!(content, "= Note One\n");
}

#[test]
fn writes_encrypted_archive_refuses_extraction_without_password() {
    let tmp_notebox = tempfile::tempdir().unwrap();
    let tmp_dest = tempfile::tempdir().unwrap();
    make_fixture(tmp_notebox.path());

    let dest = tmp_dest.path().join("secret.zip");
    archive::write(archive::ArchiveJob {
        notebox_root: tmp_notebox.path(),
        destination: &dest,
        user_config_root: None,
        password: Some("hunter2-correct-horse-battery-staple"),
        cancel: std::sync::Arc::new(std::sync::atomic::AtomicBool::new(false)),
    })
    .unwrap();

    let file = fs::File::open(&dest).unwrap();
    let mut zip = zip::ZipArchive::new(file).unwrap();

    // The zip crate's `by_name` (no password) refuses to surface the
    // entry at all when AES encryption is engaged — surfacing
    // `UnsupportedArchive("Password required to decrypt file")` —
    // which is the strongest possible signal that encryption is on.
    // We don't actually need to attempt the read; the by_name failure
    // is the assertion.
    let err = match zip.by_name("notebox/note one.typ") {
        Ok(_) => panic!("expected by_name to fail on AES-encrypted entry without password"),
        Err(e) => e,
    };
    let msg = err.to_string().to_lowercase();
    assert!(
        msg.contains("password") || msg.contains("encrypted") || msg.contains("aes"),
        "expected an encryption-related error, got: {err}"
    );

    // Sanity-check the decrypt path works with the correct password.
    let mut entry = zip
        .by_name_decrypt(
            "notebox/note one.typ",
            b"hunter2-correct-horse-battery-staple",
        )
        .unwrap();
    let mut buf = String::new();
    entry.read_to_string(&mut buf).unwrap();
    assert_eq!(buf, "= Note One\n");
}

#[test]
fn refuses_destination_inside_notebox() {
    let tmp_notebox = tempfile::tempdir().unwrap();
    make_fixture(tmp_notebox.path());

    // Put the archive *inside* the notebox tree — should refuse.
    fs::create_dir_all(tmp_notebox.path().join("backups")).unwrap();
    let dest = tmp_notebox.path().join("backups").join("snapshot.zip");

    let result = archive::write(archive::ArchiveJob {
        notebox_root: tmp_notebox.path(),
        destination: &dest,
        user_config_root: None,
        password: None,
        cancel: std::sync::Arc::new(std::sync::atomic::AtomicBool::new(false)),
    });
    assert!(
        result.is_err(),
        "destination inside notebox should be refused"
    );
}
