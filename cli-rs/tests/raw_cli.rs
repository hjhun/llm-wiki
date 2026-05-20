//! Integration tests for `clio raw add|remove|list`.
//!
//! We spin up a minimal fake CLIO project in a temp dir (just enough for
//! `Context::resolve` to accept it: a top-level `llm-wiki.md` marker and a
//! `config/local.json` carrying the bearer token) and exercise the real
//! binary built by `cargo`. These tests do **not** require a webapp — the
//! raw subcommands operate entirely on the local filesystem.

use std::fs;

use assert_cmd::Command;
use predicates::prelude::*;
use tempfile::TempDir;

fn make_project() -> TempDir {
    let dir = tempfile::tempdir().expect("create tempdir");
    let root = dir.path();
    fs::write(root.join("llm-wiki.md"), "# fake clio project\n").unwrap();
    fs::create_dir_all(root.join("config")).unwrap();
    fs::write(
        root.join("config").join("local.json"),
        r#"{"auth":{"cliToken":"clio_test_token"},"server":{"host":"127.0.0.1","port":9999}}"#,
    )
    .unwrap();
    fs::create_dir_all(root.join("raw")).unwrap();
    dir
}

fn clio() -> Command {
    Command::cargo_bin("clio").expect("locate clio binary")
}

#[test]
fn raw_add_copies_file() {
    let project = make_project();
    let src = project.path().join("source.md");
    fs::write(&src, b"hello world").unwrap();

    clio()
        .env("CLIO_HOME", project.path())
        .args(["raw", "add", src.to_str().unwrap()])
        .assert()
        .success()
        .stdout(predicate::str::contains("added 1 new"));

    let copied = project.path().join("raw").join("source.md");
    assert!(copied.exists(), "expected raw/source.md to exist");
    assert_eq!(fs::read(&copied).unwrap(), b"hello world");
}

#[test]
fn raw_add_updates_and_backs_up_existing() {
    let project = make_project();
    let dest = project.path().join("raw").join("doc.md");
    fs::write(&dest, b"old version").unwrap();

    let src = project.path().join("doc.md");
    fs::write(&src, b"new version").unwrap();

    clio()
        .env("CLIO_HOME", project.path())
        .args(["raw", "add", src.to_str().unwrap()])
        .assert()
        .success()
        .stdout(predicate::str::contains("updated 1 existing"));

    assert_eq!(fs::read(&dest).unwrap(), b"new version");

    let trash_dir = project.path().join("raw").join(".trash");
    let entries: Vec<_> = fs::read_dir(&trash_dir)
        .unwrap()
        .map(|e| e.unwrap())
        .collect();
    assert_eq!(entries.len(), 1, "expected one backup in raw/.trash/");
    let name = entries[0].file_name().to_string_lossy().into_owned();
    assert!(name.ends_with("_doc.md"), "backup name: {name}");
    assert_eq!(fs::read(entries[0].path()).unwrap(), b"old version");
}

#[test]
fn raw_remove_moves_to_trash() {
    let project = make_project();
    let dest = project.path().join("raw").join("removable.md");
    fs::write(&dest, b"to be removed").unwrap();

    clio()
        .env("CLIO_HOME", project.path())
        .args(["raw", "remove", "removable.md"])
        .assert()
        .success()
        .stdout(predicate::str::contains("removed:"));

    assert!(!dest.exists(), "removable.md should be moved out of raw/");
    let trash_dir = project.path().join("raw").join(".trash");
    let count = fs::read_dir(&trash_dir).unwrap().count();
    assert_eq!(count, 1);
}

#[test]
fn raw_remove_rejects_path_traversal() {
    let project = make_project();
    clio()
        .env("CLIO_HOME", project.path())
        .args(["raw", "remove", "../../etc/passwd"])
        .assert()
        .failure()
        .stderr(predicate::str::contains("escapes workspace"));
}

#[test]
fn raw_add_dry_run_does_not_touch_filesystem() {
    let project = make_project();
    let src = project.path().join("doc.md");
    fs::write(&src, b"hi").unwrap();

    clio()
        .env("CLIO_HOME", project.path())
        .args(["raw", "add", "--dry-run", src.to_str().unwrap()])
        .assert()
        .success()
        .stdout(predicate::str::contains("would add 1 new"));

    assert!(
        !project.path().join("raw").join("doc.md").exists(),
        "dry-run must not copy"
    );
}

#[test]
fn raw_list_emits_files() {
    let project = make_project();
    fs::write(project.path().join("raw").join("a.md"), b"a").unwrap();
    fs::create_dir_all(project.path().join("raw").join("sub")).unwrap();
    fs::write(project.path().join("raw").join("sub").join("b.md"), b"b").unwrap();

    clio()
        .env("CLIO_HOME", project.path())
        .args(["raw", "list"])
        .assert()
        .success()
        .stdout(predicate::str::contains("raw/a.md"))
        .stdout(predicate::str::contains("raw/sub/b.md"));
}

#[test]
fn status_reports_missing_webapp() {
    let project = make_project();
    clio()
        .env("CLIO_HOME", project.path())
        .arg("status")
        .assert()
        .success()
        .stdout(predicate::str::contains("project root:"))
        .stdout(predicate::str::contains("cli token: present"));
}

#[test]
fn missing_project_root_surfaces_friendly_error() {
    let empty = tempfile::tempdir().unwrap();
    clio()
        .env("CLIO_HOME", empty.path())
        .arg("status")
        .assert()
        .failure()
        .stderr(predicate::str::contains(
            "does not look like a CLIO project",
        ));
}
