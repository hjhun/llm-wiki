//! `clio lint` — run the wiki-lint health check.

use anyhow::Result;
use clap::Args;
use console::style;

use crate::client::{ChatKind, ChatSendBody, Client};
use crate::config::Context;
use crate::stream;

#[derive(Debug, Args)]
pub struct LintArgs {
    /// Auto-apply fixable lint findings. Forwarded verbatim to the
    /// wiki-lint skill so behaviour matches the chat `/lint --fix` command.
    #[arg(long)]
    pub fix: bool,

    /// Override the coding-agent CLI (codex/claude/gemini/cline).
    #[arg(long)]
    pub agent: Option<String>,

    /// Resume an existing chat session by path under sessions/.
    #[arg(long, value_name = "SESSION_PATH")]
    pub session: Option<String>,
}

pub async fn run(ctx: &Context, args: LintArgs) -> Result<u8> {
    let message = if args.fix { "/lint --fix" } else { "/lint" };
    let client = Client::new(ctx)?;
    let body = ChatSendBody {
        message,
        kind: ChatKind::Lint,
        agent: args.agent.as_deref(),
        context: None,
        session_path: args.session.as_deref(),
    };
    eprintln!(
        "{} POST {}/api/chat/send (kind=lint)",
        style("clio:").cyan().bold(),
        client.base_url()
    );
    let resp = client.post_chat_send(&body).await?;
    let stream = crate::client::body_stream(resp);
    let outcome = stream::consume(stream, std::io::stdout()).await?;
    Ok(outcome.exit_code.clamp(0, 127) as u8)
}
