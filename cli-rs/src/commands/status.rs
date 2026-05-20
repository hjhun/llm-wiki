//! `clio status` — show what the CLI resolved and whether the webapp
//! responds. Useful first stop when a command fails with "is the webapp
//! running?"

use std::time::Duration;

use anyhow::Result;
use console::style;
use reqwest::Client;

use crate::config::Context;

pub async fn run(ctx: &Context) -> Result<u8> {
    println!(
        "{} {}",
        style("project root:").bold(),
        ctx.project_root.display()
    );
    println!("{} {}", style("webapp base:").bold(), ctx.base_url);
    println!(
        "{} {}",
        style("cli token:").bold(),
        match ctx.token.as_deref() {
            Some(t) if t.len() > 10 => format!("present ({}…)", &t[..10]),
            Some(_) => "present".to_string(),
            None => style("missing").red().to_string(),
        }
    );

    let http = Client::builder().timeout(Duration::from_secs(5)).build()?;
    let ping_url = format!("{}/api/settings", ctx.base_url);
    let req = if let Some(token) = ctx.token.as_deref() {
        http.get(&ping_url).bearer_auth(token)
    } else {
        http.get(&ping_url)
    };
    match req.send().await {
        Ok(resp) => {
            let status = resp.status();
            let label = if status.is_success() {
                style("reachable").green().to_string()
            } else if status.as_u16() == 401 {
                style("reachable (auth failed)").yellow().to_string()
            } else {
                style(format!("HTTP {status}")).yellow().to_string()
            };
            println!("{} {}", style("webapp:").bold(), label);
        }
        Err(err) => {
            println!(
                "{} {} ({err})",
                style("webapp:").bold(),
                style("unreachable").red()
            );
        }
    }
    Ok(0)
}
