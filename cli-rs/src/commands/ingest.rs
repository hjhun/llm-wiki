//! `clio ingest` / `clio ingest-loop` — drive `/ingest` via the webapp.
//!
//! The two sub-commands share an HTTP body shape; only the `kind` field and
//! the prompt prefix change. We deliberately keep the request body small —
//! the heavy lifting (slim prompt build, progress watching, lock file
//! handling) lives in the webapp so the CLI never drifts away from what
//! the chat UI does.

use anyhow::Result;
use clap::Args;
use console::style;

use crate::client::{ChatKind, ChatSendBody, Client};
use crate::config::Context;
use crate::stream;

#[derive(Debug, Args)]
pub struct IngestArgs {
    /// Optional path or hint passed to the wiki-ingest skill.
    /// `clio ingest raw/foo` runs as `/ingest raw/foo`.
    #[arg(value_name = "PATH")]
    pub target: Option<String>,

    /// Override the coding-agent CLI (codex/claude/gemini/cline).
    /// Default uses agent.default from config/local.json.
    #[arg(long)]
    pub agent: Option<String>,

    /// Resume an existing chat session by path under sessions/.
    #[arg(long, value_name = "SESSION_PATH")]
    pub session: Option<String>,
}

#[derive(Debug, Args)]
pub struct IngestLoopArgs {
    /// Optional path or hint passed to the wiki-ingest loop.
    /// `clio ingest-loop raw/foo` runs as `/ingest-loop raw/foo`.
    #[arg(value_name = "PATH")]
    pub target: Option<String>,

    /// Override the coding-agent CLI (codex/claude/gemini/cline).
    #[arg(long)]
    pub agent: Option<String>,

    /// Resume an existing chat session by path under sessions/.
    #[arg(long, value_name = "SESSION_PATH")]
    pub session: Option<String>,
}

pub async fn run(ctx: &Context, args: IngestArgs) -> Result<u8> {
    let client = Client::new(ctx)?;
    let message = match args.target.as_deref() {
        Some(target) if !target.is_empty() => format!("/ingest {target}"),
        _ => "/ingest".to_string(),
    };
    let body = ChatSendBody {
        message: &message,
        kind: ChatKind::Ingest,
        agent: args.agent.as_deref(),
        context: None,
        session_path: args.session.as_deref(),
    };
    dispatch(&client, &body).await
}

pub async fn run_loop(ctx: &Context, args: IngestLoopArgs) -> Result<u8> {
    let client = Client::new(ctx)?;
    let message = match args.target.as_deref() {
        Some(target) if !target.is_empty() => format!("/ingest-loop {target}"),
        _ => "/ingest-loop".to_string(),
    };
    let body = ChatSendBody {
        message: &message,
        kind: ChatKind::IngestLoop,
        agent: args.agent.as_deref(),
        context: None,
        session_path: args.session.as_deref(),
    };
    dispatch(&client, &body).await
}

async fn dispatch(client: &Client, body: &ChatSendBody<'_>) -> Result<u8> {
    eprintln!(
        "{} POST {}/api/chat/send (kind={:?})",
        style("clio:").cyan().bold(),
        client.base_url(),
        body.kind
    );
    let resp = client.post_chat_send(body).await?;
    let stream = crate::client::body_stream(resp);
    let outcome = stream::consume(stream, std::io::stdout()).await?;
    // Map the host coding-agent CLI exit code to our own. >127 collapses
    // to 127 so signal-style exits do not surprise shells.
    let mapped = outcome.exit_code.clamp(0, 127) as u8;
    Ok(mapped)
}
