//! End-to-end tests for local server lifecycle commands.
//!
//! These tests use fake `setup.sh` and `systemctl` binaries so they never
//! start a real webapp or touch the host service manager.

#![cfg(unix)]

use std::fs;
use std::os::unix::fs::PermissionsExt;
use std::path::{Path, PathBuf};

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
        r#"{"server":{"host":"127.0.0.1","port":7788},"auth":{"cliToken":"clio_test_token"}}"#,
    )
    .unwrap();
    dir
}

fn make_executable(path: &Path) {
    let mut perms = fs::metadata(path).unwrap().permissions();
    perms.set_mode(0o755);
    fs::set_permissions(path, perms).unwrap();
}

fn write_setup_recorder(root: &Path) -> PathBuf {
    let path = root.join("setup.sh");
    fs::write(
        &path,
        r#"#!/usr/bin/env bash
{
  printf 'call'
  for arg in "$@"; do
    printf ' %s' "$arg"
  done
  printf '\n'
} >> setup.calls
exit 0
"#,
    )
    .unwrap();
    make_executable(&path);
    path
}

fn fake_systemctl_cat_failure() -> (TempDir, std::ffi::OsString) {
    let fake_bin = tempfile::tempdir().expect("fake bin");
    let systemctl = fake_bin.path().join("systemctl");
    fs::write(
        &systemctl,
        r#"#!/usr/bin/env bash
if [ "$1" = "cat" ]; then
  exit 1
fi
exit 42
"#,
    )
    .unwrap();
    make_executable(&systemctl);

    let old_path = std::env::var_os("PATH").unwrap_or_default();
    let mut path = fake_bin.path().as_os_str().to_os_string();
    path.push(":");
    path.push(old_path);
    (fake_bin, path)
}

fn clio() -> Command {
    Command::cargo_bin("clio").expect("locate clio binary")
}

#[test]
fn start_falls_back_to_setup_when_systemd_is_disabled() {
    let project = make_project();
    write_setup_recorder(project.path());

    clio()
        .env("CLIO_HOME", project.path())
        .args(["start", "--no-systemd"])
        .assert()
        .success()
        .stdout(predicate::str::contains("setup.sh"));

    let calls = fs::read_to_string(project.path().join("setup.calls")).unwrap();
    assert_eq!(calls, "call --start --port 7788 --host 127.0.0.1\n");
}

#[test]
fn shutdown_falls_back_to_setup_when_no_service_unit_exists() {
    let project = make_project();
    write_setup_recorder(project.path());
    let (_fake_bin, path) = fake_systemctl_cat_failure();

    clio()
        .env("CLIO_HOME", project.path())
        .env("PATH", path)
        .args(["shutdown"])
        .assert()
        .success();

    let calls = fs::read_to_string(project.path().join("setup.calls")).unwrap();
    assert_eq!(calls, "call --shutdown --port 7788\n");
}

#[test]
fn restart_uses_shutdown_then_start_for_setup_fallback() {
    let project = make_project();
    write_setup_recorder(project.path());

    clio()
        .env("CLIO_HOME", project.path())
        .args(["restart", "--no-systemd"])
        .assert()
        .success();

    let calls = fs::read_to_string(project.path().join("setup.calls")).unwrap();
    assert_eq!(
        calls,
        concat!(
            "call --shutdown --port 7788\n",
            "call --start --port 7788 --host 127.0.0.1\n"
        )
    );
}

#[test]
fn restart_prefers_systemd_when_unit_is_available() {
    let project = make_project();
    write_setup_recorder(project.path());

    let fake_bin = tempfile::tempdir().expect("fake bin");
    let systemctl = fake_bin.path().join("systemctl");
    fs::write(
        &systemctl,
        r#"#!/usr/bin/env bash
if [ "$1" = "cat" ]; then
  exit 0
fi
{
  printf 'systemctl'
  for arg in "$@"; do
    printf ' %s' "$arg"
  done
  printf '\n'
} >> "$CLIO_TEST_SYSTEMCTL_CALLS"
exit 0
"#,
    )
    .unwrap();
    make_executable(&systemctl);

    let calls_path = project.path().join("systemctl.calls");
    let old_path = std::env::var_os("PATH").unwrap_or_default();
    let mut path = fake_bin.path().as_os_str().to_os_string();
    path.push(":");
    path.push(old_path);

    clio()
        .env("CLIO_HOME", project.path())
        .env("CLIO_TEST_SYSTEMCTL_CALLS", &calls_path)
        .env("PATH", path)
        .args(["restart"])
        .assert()
        .success()
        .stdout(predicate::str::contains("systemd"));

    let calls = fs::read_to_string(calls_path).unwrap();
    assert_eq!(calls, "systemctl restart clio-web.service\n");
    assert!(!project.path().join("setup.calls").exists());
}
