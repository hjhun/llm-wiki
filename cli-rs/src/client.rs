//! Thin HTTP client over the webapp REST surface.
//!
//! Owns the `reqwest::Client` and the bearer token. Every command goes
//! through `Client::post_chat_send`, which mirrors the request shape used
//! by the web UI:
//!
//! ```json
//! { "message": "/ingest path", "kind": "ingest", "agent": null }
//! ```
//!
//! The response is `application/x-ndjson` — one JSON event per line. We
//! return the raw byte stream and let `stream.rs` parse it incrementally so
//! progress lines surface as soon as the server flushes them.

use std::time::Duration;

use anyhow::{anyhow, Context as _, Result};
use bytes::Bytes;
use futures_util::Stream;
use reqwest::{header, Client as Http, Response, StatusCode};
use serde::Serialize;

use crate::config::Context;

/// HTTP client bound to a base URL + bearer token.
pub struct Client {
    http: Http,
    base_url: String,
    token: String,
}

impl Client {
    pub fn new(ctx: &Context) -> Result<Self> {
        let token = ctx.require_token()?.to_string();
        let http = Http::builder()
            // No global request timeout — ingest/query/lint streams can run
            // for tens of minutes per sub-chunk. The webapp enforces its own
            // per-kind cap from config.cli.timeouts.
            .pool_idle_timeout(Some(Duration::from_secs(60)))
            .build()
            .context("failed to build HTTP client")?;
        Ok(Self {
            http,
            base_url: ctx.base_url.trim_end_matches('/').to_string(),
            token,
        })
    }

    pub fn base_url(&self) -> &str {
        &self.base_url
    }

    /// POST `/api/chat/send`. Returns the streaming response on 2xx and a
    /// rich error otherwise so the caller can tell "webapp is down" from
    /// "your token is stale".
    pub async fn post_chat_send(&self, body: &ChatSendBody<'_>) -> Result<Response> {
        let url = format!("{}/api/chat/send", self.base_url);
        let resp = self
            .http
            .post(&url)
            .bearer_auth(&self.token)
            .header(header::ACCEPT, "application/x-ndjson")
            .json(body)
            .send()
            .await
            .with_context(|| format!("POST {url} failed (is the webapp running?)"))?;
        ensure_ok(resp).await
    }
}

#[derive(Debug, Serialize)]
pub struct ChatSendBody<'a> {
    pub message: &'a str,
    pub kind: ChatKind,
    /// `None` lets the webapp fall back to the configured default agent.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub agent: Option<&'a str>,
    /// `slim` keeps the prompt bounded; `full` re-injects the entire session
    /// history. The CLI defaults to `slim` to match the webapp default.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub context: Option<&'a str>,
    #[serde(rename = "sessionPath", skip_serializing_if = "Option::is_none")]
    pub session_path: Option<&'a str>,
}

#[derive(Debug, Clone, Copy, Serialize)]
#[serde(rename_all = "kebab-case")]
pub enum ChatKind {
    Ingest,
    IngestLoop,
    Query,
    Lint,
}

async fn ensure_ok(resp: Response) -> Result<Response> {
    if resp.status().is_success() {
        return Ok(resp);
    }
    let status = resp.status();
    let body = resp.text().await.unwrap_or_default();
    let hint = match status {
        StatusCode::UNAUTHORIZED => {
            " (CLIO_TOKEN missing or stale; check config/local.json -> auth.cliToken)"
        }
        StatusCode::NOT_FOUND => " (route missing; is the webapp build up to date?)",
        _ => "",
    };
    Err(anyhow!(
        "webapp returned {status}{hint}: {}",
        truncate(body.trim(), 400)
    ))
}

fn truncate(s: &str, max: usize) -> String {
    if s.chars().count() <= max {
        return s.to_string();
    }
    let mut out = String::new();
    for ch in s.chars().take(max) {
        out.push(ch);
    }
    out.push('…');
    out
}

/// Convert the raw response into a stream of byte chunks.
pub fn body_stream(resp: Response) -> impl Stream<Item = reqwest::Result<Bytes>> {
    resp.bytes_stream()
}
