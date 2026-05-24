//! CLIO CLI entry point.
//!
//! Sub-commands are dispatched by `clap`. Every command resolves the active
//! CLIO project home (env `CLIO_HOME`, then walk-up from `cwd`, then
//! `~/.clio`) and reads `config/local.json` to discover the webapp port and the
//! `auth.cliToken` it sends in `Authorization: Bearer …` headers.

#![deny(rust_2018_idioms)]

use std::process::ExitCode;

use clap::{Parser, Subcommand};

mod client;
mod commands;
mod config;
mod paths;
mod stream;

#[derive(Debug, Parser)]
#[command(
    name = "clio",
    version,
    about = "Local CLI for CLIO LLM wiki",
    long_about = "Manage raw/ and drive ingest/query/lint against a running CLIO webapp."
)]
struct Cli {
    /// Override the CLIO project directory. Falls back to $CLIO_HOME, a
    /// walk-up search from the current directory, or ~/.clio.
    #[arg(long, global = true, env = "CLIO_HOME")]
    home: Option<std::path::PathBuf>,

    /// Override the webapp base URL. Default reads server.host:port from
    /// config/local.json and substitutes 0.0.0.0 with 127.0.0.1.
    #[arg(long, global = true, env = "CLIO_BASE_URL")]
    base_url: Option<String>,

    /// Override the bearer token. Default reads auth.cliToken from
    /// config/local.json.
    #[arg(long, global = true, env = "CLIO_TOKEN", hide_env_values = true)]
    token: Option<String>,

    #[command(subcommand)]
    cmd: Command,
}

#[derive(Debug, Subcommand)]
enum Command {
    /// Manage raw/ source material.
    #[command(subcommand)]
    Raw(commands::raw::RawCmd),

    /// Run a wiki-ingest pass on the configured coding-agent CLI.
    Ingest(commands::ingest::IngestArgs),

    /// Run wiki-ingest in loop mode until the progress state is drained.
    IngestLoop(commands::ingest::IngestLoopArgs),

    /// Ask a question and have the wiki answer it.
    Query(commands::query::QueryArgs),

    /// Run the wiki-lint health check.
    Lint(commands::lint::LintArgs),

    /// Show resolved project paths, webapp URL, and CLI token status.
    Status,
}

fn main() -> ExitCode {
    let cli = Cli::parse();

    let runtime = match tokio::runtime::Builder::new_multi_thread()
        .enable_all()
        .build()
    {
        Ok(rt) => rt,
        Err(err) => {
            eprintln!("clio: failed to start async runtime: {err}");
            return ExitCode::from(2);
        }
    };

    runtime.block_on(async move { run(cli).await })
}

async fn run(cli: Cli) -> ExitCode {
    let ctx = match config::Context::resolve(cli.home, cli.base_url, cli.token).await {
        Ok(ctx) => ctx,
        Err(err) => {
            eprintln!("clio: {err:#}");
            return ExitCode::from(2);
        }
    };

    let result = match cli.cmd {
        Command::Raw(cmd) => commands::raw::run(&ctx, cmd).await,
        Command::Ingest(args) => commands::ingest::run(&ctx, args).await,
        Command::IngestLoop(args) => commands::ingest::run_loop(&ctx, args).await,
        Command::Query(args) => commands::query::run(&ctx, args).await,
        Command::Lint(args) => commands::lint::run(&ctx, args).await,
        Command::Status => commands::status::run(&ctx).await,
    };

    match result {
        Ok(code) => ExitCode::from(code),
        Err(err) => {
            eprintln!("clio: {err:#}");
            ExitCode::from(2)
        }
    }
}
