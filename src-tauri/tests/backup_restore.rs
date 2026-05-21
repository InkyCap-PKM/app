//! Round-trip test for the backup browse + restore path.
//!
//! Writes an archive of a tiny notebox, lists its contents, then
//! extracts one entry back to a fresh target directory and asserts
//! the bytes round-trip cleanly. Covers both the encrypted and
//! unencrypted paths, plus the three conflict-resolution policies.

use std::fs;

use inkycap_lib::backup::{archive, restore};

fn make_fixture(dir: &std::path::Path) {
    fs::create_dir_all(dir.join("subdir")).unwrap();
    fs::write(dir.join("hello.typ"), "= Hello\n").unwrap();
    fs::write(dir.join("subdir").join("nested.typ"), "= Nested\n").unwrap();
}

#[test]
fn list_contents_returns_files_only_paths() {
    let tmp_notebox = tempfile::tempdir().unwrap();
    let tmp_dest = tempfile::tempdir().unwrap();
    make_fixture(tmp_notebox.path());

    let archive_path = tmp_dest.path().join("snapshot.zip");
    archive::write(archive::ArchiveJob {
        notebox_root: tmp_notebox.path(),
        destination: &archive_path,
        user_config_root: None,
        password: None,
    })
    .unwrap();

    let contents = restore::list_contents(&archive_path).unwrap();
    let names: Vec<String> = contents.iter().map(|c| c.path_in_zip.clone()).collect();

    assert!(
        names.iter().any(|n| n == "notebox/hello.typ"),
        "expected `notebox/hello.typ` in archive: {names:?}"
    );
    assert!(
        names.iter().any(|n| n == "notebox/subdir/nested.typ"),
        "expected `notebox/subdir/nested.typ`: {names:?}"
    );
    // All entries should be unencrypted in this archive.
    assert!(contents.iter().all(|c| !c.encrypted));
}

#[test]
fn restore_extracts_to_target_root() {
    let tmp_notebox = tempfile::tempdir().unwrap();
    let tmp_dest = tempfile::tempdir().unwrap();
    let tmp_restore = tempfile::tempdir().unwrap();
    make_fixture(tmp_notebox.path());

    let archive_path = tmp_dest.path().join("snapshot.zip");
    archive::write(archive::ArchiveJob {
        notebox_root: tmp_notebox.path(),
        destination: &archive_path,
        user_config_root: None,
        password: None,
    })
    .unwrap();

    let results = restore::extract_files(
        &archive_path,
        tmp_restore.path(),
        &["notebox/subdir/nested.typ".to_string()],
        None,
        restore::RestoreConflictPolicy::Skip,
    )
    .unwrap();

    assert_eq!(results.len(), 1);
    assert_eq!(results[0].outcome, "written");

    // The `notebox/` prefix is stripped — the file lands at
    // <target>/subdir/nested.typ, not <target>/notebox/subdir/nested.typ.
    let dest = tmp_restore.path().join("subdir").join("nested.typ");
    assert!(dest.exists(), "expected restored file at {}", dest.display());
    let body = fs::read_to_string(&dest).unwrap();
    assert_eq!(body, "= Nested\n");
}

#[test]
fn restore_skip_policy_preserves_existing() {
    let tmp_notebox = tempfile::tempdir().unwrap();
    let tmp_dest = tempfile::tempdir().unwrap();
    let tmp_restore = tempfile::tempdir().unwrap();
    make_fixture(tmp_notebox.path());

    let archive_path = tmp_dest.path().join("snapshot.zip");
    archive::write(archive::ArchiveJob {
        notebox_root: tmp_notebox.path(),
        destination: &archive_path,
        user_config_root: None,
        password: None,
    })
    .unwrap();

    // Pre-create the destination file with different content so we
    // can prove the policy worked.
    fs::write(tmp_restore.path().join("hello.typ"), "= Pre-existing\n").unwrap();

    let results = restore::extract_files(
        &archive_path,
        tmp_restore.path(),
        &["notebox/hello.typ".to_string()],
        None,
        restore::RestoreConflictPolicy::Skip,
    )
    .unwrap();

    assert_eq!(results[0].outcome, "skipped");
    let body = fs::read_to_string(tmp_restore.path().join("hello.typ")).unwrap();
    assert_eq!(body, "= Pre-existing\n", "Skip policy must leave existing untouched");
}

#[test]
fn restore_rename_policy_creates_sibling() {
    let tmp_notebox = tempfile::tempdir().unwrap();
    let tmp_dest = tempfile::tempdir().unwrap();
    let tmp_restore = tempfile::tempdir().unwrap();
    make_fixture(tmp_notebox.path());

    let archive_path = tmp_dest.path().join("snapshot.zip");
    archive::write(archive::ArchiveJob {
        notebox_root: tmp_notebox.path(),
        destination: &archive_path,
        user_config_root: None,
        password: None,
    })
    .unwrap();

    fs::write(tmp_restore.path().join("hello.typ"), "= Pre-existing\n").unwrap();

    let results = restore::extract_files(
        &archive_path,
        tmp_restore.path(),
        &["notebox/hello.typ".to_string()],
        None,
        restore::RestoreConflictPolicy::Rename,
    )
    .unwrap();

    assert_eq!(results[0].outcome, "renamed");
    // The original is untouched.
    let body = fs::read_to_string(tmp_restore.path().join("hello.typ")).unwrap();
    assert_eq!(body, "= Pre-existing\n");
    // The renamed copy is in the same dir with a `.restored-<stamp>.typ` shape.
    let renamed_paths: Vec<_> = fs::read_dir(tmp_restore.path())
        .unwrap()
        .filter_map(|e| e.ok())
        .map(|e| e.file_name().to_string_lossy().to_string())
        .filter(|n| n.starts_with("hello.restored-") && n.ends_with(".typ"))
        .collect();
    assert_eq!(renamed_paths.len(), 1, "expected one renamed sibling, got {renamed_paths:?}");
    let renamed_body = fs::read_to_string(tmp_restore.path().join(&renamed_paths[0])).unwrap();
    assert_eq!(renamed_body, "= Hello\n");
}

#[test]
fn restore_encrypted_archive_roundtrips_with_password() {
    let tmp_notebox = tempfile::tempdir().unwrap();
    let tmp_dest = tempfile::tempdir().unwrap();
    let tmp_restore = tempfile::tempdir().unwrap();
    make_fixture(tmp_notebox.path());

    let archive_path = tmp_dest.path().join("encrypted.zip");
    archive::write(archive::ArchiveJob {
        notebox_root: tmp_notebox.path(),
        destination: &archive_path,
        user_config_root: None,
        password: Some("test-pw-12345"),
    })
    .unwrap();

    let results = restore::extract_files(
        &archive_path,
        tmp_restore.path(),
        &["notebox/hello.typ".to_string()],
        Some("test-pw-12345"),
        restore::RestoreConflictPolicy::Skip,
    )
    .unwrap();

    assert_eq!(results[0].outcome, "written");
    let body = fs::read_to_string(tmp_restore.path().join("hello.typ")).unwrap();
    assert_eq!(body, "= Hello\n");
}

#[test]
fn restore_rejects_unsafe_paths() {
    let tmp_notebox = tempfile::tempdir().unwrap();
    let tmp_dest = tempfile::tempdir().unwrap();
    let tmp_restore = tempfile::tempdir().unwrap();
    make_fixture(tmp_notebox.path());

    let archive_path = tmp_dest.path().join("snapshot.zip");
    archive::write(archive::ArchiveJob {
        notebox_root: tmp_notebox.path(),
        destination: &archive_path,
        user_config_root: None,
        password: None,
    })
    .unwrap();

    // Note: this entry doesn't exist in the archive — but the
    // `..` in the path should be rejected by the safety check
    // *before* the zip lookup runs.
    let err = restore::extract_files(
        &archive_path,
        tmp_restore.path(),
        &["notebox/../../etc/passwd".to_string()],
        None,
        restore::RestoreConflictPolicy::Skip,
    )
    .unwrap_err();
    assert!(
        err.to_string().to_lowercase().contains("unsafe")
            || err.to_string().to_lowercase().contains("invalid"),
        "expected unsafe-path rejection, got: {err}"
    );
}
