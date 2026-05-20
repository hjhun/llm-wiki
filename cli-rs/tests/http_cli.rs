//! End-to-end test for the HTTP-backed commands.
//!
//! Spins up an `httpmock` server, points the CLI at it via `--base-url`,
//! and verifies that `clio ingest` / `clio query` / `clio lint`:
//!
//!   1. send the right slash command + kind in the JSON body,
//!   2. forward `Authorization: Bearer …` with the configured token,
//!   3. stream NDJSON chunks to stdout in order, and
//!   4. exit non-zero when the server emits `{"type":"error", …}`.
//!
//! Keeping these tests behind `httpmock` avoids the heavy webapp dependency
//! while still pinning the contract the Rust client and the TypeScript
//! route share.

use std::fs;

use assert_cmd::Command;
use httpmock::{Method::POST, MockServer};
use predicates::prelude::*;
use serde_json::Value;
use tempfile::TempDir;

fn make_project() -> TempDir {
    let dir = tempfile::tempdir().expect("create tempdir");
    let root = dir.path();
    fs::write(root.join("llm-wiki.md"), "# fake clio project\n").unwrap();
    fs::create_dir_all(root.join("config")).unwrap();
    fs::write(
        root.join("config").join("local.json"),
        r#"{"auth":{"cliToken":"clio_test_token"}}"#,
    )
    .unwrap();
    fs::create_dir_all(root.join("raw")).unwrap();
    dir
}

fn clio() -> Command {
    Command::cargo_bin("clio").expect("locate clio binary")
}

fn ndjson_body(events: &[Value]) -> String {
    let mut out = String::new();
    for ev in events {
        out.push_str(&ev.to_string());
        out.push('\n');
    }
    out
}

#[test]
fn ingest_streams_done_event() {
    let project = make_project();
    let server = MockServer::start();
    let mock = server.mock(|when, then| {
        when.method(POST)
            .path("/api/chat/send")
            .header("authorization", "Bearer clio_test_token")
            .json_body_partial(r#"{"message":"/ingest raw/foo","kind":"ingest"}"#);
        then.status(200)
            .header("content-type", "application/x-ndjson")
            .body(ndjson_body(&[
                serde_json::json!({"type":"start","sessionPath":"sessions/2026/2026-05/test.md"}),
                serde_json::json!({"type":"chunk","stream":"stdout","text":"working\n"}),
                serde_json::json!({
                    "type":"done",
                    "sessionPath":"sessions/2026/2026-05/test.md",
                    "exitCode":0,
                    "assistant":{"content":"ingest complete"}
                }),
            ]));
    });

    clio()
        .env("CLIO_HOME", project.path())
        .env("CLIO_BASE_URL", server.base_url())
        .args(["ingest", "raw/foo"])
        .assert()
        .success()
        .stdout(predicate::str::contains("working"))
        .stdout(predicate::str::contains("ingest complete"));

    mock.assert();
}

#[test]
fn query_joins_words_and_streams() {
    let project = make_project();
    let server = MockServer::start();
    let mock = server.mock(|when, then| {
        when.method(POST)
            .path("/api/chat/send")
            .json_body_partial(r#"{"message":"/query what is foo","kind":"query"}"#);
        then.status(200)
            .header("content-type", "application/x-ndjson")
            .body(ndjson_body(&[
                serde_json::json!({"type":"start","sessionPath":"sessions/q.md"}),
                serde_json::json!({"type":"chunk","stream":"stdout","text":"answer here"}),
                serde_json::json!({"type":"done","exitCode":0}),
            ]));
    });

    clio()
        .env("CLIO_HOME", project.path())
        .env("CLIO_BASE_URL", server.base_url())
        .args(["query", "what", "is", "foo"])
        .assert()
        .success()
        .stdout(predicate::str::contains("answer here"));

    mock.assert();
}

#[test]
fn lint_with_fix_passes_flag() {
    let project = make_project();
    let server = MockServer::start();
    let mock = server.mock(|when, then| {
        when.method(POST)
            .path("/api/chat/send")
            .json_body_partial(r#"{"message":"/lint --fix","kind":"lint"}"#);
        then.status(200)
            .header("content-type", "application/x-ndjson")
            .body(ndjson_body(&[
                serde_json::json!({"type":"done","exitCode":0,"assistant":{"content":"clean"}}),
            ]));
    });

    clio()
        .env("CLIO_HOME", project.path())
        .env("CLIO_BASE_URL", server.base_url())
        .args(["lint", "--fix"])
        .assert()
        .success()
        .stdout(predicate::str::contains("clean"));

    mock.assert();
}

#[test]
fn error_event_propagates_failure() {
    let project = make_project();
    let server = MockServer::start();
    server.mock(|when, then| {
        when.method(POST).path("/api/chat/send");
        then.status(200)
            .header("content-type", "application/x-ndjson")
            .body(ndjson_body(&[
                serde_json::json!({"type":"start","sessionPath":"sessions/e.md"}),
                serde_json::json!({"type":"error","sessionPath":"sessions/e.md","error":"agent missing"}),
            ]));
    });

    clio()
        .env("CLIO_HOME", project.path())
        .env("CLIO_BASE_URL", server.base_url())
        .args(["ingest"])
        .assert()
        .failure()
        .stderr(predicate::str::contains("agent missing"));
}

#[test]
fn unauthorized_response_surfaces_friendly_hint() {
    let project = make_project();
    let server = MockServer::start();
    server.mock(|when, then| {
        when.method(POST).path("/api/chat/send");
        then.status(401)
            .header("content-type", "application/json")
            .body(r#"{"error":"unauthorized"}"#);
    });

    clio()
        .env("CLIO_HOME", project.path())
        .env("CLIO_BASE_URL", server.base_url())
        .args(["query", "hello"])
        .assert()
        .failure()
        .stderr(predicate::str::contains("CLIO_TOKEN missing or stale"));
}
