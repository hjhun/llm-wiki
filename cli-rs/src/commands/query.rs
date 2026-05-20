//! `clio query` — ask the wiki a question via the webapp `/query` flow.

use anyhow::{bail, Result};
use clap::Args;
use console::style;

use crate::client::{ChatKind, ChatSendBody, Client};
use crate::config::Context;
use crate::stream;

#[derive(Debug, Args)]
pub struct QueryArgs {
    /// The question to ask. Joined with spaces if multiple words are given
    /// so quoting is optional.
    #[arg(required = true, value_name = "QUESTION", trailing_var_arg = true)]
    pub words: Vec<String>,

    /// Override the coding-agent CLI (codex/claude/gemini/cline).
    #[arg(long)]
    pub agent: Option<String>,

    /// Resume an existing chat session by path under sessions/.
    #[arg(long, value_name = "SESSION_PATH")]
    pub session: Option<String>,
}

pub async fn run(ctx: &Context, args: QueryArgs) -> Result<u8> {
    let question = args.words.join(" ");
    if question.trim().is_empty() {
        bail!("query must not be empty");
    }
    let message = format!("/query {question}");
    let client = Client::new(ctx)?;
    let body = ChatSendBody {
        message: &message,
        kind: ChatKind::Query,
        agent: args.agent.as_deref(),
        context: None,
        session_path: args.session.as_deref(),
    };
    eprintln!(
        "{} POST {}/api/chat/send (kind=query)",
        style("clio:").cyan().bold(),
        client.base_url()
    );
    let resp = client.post_chat_send(&body).await?;
    let stream = crate::client::body_stream(resp);
    let outcome = stream::consume(stream, std::io::stdout()).await?;
    Ok(outcome.exit_code.clamp(0, 127) as u8)
}
